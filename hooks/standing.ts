/**
 * 0.5.19: standing handover. A standing tree (window.json `standing.enabled`) keeps `<handoffDir>/<sid>/standing.md`
 * fresh and, after a long idle, clears the session in-process before the prompt cache goes cold, so the next
 * prompt starts a small fresh session that reads the file instead of rewriting the whole old context.
 *
 * Driven by the idle-warm timer (hooks/idle-warm.ts). At (60 - coldMarginMinutes) of real idle, with context at or
 * above minTokens: User spoke inside userQuietMinutes -> warm ping and look again; else standing.md not fresh -> one
 * `$.model.fork` writes it (format-checked, old file kept as standing.prev.md); fresh and complete, no turn, no
 * handoff order -> `/clear`, no prompt submitted. The next prompt of any origin in the new session carries a
 * STANDING RESUME context line.
 *
 * Host loader contract: `$` goes only to top-level functions; state is passed in, never closed over.
 */

import { carryColor, resolveColor, transcriptPath, type AgentColorRecord } from './color-carry.js';
import { consoleClear, isStoppedRefusal, onWindows } from './console-clear.js';
import { checkLatest, clearAvailable, handoffBlocking, sessionFile, waitForNewId, type HandoffHost } from './handoff.js';

export const CACHE_TTL_MINUTES = 60;
const MIN = 60_000;
/** The quiet rule and the idle checks tolerate a timer that fires a little early. */
const SLACK_MS = 5_000;
const MAX_WRITE_TRIES = 2;
const MAX_CLEAR_FAILS = 3;

export type StandingOptions = { minTokens: number; userQuietMinutes: number; coldMarginMinutes: number };

export const STANDING_DEFAULTS: StandingOptions = { minTokens: 150_000, userQuietMinutes: 60, coldMarginMinutes: 5 };

/**
 * `window.json` -> `standing`. undefined = absent. A string = the reason it is rejected (the file's other keys
 * stay in force). `{enabled: false}` parses to `null`: standing off, behaviour exactly as 0.5.18.
 */
export function parseStandingOptions(raw: unknown): StandingOptions | null | string | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'standing is not an object';
  const rec = raw as Record<string, unknown>;
  if (rec.enabled !== true && rec.enabled !== false) return 'standing.enabled is not true or false';
  if (rec.enabled === false) return null;
  const out = { ...STANDING_DEFAULTS };
  for (const key of ['minTokens', 'userQuietMinutes', 'coldMarginMinutes'] as const) {
    if (rec[key] === undefined) continue;
    const v = rec[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return `standing.${key} is not a number`;
    if (v < 0) return `standing.${key} ${v} is negative`;
    out[key] = v;
  }
  if (!(out.minTokens > 0)) return 'standing.minTokens is not positive';
  if (out.coldMarginMinutes >= CACHE_TTL_MINUTES) return `standing.coldMarginMinutes ${out.coldMarginMinutes} is not under ${CACHE_TTL_MINUTES}`;
  return out;
}

/** What the idle timer needs for one gap; pure data plus callbacks that never hold `$`. */
export type StandingArm = {
  minTokens: number;
  userQuietMs: number;
  /** (cache TTL - coldMarginMinutes) in ms: the first check, and the longest wait between checks. */
  coldBoundaryMs: number;
  /** The resolved handoff dir (`<tree>/var/handoffs`). */
  dir: string;
  /** After a clear changed the id: the new id takes the old id's handoff root. */
  onIdChanged?: (previous: string, id: string) => void;
};

export function makeStandingArm(options: StandingOptions, dir: string, onIdChanged?: (previous: string, id: string) => void): StandingArm {
  return {
    minTokens: options.minTokens,
    userQuietMs: options.userQuietMinutes * MIN,
    coldBoundaryMs: Math.max(MIN, (CACHE_TTL_MINUTES - options.coldMarginMinutes) * MIN),
    dir, onIdChanged,
  };
}

/** Per-gap bookkeeping, kept on the Gap. */
export type StandingGap = { tries: number; clearFails: number };

/** Per plugin registration. */
export type StandingState = {
  /** sid -> ms of the User's last message in that session. */
  lastUser: Map<string, number>;
  /** When the plugin loaded: the User-quiet fallback when a session has no record (a restart lost it). */
  loadedAt: number;
  /** new sid -> absolute path of the old session's standing.md, until the next prompt carries it. */
  resume: Map<string, string>;
  /** Sessions whose persisted resume record was already looked up. */
  looked: Set<string>;
};

export function createStandingState(): StandingState {
  return { lastUser: new Map(), loadedAt: Date.now(), resume: new Map(), looked: new Set() };
}

// ---- User-quiet ----------------------------------------------------------------------------------------------

const FEED_WRAP = /^\s*<channel\s+source="(?:feed|pick-assist)"/i;

/**
 * True for the User's own message: a typed or queued prompt (`composer`), a Remote Control prompt (`bridge`), and the
 * feed / pick-assist channel records. Peer channel, heartbeat, task notification, schedule, SDK and the plugin's
 * own prompts are not. A channel the engine could not attest arrives `unclassified`; its wrapper text decides.
 */
/** The first-turn prompt meta's restart_windows.py types into a relaunched window; it is not the User (0.5.21). */
const RESTART_PROMPT = /^\s*Window restarted by Ryan v2\b/;

export function isUserPrompt(origin: unknown, text: string | undefined): boolean {
  const kind = (origin as { kind?: unknown } | undefined)?.kind;
  if (RESTART_PROMPT.test(text ?? '')) return false;
  if (kind === 'composer' || kind === 'bridge') return true;
  if (kind === 'channel') {
    const server = String((origin as { server?: unknown }).server ?? '');
    return /^(feed|pick-assist)$/i.test(server) || FEED_WRAP.test(text ?? '');
  }
  if (kind === 'unclassified') return FEED_WRAP.test(text ?? '');
  return false;
}

/** Called from prompt.submit. In memory only; the arm persists it. Never throws. */
export function standingNoteUser(state: StandingState, sid: string, origin: unknown, text: string | undefined): void {
  try { if (sid && isUserPrompt(origin, text)) state.lastUser.set(sid, Date.now()); } catch { /* never throws */ }
}

const userKey = (sid: string): string => `standing:${sid}`;

type StoreHost = { store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> } };

/** Persists the session's last User time (plugin state), so a reload keeps it. Never throws. */
export async function standingPersistUser($: StoreHost, state: StandingState, sid: string): Promise<void> {
  try {
    const at = state.lastUser.get(sid);
    if (at !== undefined) await $.store.set(userKey(sid), { lastUserAt: at });
  } catch { /* the in-memory time still counts */ }
}

async function lastUserAt($: StoreHost, state: StandingState, sid: string): Promise<number> {
  const mem = state.lastUser.get(sid);
  if (mem !== undefined) return mem;
  try {
    const rec = await $.store.get(userKey(sid)) as { lastUserAt?: unknown } | undefined;
    if (rec && typeof rec.lastUserAt === 'number' && Number.isFinite(rec.lastUserAt)) { state.lastUser.set(sid, rec.lastUserAt); return rec.lastUserAt; }
  } catch { /* fall through */ }
  return state.loadedAt;
}

// ---- The file ------------------------------------------------------------------------------------------------

const SECTIONS: readonly (readonly [string, RegExp])[] = [
  ['Unanswered questions from the User', /^unanswered questions/i],
  ['Running now', /^running now/i],
  ['Tracker issues open', /^tracker issues/i],
  ['Git', /^git\b/i],
  ['State to know', /^state to know/i],
  ['Next steps', /^next steps/i],
];

const lineHead = (line: string): string => line.replace(/^\s*(?:#{1,6}\s*|\*{1,2}\s*|\d+[.)]\s*|[-*]\s+)*/, '');

export type StandingCheck = { ok: true } | { ok: false; reason: string };

/** Header `session: <sid>` and `standing: <time>` in the first 10 lines, every section, last line COMPLETE. */
export function validateStanding(text: string, sid: string): StandingCheck {
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, 10);
  const named = head.map(l => /^\W*session\W*:\s*`?([A-Za-z0-9_-]+)/i.exec(l)).find(m => m !== null);
  if (!named) return { ok: false, reason: 'no "session: <sid>" header line' };
  if (named[1] !== sid) return { ok: false, reason: `header names session ${named[1]!.slice(0, 8)}, not this one` };
  if (!head.some(l => /^\W*standing\W*:\s*\S/i.test(l))) return { ok: false, reason: 'no "standing: <time>" header line' };
  const heads = lines.map(lineHead);
  for (const [name, re] of SECTIONS) {
    if (!heads.some(h => re.test(h))) return { ok: false, reason: `section "${name}" is missing` };
  }
  const last = [...lines].reverse().find(l => l.trim().length > 0);
  if (last?.trim() !== 'COMPLETE') return { ok: false, reason: 'last line is not COMPLETE' };
  return { ok: true };
}

/** A reply that came back wrapped in one code fence loses the fence. */
export function cleanReply(text: string): string {
  let t = text.trim();
  const fence = /^```[A-Za-z]*\r?\n([\s\S]*?)\r?\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  return t;
}

const pad = (n: number): string => String(n).padStart(2, '0');
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The fixed prompt of the backstop fork. */
export function standingPrompt(sid: string): string {
  return [
    'STANDING HANDOVER. The session is about to sit idle and may be restarted from a fresh, empty context that reads only your answer.',
    'Reply with ONLY the full text of the handover file: no preface, no code fence, no tool use.',
    `Line 1 must be exactly: session: ${sid}`,
    `Line 2 must be exactly: standing: ${localStamp(new Date())}`,
    'Then these sections as headings, in this order:',
    '1. Unanswered questions from the User (his words, newest last; "none" if none)',
    '2. Running now (agents with ids, bgjobs with ids, tickets; "none" if none)',
    '3. Tracker issues open (ids, owner, trigger)',
    '4. Git (SHA per tree, branches, unpushed work)',
    '5. State to know (decisions, rulings, traps, paths the next turn needs)',
    '6. Next steps (ordered, concrete)',
    'Be specific: ids, SHAs, paths, exact commands. Leave out anything a fresh session can read from the repo.',
    'The last line of the reply must be exactly: COMPLETE',
  ].join('\n');
}

type FsHost = Pick<HandoffHost, 'fs'>;

/** Fresh = written after the last real main-thread activity, names this session, complete, and in format. */
export async function checkStanding($: FsHost, path: string, sid: string, lastActive: number): Promise<StandingCheck> {
  const base = await checkLatest($, path, sid, lastActive);
  if (!base.ok) return base;
  try {
    return validateStanding(await $.fs.read(path), sid);
  } catch { return { ok: false, reason: 'unreadable' }; }
}

// ---- Resume context ------------------------------------------------------------------------------------------

export const resumeLine = (path: string): string => `STANDING RESUME: read ${path} first, then answer the prompt.`;

/** The context to attach to a prompt in `sid`, if a standing clear made this session. Never throws. */
export async function standingResumeContext($: StoreHost, state: StandingState, sid: string): Promise<string | undefined> {
  try {
    const mem = state.resume.get(sid);
    if (mem) return resumeLine(mem);
    if (state.looked.has(sid)) return undefined;
    state.looked.add(sid);
    const rec = await $.store.get(`standing_resume:${sid}`) as { path?: unknown } | undefined;
    if (rec && typeof rec.path === 'string' && rec.path) { state.resume.set(sid, rec.path); return resumeLine(rec.path); }
  } catch { /* no store, no resume line */ }
  return undefined;
}

/** The prompt entered with the context: the line is spent. */
export async function standingResumeDone($: StoreHost, state: StandingState, sid: string): Promise<void> {
  state.resume.delete(sid);
  state.looked.add(sid);
  // Overwrite, never `$.store.delete?.(...)`: the host loader refuses a $ member read as a value (0.5.19 failed to load, 10-29).
  try { await $.store.set(`standing_resume:${sid}`, {}); } catch { /* a stale record only repeats a harmless line */ }
}

// ---- The timer step ------------------------------------------------------------------------------------------

export type StandingHost = HandoffHost & {
  env: { get: (name: string) => Promise<string | undefined> };
  session: { id: () => Promise<string>; cwd: () => Promise<string>; usage: () => Promise<{ context: { tokens?: number } }> };
  model: { fork: (request: { prompt: string }) => Promise<{ text: string; usage: { output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } } | null> };
};

/** What the timer does next. `ping`: warm ping, then check again after `delayMs`. `rearm`: no ping, check after `delayMs`. */
export type StandingStep =
  | { kind: 'stop' }
  | { kind: 'cleared' }
  | { kind: 'ping'; delayMs: number }
  | { kind: 'rearm'; delayMs: number };

/** Read again after every await: the idle clock, the running flag. */
export type LiveView = () => { running: boolean; lastActive: number };

const minutes = (ms: number): number => Math.round(ms / MIN);

export async function standingStep(
  $: StandingHost, state: StandingState, st: StandingGap, arm: StandingArm, sid: string,
  live: LiveView, log: (text: string) => Promise<void>,
): Promise<StandingStep> {
  const cold = arm.coldBoundaryMs;
  let tokens: number | undefined;
  try { tokens = (await $.session.usage()).context.tokens; } catch { tokens = undefined; }
  if (tokens === undefined || !(tokens >= arm.minTokens)) {
    await log(`standing: skip, context ${tokens ?? 'unknown'} is under minTokens ${arm.minTokens}; no write, no clear, no ping`);
    return { kind: 'stop' };
  }
  const since = Date.now() - await lastUserAt($, state, sid);
  if (since < arm.userQuietMs - SLACK_MS) {
    const delayMs = Math.min(cold, Math.max(MIN, arm.userQuietMs - since));
    await log(`standing: skip, the User spoke ${minutes(since)} min ago (quiet needs ${minutes(arm.userQuietMs)}); warm ping, next check in ${minutes(delayMs)} min`);
    return { kind: 'ping', delayMs };
  }
  const path = sessionFile(arm.dir, sid, 'standing.md');
  const startActive = live().lastActive;
  let check = await checkStanding($, path, sid, startActive);
  if (!check.ok) {
    if (st.tries >= MAX_WRITE_TRIES) {
      await log(`standing: skip, ${path} is ${check.reason} and ${MAX_WRITE_TRIES} writes already failed in this gap; warm ping`);
      return { kind: 'ping', delayMs: cold };
    }
    st.tries += 1;
    await log(`standing: ${path} is ${check.reason}; asking the session for the handover (fork ${st.tries})`);
    const wrote = await writeStanding($, sid, path, sessionFile(arm.dir, sid, 'standing.prev.md'), log);
    if (wrote === 'cold' || wrote === 'threw') return { kind: 'stop' };
    if (wrote === 'invalid') return { kind: 'rearm', delayMs: cold };
    if (live().running || live().lastActive !== startActive) {
      await log('standing: a prompt came while the handover was written; no clear');
      return { kind: 'stop' };
    }
    check = await checkStanding($, path, sid, startActive);
    if (!check.ok) {
      await log(`standing: skip, ${path} did not verify after the write (${check.reason}); old file stays`);
      return { kind: 'rearm', delayMs: cold };
    }
  }
  const view = live();
  if (view.running || view.lastActive !== startActive) { await log('standing: skip, a turn started; no clear'); return { kind: 'stop' }; }
  const blocked = await handoffBlocking($, sid);
  if (blocked) {
    await log(`standing: skip clear, ${blocked}; warm ping`);
    return { kind: 'ping', delayMs: cold };
  }
  if (!(await clearAvailable($))) {
    await log('standing: skip clear, the host lists no runnable "clear" command; warm ping');
    return { kind: 'ping', delayMs: cold };
  }
  const done = await standingClear($, state, arm, sid, path, tokens, live, startActive, log);
  if (done === 'cleared') return { kind: 'cleared' };
  if (done === 'aborted') return { kind: 'stop' };
  st.clearFails += 1;
  if (st.clearFails >= MAX_CLEAR_FAILS) { await log(`standing: clear failed ${st.clearFails} times in this gap; giving up until the next turn`); return { kind: 'stop' }; }
  return { kind: 'ping', delayMs: cold };
}

async function writeStanding($: StandingHost, sid: string, path: string, prevPath: string, log: (text: string) => Promise<void>): Promise<'ok' | 'invalid' | 'cold' | 'threw'> {
  let result: Awaited<ReturnType<StandingHost['model']['fork']>>;
  try { result = await $.model.fork({ prompt: standingPrompt(sid) }); }
  catch { await log('standing: write failed, fork threw; old file kept'); return 'threw'; }
  if (result === null) { await log('standing: write failed, fork returned null (cold snapshot or API error); old file kept'); return 'cold'; }
  const u = result.usage;
  const text = cleanReply(result.text);
  const verdict = validateStanding(text, sid);
  if (!verdict.ok) {
    await log(`standing: fork text REJECTED (${verdict.reason}; ${text.length} chars; cache_read ${u.cache_read_input_tokens}, cache_write ${u.cache_creation_input_tokens}, out ${u.output_tokens}); ${path} kept`);
    return 'invalid';
  }
  try {
    try {
      if (await $.fs.exists(path)) await $.fs.write(prevPath, await $.fs.read(path));
    } catch { await log('standing: could not keep the old file as standing.prev.md'); }
    await $.fs.write(path, `${text}\n`);
  } catch { await log(`standing: write failed, ${path} could not be written`); return 'threw'; }
  await log(`standing: WROTE ${path} (${text.length} chars; cache_read ${u.cache_read_input_tokens}, cache_write ${u.cache_creation_input_tokens}, out ${u.output_tokens})`);
  return 'ok';
}

/** Clears the session through the host's `clear`, with the handoff clear's checks and console fallback. No prompt. */
async function standingClear(
  $: StandingHost, state: StandingState, arm: StandingArm, sid: string, path: string, tokens: number,
  live: LiveView, startActive: number, log: (text: string) => Promise<void>,
): Promise<'cleared' | 'failed' | 'aborted'> {
  const unchanged = async (): Promise<boolean> => {
    const v = live();
    if (v.running || v.lastActive !== startActive) return false;
    try { return await $.session.id() === sid; } catch { return false; }
  };
  try {
    const fresh = await checkStanding($, path, sid, startActive);
    if (!fresh.ok || !(await unchanged())) { await log(`standing: clear aborted, ${fresh.ok ? 'activity or a new session id' : fresh.reason}`); return 'aborted'; }
    // resumed.json first: the SessionStart hook skips a file this names.
    await $.fs.write(sessionFile(arm.dir, sid, 'resumed.json'), JSON.stringify({ by: 'plugin', standing: true, file: path, at: new Date().toISOString() }));
    let color: AgentColorRecord | undefined;
    const pathFor = async (id: string): Promise<string | undefined> => {
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
      let cwd: string | undefined;
      try { cwd = await $.session.cwd(); } catch { cwd = undefined; }
      return home && cwd ? transcriptPath(home, cwd, id) : undefined;
    };
    try { color = await resolveColor($, arm.dir, sid, pathFor, log); } catch { await log('standing: could not read the session color; carrying on without it'); }
    if (!(await unchanged())) { await log('standing: clear aborted, a turn started while preparing'); return 'aborted'; }
    await log(`standing: CLEAR ${sid.slice(0, 8)} at ${tokens} tokens; ${path} is fresh and complete`);
    let cleared = false;
    try {
      await $.command.run({ command: 'clear' });
      cleared = true;
    } catch (error) {
      const reason = String((error as { message?: unknown } | undefined)?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);
      let note = '';
      if (onWindows() && isStoppedRefusal(reason)) {
        const typed = await consoleClear($, { sessionId: sid, dir: arm.dir });
        if (typed.ok) {
          if (await waitForNewId($, sid)) { cleared = true; await log(`standing: clear via console fallback (pid ${typed.pid})`); }
          else note = `; console fallback typed /clear (pid ${typed.pid}) but the id did not change`;
        } else note = `; console fallback: ${typed.error}`;
      }
      if (!cleared) { await log(`standing: clear failed: ${reason}${note}`); return 'failed'; }
    }
    let newId = sid;
    try { newId = await $.session.id(); } catch { await log('standing: session id could not be read after the clear'); }
    if (newId !== sid) {
      try { arm.onIdChanged?.(sid, newId); } catch { /* the seed is a convenience */ }
      state.resume.set(newId, path);
      try { await $.store.set(`standing_resume:${newId}`, { path, old_sid: sid, at: new Date().toISOString() }); } catch { /* memory still has it */ }
    } else {
      await log('standing: session id UNCHANGED at the clear; the resume line is not armed');
    }
    const record = JSON.stringify({ old_sid: sid, at: new Date().toISOString(), tokens });
    for (const id of newId !== sid ? [newId, sid] : [sid]) {
      try { await $.fs.write(sessionFile(arm.dir, id, 'standing_clear.json'), record); } catch { await log(`standing: could not write standing_clear.json for ${id.slice(0, 8)}`); }
    }
    try {
      const sep = arm.dir.includes('\\') && !arm.dir.includes('/') ? '\\' : '/';
      await $.fs.write(`${arm.dir.replace(/[\\/]+$/, '')}${sep}current_session.json`, JSON.stringify({ id: newId, previous_id: sid, at: new Date().toISOString(), standing: true }));
    } catch { await log('standing: could not write current_session.json'); }
    if (color) {
      let target: string | undefined;
      try { target = await pathFor(newId); } catch { target = undefined; }
      await carryColor($, color, newId, target, log);
    }
    await log(`standing: CLEARED ${sid.slice(0, 8)} -> ${newId.slice(0, 8)}; no prompt submitted, no more pings for the old session`);
    return 'cleared';
  } catch {
    await log('standing: clear failed (details omitted)');
    return 'failed';
  }
}
