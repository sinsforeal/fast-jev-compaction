/**
 * 0.5.0 handoff state machine. Pure of the engine: it is driven with a small host
 * (`$` subset), keeps one record per session id in `$.store`, and never clears a
 * session without a complete handoff file that names this session.
 */

export type HandoffConfig = {
  handoffAt: number;
  handoffForceAt: number;
  handoffDir?: string;
  handoffSkillPath?: string;
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
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number }> };
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
  /** The clear is not available on this host (logged once). */
  clearBlocked?: boolean;
};

export const SOON_STEP_TOKENS = 50_000;
export const MAX_FORCED_REPEATS = 3;
export const MAX_CLEAR_FAILURES = 3;
/** Delay before a detached host call, so the turn.complete hook has returned first. */
export const DETACH_DELAY_MS = 250;

export const stateKey = (sessionId: string): string => `handoff:${sessionId}`;

/** A relative path joins the session working directory; an absolute path, or no cwd, stays as given. */
export function resolveAgainstCwd(cwd: string | undefined, path: string): string {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path) || !cwd) return path;
  return `${cwd.replace(/[\\/]+$/, '')}${cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'}${path.replace(/^[.][\\/]/, '')}`;
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
  marker: { order: 'soon' | 'now'; tokens: number; limit: number; attempt: number },
): Promise<string> {
  const path = sessionFile(dir, sessionId, 'order.json');
  try {
    const body = JSON.stringify({ order: marker.order, ts: new Date().toISOString(), tokens: marker.tokens, limit: marker.limit, attempt: marker.attempt });
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

export function soonOrder(visible: number, config: HandoffConfig, latest: string): string {
  return `HANDOFF SOON: unprunable context is ${visible} tokens (limit ${config.handoffForceAt}). Finish the current step, then follow ${config.handoffSkillPath ?? 'the handoff skill'} section Handoff and write ${latest} ending with the line COMPLETE. Do not start new work.`;
}

export function nowOrder(visible: number, config: HandoffConfig, latest: string): string {
  return `HANDOFF NOW: unprunable context is ${visible} tokens (limit ${config.handoffForceAt}). Follow ${config.handoffSkillPath ?? 'the handoff skill'} section Handoff and write ${latest} ending with the line COMPLETE now, then end your turn; the session will be cleared and resumed by the plugin.`;
}

export function resumeOrder(latest: string, config: HandoffConfig): string {
  return `HANDOFF RESUME: read ${latest} and follow ${config.handoffSkillPath ?? 'the handoff skill'} section Resume; verify every SHA and queue row against git before acting.`;
}

export type FileCheck = { ok: true; mtimeMs: number } | { ok: false; reason: string };

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
    if (!(stat.mtimeMs > orderAt)) return { ok: false, reason: 'older than the order' };
    const lines = (await host.fs.read(path)).split(/\r?\n/);
    if (!lines.slice(0, 10).some(line => line.includes(sessionId))) return { ok: false, reason: 'header does not name this session' };
    const last = [...lines].reverse().find(line => line.trim().length > 0);
    if (last?.trim() !== 'COMPLETE') return { ok: false, reason: 'last line is not COMPLETE' };
    return { ok: true, mtimeMs: stat.mtimeMs };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export type StepContext = {
  host: HandoffHost;
  sessionId: string;
  /** The post-cut estimate when a prune ran this turn, else context.tokens. */
  visible: number;
  config: HandoffConfig;
  log: (text: string) => Promise<void>;
  /** Runs work after the hook has returned; errors are the work's own to log. */
  detach: (work: () => Promise<void>) => void;
  /** Called when the clear changed the session id, before the files are copied (0.5.4: seeds the new id's handoff root). */
  onIdChanged?: (previous: string, id: string) => void;
};

async function load(host: HandoffHost, sessionId: string): Promise<HandoffState> {
  const raw = await host.store.get(stateKey(sessionId));
  if (raw && typeof raw === 'object') return { forcedOrders: 0, clearFailures: 0, ...(raw as Partial<HandoffState>) };
  return { forcedOrders: 0, clearFailures: 0 };
}

async function save(host: HandoffHost, sessionId: string, state: HandoffState): Promise<void> {
  await host.store.set(stateKey(sessionId), state);
}

/** Waits before a detached call; a host without a clock sleep just goes on. */
async function pause(host: HandoffHost): Promise<void> {
  try { await host.clock.sleep(DETACH_DELAY_MS); } catch { /* no sleep: go on */ }
}

/** Does the host list a runnable `clear`? Unknown (no list, or it throws) counts as yes: the run itself then decides. */
async function clearAvailable(host: HandoffHost): Promise<boolean> {
  try {
    return (await host.command.list()).some(c => c.name === 'clear');
  } catch {
    return true;
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

/** One turn.complete step of the machine. Never throws into the caller. */
export async function handoffStep(host: HandoffHost, ctx: Omit<StepContext, 'host'>): Promise<void> {
  const { sessionId, visible, config, log, detach } = ctx;
  const dir = config.handoffDir;
  if (!dir) return;
  const latest = sessionFile(dir, sessionId, 'latest.md');
  const state = await load(host, sessionId);
  let changed = false;

  // 1. An order is out: is the file complete and newer than it?
  if (state.orderAt !== undefined && !state.clearBlocked && state.clearFailures < MAX_CLEAR_FAILURES) {
    const check = await checkLatest(host, latest, sessionId, state.orderAt);
    if (check.ok) {
      if (!(await clearAvailable(host))) {
        state.clearBlocked = true;
        await save(host, sessionId, state);
        await log(`handoff complete but the host lists no runnable "clear" command; session left as it is (live check owed)`);
        await clearOrderMarker(host, dir, sessionId, log);
        return;
      }
      // resumed.json first: the SessionStart hook skips a file this names.
      await host.fs.write(sessionFile(dir, sessionId, 'resumed.json'), JSON.stringify({
        by: 'plugin', file: latest, mtime: check.mtimeMs, at: new Date().toISOString(),
      }));
      await log(`handoff complete (${latest}); clearing the session and resuming from the file`);
      detach(async () => {
        await pause(host);
        try {
          await host.command.run({ command: 'clear' });
        } catch {
          const again = await load(host, sessionId);
          again.clearFailures += 1;
          await save(host, sessionId, again);
          await log(`handoff clear failed (attempt ${again.clearFailures} of ${MAX_CLEAR_FAILURES}); will retry on the next turn`);
          if (again.clearFailures >= MAX_CLEAR_FAILURES) await clearOrderMarker(host, dir, sessionId, log);
          return;
        }
        const newId = await followSessionId(host, dir, sessionId, latest, log, ctx.onIdChanged);
        // 0.5.5: the cycle is over; neither folder keeps an order marker when the resume goes out.
        await clearOrderMarker(host, dir, sessionId, log);
        if (newId && newId !== sessionId) await clearOrderMarker(host, dir, newId, log);
        await log('handoff cleared the session; submitting the resume order');
        try {
          await host.prompt.submit({ text: resumeOrder(latest, config) });
        } catch {
          await log('handoff resume submit failed after the clear');
        }
        await host.store.delete(stateKey(sessionId));
      });
      return;
    }
    // 2. Outstanding forced order, file not complete: repeat once per turn, capped.
    if (state.forcedOrders > 0 && !state.gaveUp) {
      if (state.forcedOrders - 1 < MAX_FORCED_REPEATS) {
        state.forcedOrders += 1;
        state.orderAt = await host.clock.now();
        await save(host, sessionId, state);
        await log(`handoff order repeated (${state.forcedOrders - 1} of ${MAX_FORCED_REPEATS}); file not complete: ${check.reason}`);
        const marker = await writeOrderMarker(host, dir, sessionId, { order: 'now', tokens: visible, limit: config.handoffForceAt, attempt: state.forcedOrders });
        await log(`handoff order marker rewritten: ${marker} (now, attempt ${state.forcedOrders}, ${visible}/${config.handoffForceAt})`);
        const text = nowOrder(visible, config, latest);
        detach(async () => { await pause(host); await host.prompt.submit({ text }); });
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

  // 3. New orders from the visible size.
  if (visible >= config.handoffForceAt) {
    if (state.forcedOrders === 0) {
      state.forcedOrders = 1;
      state.orderAt = await host.clock.now();
      changed = true;
      const marker = await writeOrderMarker(host, dir, sessionId, { order: 'now', tokens: visible, limit: config.handoffForceAt, attempt: state.forcedOrders });
      await log(`handoff order NOW at ~${visible} tokens (limit ${config.handoffForceAt}); marker ${marker} (order now); expecting ${latest}`);
      const text = nowOrder(visible, config, latest);
      await save(host, sessionId, state);
      detach(async () => { await pause(host); await host.prompt.submit({ text }); });
    }
    return;
  }
  if (visible >= config.handoffAt && state.forcedOrders === 0 &&
      (state.lastSoonAt === undefined || visible >= state.lastSoonAt + SOON_STEP_TOKENS)) {
    state.lastSoonAt = visible;
    state.orderAt = await host.clock.now();
    changed = true;
    state.soonOrders = (state.soonOrders ?? 0) + 1;
    const marker = await writeOrderMarker(host, dir, sessionId, { order: 'soon', tokens: visible, limit: config.handoffAt, attempt: state.soonOrders });
    await log(`handoff order SOON at ~${visible} tokens (write at ${config.handoffAt}, force at ${config.handoffForceAt}); marker ${marker} (order soon); expecting ${latest}`);
    const text = soonOrder(visible, config, latest);
    await save(host, sessionId, state);
    detach(async () => { await pause(host); await host.prompt.submit({ text }); });
  }
  void changed;
}
