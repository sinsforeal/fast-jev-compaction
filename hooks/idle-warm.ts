/**
 * 0.5.11: idle cache warm. Off unless the effective `idleWarmMinutes` > 0.
 * 0.5.12: the interval and cap are the per-tree values (window.json over the options), taken at each arm.
 * 0.5.18: the idle clock resets on every prompt, turn end and main-thread append; a new session id (clear)
 * drops every timer of the old id; a ping needs a full interval of real idle and the live id to match.
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
/** minutes/max are the per-tree values taken when the gap was armed (0.5.12). */
type Gap = { sid: string; timer?: Cancel; count: number; running: boolean; warming: boolean; minutes: number; max: number; epoch: number };

export type WarmState = {
  gaps: Map<string, Gap>;
  /** 0.5.18: the live main-thread session id, from the latest activity. A Gap under any other id is dead. */
  sid?: string;
  /** 0.5.18: Date.now() of the latest real main-thread activity (prompt, turn end, append). Warm pings do not count. */
  lastActive: number;
};

/** A timer may fire a little early; real idle within this much of the interval counts as the interval. */
const IDLE_SLACK_MS = 5_000;

/** Smallest prompt that still gets a reply. Fork has no maxTokens knob, so the text is the cap. */
export const WARM_PROMPT = 'Reply with the single word ok.';

/** 0.5.12: no global on/off. The interval and cap come from the effective per-tree config at each arm. */
export function createWarmState(): WarmState {
  return { gaps: new Map(), lastActive: 0 };
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
  if (!gap) { gap = { sid, count: 0, running: false, warming: false, minutes: 0, max: 0, epoch: 0 }; state.gaps.set(sid, gap); }
  return gap;
}

function cancelTimer(gap: Gap): void {
  const timer = gap.timer;
  gap.timer = undefined;
  try { timer?.cancel(); } catch { /* a timer that cannot be cancelled is skipped when it fires */ }
}

function armWarm($: WarmHost, state: WarmState, gap: Gap, ms: number = gap.minutes * 60_000): void {
  cancelTimer(gap);
  try {
    const mine: { handle?: Cancel } = {};
    const handle = $.clock.after(ms, () => {
      void fireWarm($, state, gap, mine).catch(() => { /* never throws out of the timer */ });
    });
    mine.handle = handle;
    gap.timer = handle;
  } catch { /* no clock: no warm */ }
}

/** Drops a Gap whose session is gone: no timer, no entry. */
function dropGap(state: WarmState, gap: Gap): void {
  cancelTimer(gap);
  if (state.gaps.get(gap.sid) === gap) state.gaps.delete(gap.sid);
}

async function fireWarm($: WarmHost, state: WarmState, gap: Gap, mine: { handle?: Cancel }): Promise<void> {
  if (gap.timer === undefined || gap.timer !== mine.handle) return; // cancelled or replaced
  gap.timer = undefined;
  if (gap.running || gap.warming) return; // a turn runs: its turn.complete re-arms
  // 0.5.18: a Gap armed under an id that is no longer the live session (a clear changed it) never pings.
  // The fork goes to the live conversation, so an old Gap would warm it with no idle behind the ping.
  if (state.sid !== undefined && state.sid !== gap.sid) { dropGap(state, gap); return; }
  try {
    const live = await $.session.id();
    if (typeof live === 'string' && live.length > 0 && live !== gap.sid) { dropGap(state, gap); return; }
  } catch { /* an unreadable id does not decide */ }
  if (gap.running || gap.warming || gap.timer !== undefined) return; // a turn or a new arm came during the id read
  // 0.5.18: ping only after the interval of real idle. Activity that never reached prompt.submit or
  // turn.complete (a delivery-started turn, tool results) moved lastActive; wait out the remainder.
  const need = gap.minutes * 60_000;
  const idle = Date.now() - state.lastActive;
  if (idle < need - IDLE_SLACK_MS) { armWarm($, state, gap, Math.max(1_000, need - idle)); return; }
  gap.warming = true;
  const n = gap.count + 1;
  const after = n * gap.minutes;
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
    if (n < gap.max) armWarm($, state, gap);
  } catch {
    gap.count = n;
    try { await warmLog($, `idle warm ${n} failed after ${after} min: fork threw; warming stops for this gap`); } catch { /* swallowed */ }
  } finally {
    gap.warming = false;
  }
}

/**
 * 0.5.18: real activity on the live main session. A different id than the last one means the session
 * was cleared or replaced: every Gap of the old id is dead and loses its timer here, so an old timer
 * can never fire into the new conversation. `real: false` (a warm is in flight) leaves lastActive alone.
 */
function noteActivity(state: WarmState, sid: string, real: boolean): void {
  if (state.sid !== undefined && state.sid !== sid) {
    for (const gap of [...state.gaps.values()]) if (gap.sid !== sid) dropGap(state, gap);
  }
  state.sid = sid;
  if (real) state.lastActive = Date.now();
}

/** Main-thread activity that is neither a prompt nor a turn end (an append). Resets the idle clock. */
export function warmTouch(state: WarmState, sid: string): void {
  try {
    if (!sid) return;
    const gap = state.gaps.get(sid);
    noteActivity(state, sid, !(gap?.warming && !gap.running));
  } catch { /* never throws */ }
}

/** The epoch of the session's gap: warmSubmit moves it. Read before an await, hand to warmIdle. */
export function warmEpoch(state: WarmState, sid: string): number {
  try { return gapFor(state, sid).epoch; } catch { return 0; }
}

/** A prompt was submitted: a turn is about to run. Cancels the timer and starts a new gap. */
export function warmSubmit(state: WarmState, sid: string): void {
  try {
    noteActivity(state, sid, true);
    const gap = gapFor(state, sid);
    gap.running = true;
    gap.count = 0;
    gap.epoch += 1;
    cancelTimer(gap);
  } catch { /* never throws */ }
}

/**
 * A main-thread turn finished (or a submission was dropped): the idle gap starts now.
 * `epoch` is warmEpoch() read before the caller's awaits; a prompt submitted since then owns the next arm.
 */
export function warmIdle($: WarmHost, state: WarmState, sid: string, minutes: number, max: number, epoch?: number): void {
  try {
    const gap = gapFor(state, sid);
    // During a warm, a turn.complete with no prompt before it is the fork's own: ignore it.
    if (gap.warming && !gap.running) return;
    if (epoch !== undefined && gap.epoch !== epoch) return; // a prompt came in while the caller waited
    noteActivity(state, sid, true);
    gap.running = false;
    gap.count = 0;
    gap.minutes = minutes;
    gap.max = max;
    // 0 = off for this tree (also when the option is on): no timer.
    if (!(minutes > 0)) { cancelTimer(gap); return; }
    armWarm($, state, gap);
  } catch { /* never throws */ }
}
