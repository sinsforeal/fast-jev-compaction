/**
 * 0.5.0 handoff state machine. Pure of the engine: it is driven with a small host
 * (`$` subset), keeps one record per session id in `$.store`, and never clears a
 * session without a complete handoff file that names this session.
 */

import { carryColor, resolveColor, type AgentColorRecord } from './color-carry.js';

export type HandoffConfig = {
  handoffAt: number;
  handoffForceAt: number;
  handoffDir?: string;
  handoffSkillPath?: string;
  /** 0.5.10: where handoffAt/handoffForceAt came from, e.g. `options` or `window.json (arm B)`. Logged with each order. */
  windowSource?: string;
};

export type HandoffHost = {
  session: { id: () => Promise<string> };
  clock: { now: () => Promise<number>; sleep: (ms: number) => Promise<void> };
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
    stat: (path: string) => Promise<{ kind: string; size: number; mtimeMs: number }>;
  };
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  prompt: { submit: (input: { text: string }) => Promise<unknown> };
  command: {
    run: (input: { command: string; args?: string }) => Promise<unknown>;
    list: () => Promise<readonly { name: string }[]>;
  };
  /** 0.5.5: `$.process.run`, used only to rename and delete the order marker (`$.fs` has neither). */
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout?: string }> };
};

/** Per-session record under `handoff:<sessionId>` in `$.store`. */
export type HandoffState = {
  /** Visible size at the last HANDOFF SOON order. */
  lastSoonAt?: number;
  /** Time (clock.now) of the latest order of either kind; the file must be newer. */
  orderAt?: number;
  /** Forced (NOW) orders sent, the first included. */
  forcedOrders: number;
  /** "handoff not written" was logged; no more orders, pruning goes on. */
  gaveUp?: boolean;
  /** SOON orders sent (the marker's attempt number for a SOON). */
  soonOrders?: number;
  /** Clear or resume attempts that failed; capped. */
  clearFailures: number;
  /** 0.5.16: clock.now of the latest failed clear; after MAX_CLEAR_FAILURES a new burst starts once the cooldown has passed. */
  lastClearFailAt?: number;
  /** The clear is not available on this host (logged once). */
  clearBlocked?: boolean;
  /** A ratio miss forces NOW independently of context size and launcher ENV. */
  forceReason?: string;
};

export const SOON_STEP_TOKENS = 50_000;
export const MAX_FORCED_REPEATS = 3;
export const MAX_CLEAR_FAILURES = 3;
/** 0.5.16: after a burst of failed clears, the next burst waits this long; retries never stop for good. */
export const CLEAR_RETRY_COOLDOWN_MS = 10 * 60_000;
/** Delay before a detached host call, so its hook has returned first. */
export const DETACH_DELAY_MS = 250;
// Only live work is in memory. A module reload cannot strand a persisted in-flight flag.
const pendingClears = new Set<string>();
/**
 * 0.5.14: the text of the SOON/NOW order that is out for a session and whose file is not complete yet.
 * `$.prompt.submit` can end without the order ever reaching the model (21687c6d, 2026-10-20: four orders,
 * no enqueue, no error, no log). The prompt.submit hook in fast-jev.ts reads this and attaches the text
 * as `context` to the next prompt that enters, whatever its origin. Cleared with the order marker.
 */
export const pendingOrders = new Map<string, string>();

export const stateKey = (sessionId: string): string => `handoff:${sessionId}`;

/** A relative path joins the session working directory; an absolute path, or no cwd, stays as given. */
export function resolveAgainstCwd(cwd: string | undefined, path: string): string {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path) || !cwd) return path;
  return `${cwd.replace(/[\\/]+$/, '')}${cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'}${path.replace(/^[.][\\/]/, '')}`;
}

/**
 * 0.5.15: a handoff root never sits inside `<x>/var/handoffs`. A cwd (or stored root) at any depth
 * under that folder is cut back to `<x>`; a path that starts with it is cut to the drive/root separator.
 * Session 15635d41 (Mechanism_Analyst, 2026-10-22) captured `...\var\handoffs` and then expected
 * `...\var\handoffs\var/handoffs\<sid>\latest.md`. Pure string work, never throws.
 */
export function normalizeRoot(root: string): string;
export function normalizeRoot(root: string | undefined): string | undefined;
export function normalizeRoot(root: string | undefined): string | undefined {
  if (!root) return root;
  const hit = /[\\/]var[\\/]+handoffs(?:[\\/]|$)/i.exec(root);
  if (!hit) return root;
  const cut = root.slice(0, hit.index);
  if (cut === '' || /^[a-zA-Z]:$/.test(cut)) return root.slice(0, hit.index + 1);
  return cut;
}

/** Same as normalizeRoot for a resolved handoff dir: the `<x>` of `<x>/var/handoffs...`, or undefined. */
export function treeOfHandoffDir(dir: string): string | undefined {
  const root = normalizeRoot(dir);
  return root !== dir ? root : undefined;
}

/**
 * 0.5.15: the tree root for a raw cwd. Normalised first, then the nearest ancestor (the cwd itself
 * included) that holds `var/handoffs` or `.git` wins; none found = the normalised cwd. Never throws.
 */
export async function findTreeRoot(cwd: string, exists: (path: string) => Promise<boolean>): Promise<string> {
  const start = normalizeRoot(cwd).replace(/[\\/]+$/, '');
  const sep = start.includes('\\') && !start.includes('/') ? '\\' : '/';
  let dir = start;
  for (let depth = 0; depth < 16 && dir; depth++) {
    try {
      if (await exists(`${dir}${sep}var${sep}handoffs`) || await exists(`${dir}${sep}.git`)) return dir;
    } catch { return start; }
    const cut = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
    if (cut <= 0 || /^[a-zA-Z]:$/.test(dir.slice(0, cut))) return start;
    dir = dir.slice(0, cut);
  }
  return start;
}

/** `<handoffDir>/<sessionId>/<name>`, with the separator the configured directory uses. */
export function sessionFile(dir: string, sessionId: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${sessionId}${sep}${name}`;
}

const onWindows = (): boolean => (globalThis as { process?: { platform?: string } }).process?.platform === 'win32';
const nativePath = (path: string): string => (onWindows() ? path.replace(/\//g, '\\') : path);

/** Runs one process step; true when it exited 0. No `$.process` or a throw counts as false. */
async function runStep(host: HandoffHost, argv: string[]): Promise<boolean> {
  try { return (await host.process.run(argv, { timeoutMs: 5000 })).exitCode === 0; } catch { return false; }
}

/**
 * 0.5.5: `<handoffDir>/<sid>/order.json` { order, ts, tokens, limit, attempt } while a SOON or NOW
 * order is pending, so a Stop hook has something on disk to read before latest.md exists.
 * Written to a temp file, then renamed over order.json (`$.process.run`; `$.fs` has no rename).
 * Without a process the marker is written in place. Never throws.
 */
export async function writeOrderMarker(
  host: HandoffHost, dir: string, sessionId: string,
  marker: { order: 'soon' | 'now'; tokens: number | undefined; limit: number; attempt: number; reason?: string; window?: string },
): Promise<string> {
  const path = sessionFile(dir, sessionId, 'order.json');
  try {
    const body = JSON.stringify({ order: marker.order, ts: new Date().toISOString(), tokens: marker.tokens ?? null, limit: marker.limit, attempt: marker.attempt, ...(marker.reason ? { reason: marker.reason } : {}), ...(marker.window ? { window: marker.window } : {}) });
    const tmp = `${path}.tmp`;
    await host.fs.write(tmp, body);
    const moved = await runStep(host, onWindows()
      ? ['cmd', '/c', 'move', '/Y', nativePath(tmp), nativePath(path)]
      : ['mv', '-f', tmp, path]);
    if (!moved) await host.fs.write(path, body);
  } catch { /* the marker is a convenience; the order goes on */ }
  return path;
}

/** Removes order.json of one session folder. If the delete cannot run, the file is rewritten as {"order":"none"}. */
export async function clearOrderMarker(host: HandoffHost, dir: string, sessionId: string, log?: (text: string) => Promise<void>): Promise<void> {
  pendingOrders.delete(sessionId);
  const path = sessionFile(dir, sessionId, 'order.json');
  try {
    if (!(await host.fs.exists(path))) return;
    const gone = await runStep(host, onWindows() ? ['cmd', '/c', 'del', '/F', '/Q', nativePath(path)] : ['rm', '-f', path]);
    if (!gone) {
      await host.fs.write(path, JSON.stringify({ order: 'none', ts: new Date().toISOString() }));
      await log?.(`handoff: could not delete ${path}; rewrote it as order none`);
    }
  } catch { /* leave it */ }
}

/** `200000/250000 from window.json (arm B)` or `250000/300000 from options`; goes into order logs and the marker. */
export function windowNote(config: HandoffConfig): string {
  return `${config.handoffAt}/${config.handoffForceAt} from ${config.windowSource ?? 'options'}`;
}

export function soonOrder(visible: number, config: HandoffConfig, latest: string): string {
  return `HANDOFF SOON: unprunable context is ${visible} tokens (limit ${config.handoffForceAt}). Finish the current step, then follow ${config.handoffSkillPath ?? 'the handoff skill'} section Handoff and write ${latest} ending with the line COMPLETE. Do not start new work.`;
}

export function nowOrder(visible: number | undefined, config: HandoffConfig, latest: string, reason?: string): string {
  const cause = reason
    ? `${reason}; current context ${visible === undefined ? 'token count unavailable' : `is ${visible} tokens`} (token limit ${config.handoffForceAt} does not delay this order)`
    : `unprunable context is ${visible} tokens (limit ${config.handoffForceAt})`;
  return `HANDOFF NOW: ${cause}. Follow ${config.handoffSkillPath ?? 'the handoff skill'} section Handoff and write ${latest} ending with the line COMPLETE now, then end your turn; the session will be cleared and resumed by the plugin.`;
}

export function resumeOrder(latest: string, config: HandoffConfig): string {
  return `HANDOFF RESUME: read ${latest} and follow ${config.handoffSkillPath ?? 'the handoff skill'} section Resume; verify every SHA and queue row against git before acting.`;
}

export type FileCheck = { ok: true; mtimeMs: number; size: number } | { ok: false; reason: string };

/**
 * A handoff file counts only when it exists, was written after the order, its
 * header (first 10 lines) names this session id and its last non-empty line is COMPLETE.
 */
export async function checkLatest(
  host: Pick<HandoffHost, 'fs'>,
  path: string,
  sessionId: string,
  orderAt: number,
): Promise<FileCheck> {
  try {
    if (!(await host.fs.exists(path))) return { ok: false, reason: 'missing' };
    const stat = await host.fs.stat(path);
    if (stat.kind !== 'file') return { ok: false, reason: 'not a file' };
    if (!(stat.mtimeMs > orderAt)) return { ok: false, reason: 'older than the order' };
    const lines = (await host.fs.read(path)).split(/\r?\n/);
    const after = await host.fs.stat(path);
    if (after.kind !== 'file' || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) return { ok: false, reason: 'changed while reading' };
    const escapedId = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sessionName = new RegExp(`(^|[^A-Za-z0-9_-])${escapedId}($|[^A-Za-z0-9_-])`);
    if (!lines.slice(0, 10).some(line => sessionName.test(line))) return { ok: false, reason: 'header does not name this session' };
    const last = [...lines].reverse().find(line => line.trim().length > 0);
    if (last?.trim() !== 'COMPLETE') return { ok: false, reason: 'last line is not COMPLETE' };
    return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export type StepContext = {
  host: HandoffHost;
  sessionId: string;
  /** The post-cut estimate when a prune ran this turn, else context.tokens. Never a synthetic threshold. */
  visible: number | undefined;
  /** Request a forced written handoff now, independent of token thresholds. Persisted until the cycle ends. */
  forceReason?: string;
  /** A compaction hook may request an order, but must never clear or repeat an existing order. */
  requestOnly?: boolean;
  /** Legacy sessions do not get token-triggered orders, but still finish a forced ratio handoff. */
  thresholdsEnabled?: boolean;
  /** Do not repeat NOW at the end of the turn that first requested it. File validation still runs. */
  repeatForced?: boolean;
  config: HandoffConfig;
  log: (text: string) => Promise<void>;
  /** Runs work after the hook has returned; errors are the work's own to log. */
  detach: (work: () => Promise<void>) => void;
  /** Called when the clear changed the session id, before the files are copied (0.5.4: seeds the new id's handoff root). */
  onIdChanged?: (previous: string, id: string) => void;
  /** 0.5.15: the session's tree root (captured, normalised); the fallback looks for `<treeRoot>/var/handoffs/<sid>/latest.md`. */
  treeRoot?: string;
  /** 0.5.9: the transcript file of a session id, for the color carry; absent or undefined = no carry. */
  transcriptPathFor?: (sessionId: string) => Promise<string | undefined>;
};

async function load(host: HandoffHost, sessionId: string): Promise<HandoffState> {
  const raw = await host.store.get(stateKey(sessionId));
  if (raw && typeof raw === 'object') return { forcedOrders: 0, clearFailures: 0, ...(raw as Partial<HandoffState>) };
  return { forcedOrders: 0, clearFailures: 0 };
}

async function save(host: HandoffHost, sessionId: string, state: HandoffState): Promise<void> {
  await host.store.set(stateKey(sessionId), state);
}

/** 0.5.16: a person's prompt lifts a host guard on plugin-origin input, so the failure count starts over. */
export async function resetClearFailures(host: HandoffHost, sessionId: string): Promise<boolean> {
  const state = await load(host, sessionId);
  if (state.clearFailures === 0) return false;
  state.clearFailures = 0;
  delete state.lastClearFailAt;
  await save(host, sessionId, state);
  return true;
}

/** Waits before a detached call; a host without a clock sleep just goes on. */
async function pause(host: HandoffHost): Promise<void> {
  try { await host.clock.sleep(DETACH_DELAY_MS); } catch { /* no sleep: go on */ }
}

/** Only a host that lists a runnable `clear` may clear. An unknown capability is not permission. */
async function clearAvailable(host: HandoffHost): Promise<boolean> {
  try {
    return (await host.command.list()).some(c => c.name === 'clear');
  } catch {
    return false;
  }
}

/**
 * After the clear: read the session id again. Unchanged, nothing moves. Changed, copy
 * latest.md and resumed.json under the new id. Either way write
 * `<handoffDir>/current_session.json` { id, previous_id, at } for the launcher pin and
 * the SessionStart hook, and log which case happened.
 */
async function followSessionId(
  host: HandoffHost, dir: string, previous: string, latest: string, log: (text: string) => Promise<void>,
  onIdChanged?: (previous: string, id: string) => void,
): Promise<string | undefined> {
  try {
    const id = await host.session.id();
    if (id !== previous) {
      try { onIdChanged?.(previous, id); } catch { /* the seed is a convenience; the copy goes on */ }
      for (const name of ['latest.md', 'resumed.json']) {
        const from = sessionFile(dir, previous, name);
        try { await host.fs.write(sessionFile(dir, id, name), await host.fs.read(from)); }
        catch { await log(`handoff: could not copy ${name} to the new session folder ${id.slice(0, 8)}`); }
      }
      await log(`handoff: session id CHANGED at the clear (${previous.slice(0, 8)} -> ${id.slice(0, 8)}); files copied to ${sessionFile(dir, id, '')}`);
    } else {
      await log(`handoff: session id UNCHANGED at the clear (${previous.slice(0, 8)}); ${latest} stays the resume file`);
    }
    await host.fs.write(`${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}current_session.json`,
      JSON.stringify({ id, previous_id: previous, at: new Date().toISOString() }));
    return id;
  } catch {
    await log('handoff: session id could not be read after the clear');
    return undefined;
  }
}

/** A compaction may request NOW immediately. Only later, non-aborted turn completions may clear. */
export async function handoffStep(host: HandoffHost, ctx: Omit<StepContext, 'host'>): Promise<void> {
  const { sessionId, visible, config, log, detach } = ctx;
  const dir = config.handoffDir;
  if (!dir) return;
  const expected = sessionFile(dir, sessionId, 'latest.md');
  let latest = expected;
  let activeDir = dir;
  /** 0.5.15: the expected file is missing or stale; a complete `<treeRoot>/var/handoffs/<sid>/latest.md` is accepted. */
  const altDirs: string[] = [];
  for (const tree of [treeOfHandoffDir(dir), ctx.treeRoot ? normalizeRoot(ctx.treeRoot) : undefined]) {
    if (!tree) continue;
    const alt = `${tree.replace(/[\\/]+$/, '')}${tree.includes('\\') && !tree.includes('/') ? '\\' : '/'}var${tree.includes('\\') && !tree.includes('/') ? '\\' : '/'}handoffs`;
    if (alt !== dir && !altDirs.includes(alt)) altDirs.push(alt);
  }
  const checkAny = async (orderAt: number): Promise<FileCheck> => {
    const first = await checkLatest(host, latest, sessionId, orderAt);
    if (first.ok || (first.reason !== 'missing' && first.reason !== 'older than the order')) return first;
    for (const alt of altDirs) {
      const path = sessionFile(alt, sessionId, 'latest.md');
      if (path === latest) continue;
      const found = await checkLatest(host, path, sessionId, orderAt);
      if (!found.ok) continue;
      await log(`handoff: expected ${latest} is ${first.reason}; accepting the complete ${path} (session ${sessionId.slice(0, 8)}) from the tree root`);
      latest = path; activeDir = alt;
      return found;
    }
    return first;
  };
  const state = await load(host, sessionId);
  if (ctx.forceReason !== undefined && state.forceReason === undefined) {
    state.forceReason = ctx.forceReason;
    await save(host, sessionId, state);
  }
  // Repeated compact requests neither reset the repeat budget nor clear a session.
  if (pendingClears.has(sessionId) || (ctx.requestOnly && state.forcedOrders > 0)) return;
  const queueOrder = (text: string): void => {
    pendingOrders.set(sessionId, text);
    detach(async () => {
      await pause(host);
      try {
        const current = await host.session.id();
        if (current !== sessionId) {
          await log(`handoff order not submitted: session id is ${current.slice(0, 8)}, order was for ${sessionId.slice(0, 8)}`);
          return;
        }
        const startedAt = Date.now();
        const result = await host.prompt.submit({ text }) as { drop?: unknown } | undefined;
        const took = Date.now() - startedAt;
        if (result && typeof result === 'object' && result.drop !== undefined) {
          await log(`handoff order submit DROPPED after ${took} ms (${String(result.drop).slice(0, 200)}); the next prompt that enters carries the order`);
        } else {
          await log(`handoff order submit returned after ${took} ms (entered or queued)`);
        }
      } catch { await log('handoff order submit failed; context retained, retry budget unchanged; the next prompt that enters carries the order'); }
    });
  };

  // 0.5.16: a spent burst of failed clears is retried after the cooldown, forever.
  if (state.clearFailures >= MAX_CLEAR_FAILURES && state.lastClearFailAt !== undefined
      && await host.clock.now() - state.lastClearFailAt >= CLEAR_RETRY_COOLDOWN_MS) {
    state.clearFailures = 0;
    await save(host, sessionId, state);
  }
  // 1. An order is out: is the file complete and newer than it?
  if (!ctx.requestOnly && state.orderAt !== undefined && !state.clearBlocked && state.clearFailures < MAX_CLEAR_FAILURES) {
    const check = await checkAny(state.orderAt);
    if (check.ok) {
      const canClear = await clearAvailable(host);
      // Another completion can schedule a clear while capability lookup is awaiting.
      if (pendingClears.has(sessionId)) return;
      if (!canClear) {
        state.clearBlocked = true;
        await save(host, sessionId, state);
        await log('handoff complete but the host lists no runnable "clear" command; session left as it is (live check owed)');
        await clearOrderMarker(host, dir, sessionId, log);
        return;
      }
      pendingClears.add(sessionId);
      detach(async () => {
        try {
          await pause(host);
          if (await host.session.id() !== sessionId) return;
          // The file may have changed since the hook queued this work. Revalidate
          // after the detached delay; a stale/incomplete/missing file never clears.
          const fresh = await checkAny(state.orderAt!);
          if (!fresh.ok) {
            await log(`handoff changed before clear (${fresh.reason}); context retained`);
            return;
          }
          // resumed.json first: the SessionStart hook skips a file this names.
          await host.fs.write(sessionFile(activeDir, sessionId, 'resumed.json'), JSON.stringify({
            by: 'plugin', file: latest, mtime: fresh.mtimeMs, at: new Date().toISOString(),
          }));
          if (await host.session.id() !== sessionId) return;
          await log(`handoff complete (${latest}); clearing the session and resuming from the file`);
          if (await host.session.id() !== sessionId) return;
          // Marker writes and logs await host calls too. Nothing may clear a file
          // replaced during those awaits, or resume from a marker for another version.
          const final = await checkAny(state.orderAt!);
          if (!final.ok || final.mtimeMs !== fresh.mtimeMs || final.size !== fresh.size) {
            await log(`handoff changed immediately before clear (${final.ok ? 'file replaced' : final.reason}); context retained`);
            return;
          }
          if (await host.session.id() !== sessionId) return;
          // 0.5.9: the clear drops the `/color` record with the old transcript; read it first.
          // 0.5.13: walk the chain of previous sessions, then the color.json cache.
          let color: AgentColorRecord | undefined;
          try {
            const pathFor = ctx.transcriptPathFor;
            if (pathFor) color = await resolveColor(host, dir, sessionId, pathFor, log);
          } catch { await log('handoff: could not read the session color from the transcript; carrying on without it'); }
          try {
            await host.command.run({ command: 'clear' });
          } catch (error) {
            const again = await load(host, sessionId);
            again.clearFailures += 1;
            again.lastClearFailAt = await host.clock.now();
            await save(host, sessionId, again);
            const reason = String((error as { message?: unknown } | undefined)?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);
            await log(`handoff clear failed (attempt ${again.clearFailures} of ${MAX_CLEAR_FAILURES}): ${reason}; ${again.clearFailures < MAX_CLEAR_FAILURES ? 'will retry on the next turn' : 'context retained, retrying after a 10 minute cooldown'}`);
            // The order marker stays: the clear is still pending.
            return;
          }
          const newId = await followSessionId(host, activeDir, sessionId, latest, log, ctx.onIdChanged);
          await clearOrderMarker(host, dir, sessionId, log);
          if (newId && newId !== sessionId) await clearOrderMarker(host, dir, newId, log);
          if (color) {
            let target: string | undefined;
            try { target = newId ? await ctx.transcriptPathFor?.(newId) : undefined; } catch { target = undefined; }
            await carryColor(host, color, newId ?? sessionId, target, log);
          }
          await log('handoff cleared the session; submitting the resume order');
          try {
            await host.prompt.submit({ text: resumeOrder(latest, config) });
          } catch {
            await log('handoff resume submit failed after the clear');
          }
          await host.store.delete(stateKey(sessionId));
        } finally { pendingClears.delete(sessionId); }
      });
      return;
    }
    // 2. Outstanding forced order, file not complete: repeat once per turn, capped.
    if (state.forcedOrders > 0 && !state.gaveUp) {
      if (ctx.repeatForced === false) return;
      if (state.forcedOrders - 1 < MAX_FORCED_REPEATS) {
        state.forcedOrders += 1;
        state.orderAt = await host.clock.now();
        await save(host, sessionId, state);
        await log(`handoff order repeated (${state.forcedOrders - 1} of ${MAX_FORCED_REPEATS}); file not complete: ${check.reason}`);
        const marker = await writeOrderMarker(host, dir, sessionId, { order: 'now', tokens: visible, limit: config.handoffForceAt, attempt: state.forcedOrders, reason: state.forceReason, window: windowNote(config) });
        await log(`handoff order marker rewritten: ${marker} (now, attempt ${state.forcedOrders}, ${visible ?? 'unknown'}/${config.handoffForceAt}; window ${windowNote(config)})`);
        queueOrder(nowOrder(visible, config, latest, state.forceReason));
      } else {
        state.gaveUp = true;
        await save(host, sessionId, state);
        await clearOrderMarker(host, dir, sessionId, log);
        await log(`handoff not written (${latest}: ${check.reason}) after ${state.forcedOrders} forced orders; pruning goes on, no clear`);
      }
      return;
    }
    if (state.gaveUp) return;
  }
  if (state.gaveUp || state.clearBlocked) return;

  // 3. A ratio failure is a real reason, not a fabricated 300k token count.
  const thresholdForce = ctx.thresholdsEnabled !== false && visible !== undefined && visible >= config.handoffForceAt;
  if (state.forceReason !== undefined || thresholdForce) {
    if (state.forcedOrders === 0) {
      state.forcedOrders = 1;
      state.orderAt = await host.clock.now();
      await save(host, sessionId, state);
      const marker = await writeOrderMarker(host, dir, sessionId, { order: 'now', tokens: visible, limit: config.handoffForceAt, attempt: state.forcedOrders, reason: state.forceReason, window: windowNote(config) });
      const cause = state.forceReason ? `forced by ${state.forceReason}; actual context tokens ${visible ?? 'unavailable'}` : `at ~${visible} tokens (limit ${config.handoffForceAt})`;
      await log(`handoff order NOW ${cause}; window ${windowNote(config)}; marker ${marker} (order now); expecting ${latest}`);
      queueOrder(nowOrder(visible, config, latest, state.forceReason));
    }
    return;
  }
  if (ctx.thresholdsEnabled !== false && visible !== undefined && visible >= config.handoffAt && state.forcedOrders === 0 &&
      (state.lastSoonAt === undefined || visible >= state.lastSoonAt + SOON_STEP_TOKENS)) {
    state.lastSoonAt = visible;
    state.orderAt = await host.clock.now();
    state.soonOrders = (state.soonOrders ?? 0) + 1;
    await save(host, sessionId, state);
    const marker = await writeOrderMarker(host, dir, sessionId, { order: 'soon', tokens: visible, limit: config.handoffAt, attempt: state.soonOrders, window: windowNote(config) });
    await log(`handoff order SOON at ~${visible} tokens (write at ${config.handoffAt}, force at ${config.handoffForceAt}; window ${config.windowSource ?? 'options'}); marker ${marker} (order soon); expecting ${latest}`);
    queueOrder(soonOrder(visible, config, latest));
  }
}
