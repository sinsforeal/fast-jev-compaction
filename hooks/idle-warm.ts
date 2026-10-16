/**
 * 0.5.11: idle cache warm. Off unless `idleWarmMinutes` > 0.
 *
 * The main conversation runs a one-hour prompt cache. A gap past it makes the next turn
 * rewrite the whole context at the write price. After each main-thread turn.complete this
 * arms one `$.clock.after` timer per session. When it fires and the session is idle it sends
 * one minimal `$.model.fork` (the fork reads the main prefix, which resets the TTL), logs the
 * usage, and re-arms, at most `idleWarmMax` times per gap. Never submits a prompt, never
 * warms while a turn runs, never throws out of the timer.
 *
 * Host loader contract: `$` goes only to top-level functions, so everything here is a
 * module-level function that takes the state as an argument, not a closure factory.
 */

export type WarmUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** The slice of the host this needs; the real `$` satisfies it. */
export type WarmHost = {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
  session: { id: () => Promise<string> };
  clock: { after: (ms: number, fn: () => void) => { cancel: () => void } };
  model: { fork: (request: { prompt: string }) => Promise<{ text: string; usage: WarmUsage } | null> };
};

type Cancel = { cancel: () => void };
type Gap = { timer?: Cancel; count: number; running: boolean; warming: boolean };

export type WarmState = {
  enabled: boolean;
  minutes: number;
  max: number;
  gaps: Map<string, Gap>;
};

/** Smallest prompt that still gets a reply. Fork has no maxTokens knob, so the text is the cap. */
export const WARM_PROMPT = 'Reply with the single word ok.';

export function createWarmState(minutes: number, max: number): WarmState {
  return { enabled: minutes > 0, minutes, max, gaps: new Map() };
}

const LOG_FILE = '.claude/fast-jev-compaction.log';
const LOG_KEEP_CHARS = 512_000;

/** Same disk log and line shape as fast-jev.ts (`<iso> [sid8] text`). `$` cannot be stored, so the
 * timer's own `$` writes the line. Never throws. */
async function warmLog($: WarmHost, text: string): Promise<void> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
    if (!home) return;
    let line = text;
    try { const id = await $.session.id(); if (typeof id === 'string' && id.length > 0) line = `[${id.slice(0, 8)}] ${text}`; } catch { /* untagged */ }
    const path = `${home.replace(/[\\/]+$/, '')}/${LOG_FILE}`;
    let prior = '';
    try { if (await $.fs.exists(path)) prior = await $.fs.read(path); } catch { prior = ''; }
    if (prior.length > LOG_KEEP_CHARS) prior = prior.slice(prior.length - LOG_KEEP_CHARS / 2);
    await $.fs.write(path, `${prior}${new Date().toISOString()} ${line}\n`);
  } catch { /* a log that cannot be written changes nothing */ }
}

function gapFor(state: WarmState, sid: string): Gap {
  let gap = state.gaps.get(sid);
  if (!gap) { gap = { count: 0, running: false, warming: false }; state.gaps.set(sid, gap); }
  return gap;
}

function cancelTimer(gap: Gap): void {
  const timer = gap.timer;
  gap.timer = undefined;
  try { timer?.cancel(); } catch { /* a timer that cannot be cancelled is skipped when it fires */ }
}

function armWarm($: WarmHost, state: WarmState, gap: Gap): void {
  cancelTimer(gap);
  try {
    const mine: { handle?: Cancel } = {};
    const handle = $.clock.after(state.minutes * 60_000, () => {
      void fireWarm($, state, gap, mine).catch(() => { /* never throws out of the timer */ });
    });
    mine.handle = handle;
    gap.timer = handle;
  } catch { /* no clock: no warm */ }
}

async function fireWarm($: WarmHost, state: WarmState, gap: Gap, mine: { handle?: Cancel }): Promise<void> {
  if (gap.timer === undefined || gap.timer !== mine.handle) return; // cancelled or replaced
  gap.timer = undefined;
  if (gap.running || gap.warming) return; // a turn runs: its turn.complete re-arms
  gap.warming = true;
  const n = gap.count + 1;
  const after = n * state.minutes;
  try {
    const result = await $.model.fork({ prompt: WARM_PROMPT });
    if (gap.running || gap.timer !== undefined) return; // a prompt came meanwhile: its turn owns the next arm
    gap.count = n;
    if (result === null) {
      await warmLog($, `idle warm ${n} failed after ${after} min: fork returned null (cold snapshot or API error); warming stops for this gap`);
      return;
    }
    const u = result.usage;
    await warmLog($, `idle warm ${n} after ${after} min: cache_read ${u.cache_read_input_tokens}, cache_write ${u.cache_creation_input_tokens}, out ${u.output_tokens}`);
    if (n < state.max) armWarm($, state, gap);
  } catch {
    gap.count = n;
    try { await warmLog($, `idle warm ${n} failed after ${after} min: fork threw; warming stops for this gap`); } catch { /* swallowed */ }
  } finally {
    gap.warming = false;
  }
}

/** A prompt was submitted: a turn is about to run. Cancels the timer and starts a new gap. */
export function warmSubmit(state: WarmState, sid: string): void {
  if (!state.enabled) return;
  try {
    const gap = gapFor(state, sid);
    gap.running = true;
    gap.count = 0;
    cancelTimer(gap);
  } catch { /* never throws */ }
}

/** A main-thread turn finished (or a submission was dropped): the idle gap starts now. */
export function warmIdle($: WarmHost, state: WarmState, sid: string): void {
  if (!state.enabled) return;
  try {
    const gap = gapFor(state, sid);
    // During a warm, a turn.complete with no prompt before it is the fork's own: ignore it.
    if (gap.warming && !gap.running) return;
    gap.running = false;
    gap.count = 0;
    armWarm($, state, gap);
  } catch { /* never throws */ }
}
