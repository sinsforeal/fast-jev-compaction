import { describe, expect, it, vi } from 'vitest';
import { handoffStep, stateKey, type HandoffHost } from '../hooks/handoff.ts';
import { CLEAR_TEXT, CONSOLE_HELPER_PS1, consoleClear, isStoppedRefusal, screenVerdict } from '../hooks/console-clear.ts';

const REFUSAL = 'fast-jev-compaction: $.command.run: the session was stopped and nobody has sent input since';
const RULE = '\u2500'.repeat(110);
const NAMED_RULE = `${'\u2500'.repeat(90)} pick assist \u2500`;
const STATUS = '  \u23f5\u23f5 bypass permissions on (shift+tab to cycle) \u00b7 \u2190 1 agent \u00b7 \u2193 to manage                /rc';

// Screens copied from live Claude Code 2.1.310 consoles (2026-10-26), trimmed to the rows that matter.
const idleWaitingForAgents = [
  '  fixes again.', '', '\u273b Waiting for 2 background agents to finish', '', NAMED_RULE, '\u276f', RULE, STATUS, '  \u25cf main',
  '  \u25ef general-purpose  Checking settings_baseline.json hooks      1m 14s \u00b7 \u2193 43.3k tokens',
];
const idleDone = ['\u273b Baked for 17s \u00b7 done 12:36 \u00b7 7 shells still running', NAMED_RULE, '\u276f', RULE,
  '  \u23f5\u23f5 bypass permissions on \u00b7 7 shells \u00b7 \u2190 1 agent \u00b7 \u2193 to manage     new task? /clear to save 254.9k tokens',
  '                                                                              /rc'];
const busyThinking = ['\u2736 Scampering\u2026 (2m 44s \u00b7 \u2193 14.7k tokens \u00b7 thinking with high effort)', NAMED_RULE, '>', RULE,
  '  \u23f5\u23f5 bypass permissions on \u00b7 5 shells \u00b7 esc to interrupt \u00b7 \u2190 1 agent \u00b7 \u2193 to manage    /rc'];

describe('0.5.17 refusal match', () => {
  it.each([
    REFUSAL,
    'the session was stopped and nobody has sent input since',
    'The session was interrupted; nobody has sent input since',
    'SESSION WAS STOPPED',
  ])('matches %s', text => {
    expect(isStoppedRefusal(text)).toBe(true);
    expect(isStoppedRefusal(new Error(text))).toBe(true);
  });

  it.each([
    'clear refused', '', 'fetch failed', 'command not found: clear', 'the host lists no runnable clear command',
    'the session was cleared',
  ])('does not match %j', text => {
    expect(isStoppedRefusal(text)).toBe(false);
    expect(isStoppedRefusal(new Error(text))).toBe(false);
  });

  it('does not throw on odd input', () => {
    expect(isStoppedRefusal(undefined)).toBe(false);
    expect(isStoppedRefusal(null)).toBe(false);
    expect(isStoppedRefusal({})).toBe(false);
  });
});

describe('0.5.17 idle and empty-prompt check on screen rows', () => {
  it('accepts an idle session waiting on background agents with an empty box', () => {
    expect(screenVerdict(idleWaitingForAgents)).toEqual({ ok: true });
  });

  it('accepts a finished turn (the /clear hint in the status line is not a busy sign)', () => {
    expect(screenVerdict(idleDone)).toEqual({ ok: true });
  });

  it('accepts the plain ">" marker when idle', () => {
    expect(screenVerdict([NAMED_RULE, '>', RULE, STATUS])).toEqual({ ok: true });
  });

  it('refuses while "esc to interrupt" is on screen, whatever the box holds', () => {
    const v = screenVerdict(busyThinking);
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ reason: expect.stringContaining('busy') });
    expect(screenVerdict([...idleWaitingForAgents, '  Esc to Interrupt']).ok).toBe(false);
  });

  it('refuses when the box holds typed text', () => {
    const v = screenVerdict([NAMED_RULE, '\u276f fix the thing in', RULE, STATUS]);
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining('not empty') });
    expect(screenVerdict([NAMED_RULE, '> /cl', RULE, STATUS]).ok).toBe(false);
  });

  it('refuses a multi-line input (a second row inside the box)', () => {
    const v = screenVerdict([NAMED_RULE, '\u276f first line', '  second line', RULE, STATUS]);
    expect(v.ok).toBe(false);
  });

  it('refuses when no prompt box is on screen (a dialog, a blank console)', () => {
    expect(screenVerdict(['Do you want to proceed?', ' 1. Yes', ' 2. No']))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no prompt box') });
    expect(screenVerdict([])).toMatchObject({ ok: false });
    expect(screenVerdict(['', '', ''])).toMatchObject({ ok: false });
  });

  it('refuses a marker row that is not framed by rules', () => {
    expect(screenVerdict(['> quoted line from a reply', 'more reply text']).ok).toBe(false);
    expect(screenVerdict(['\u276f', RULE, STATUS]).ok).toBe(false);
  });

  it('the last prompt row on screen decides, an older ">" quote above it does not', () => {
    expect(screenVerdict(['> an earlier quoted line', ...idleDone])).toEqual({ ok: true });
  });
});

type Reply = { exitCode: number; stdout?: string } | Error;

function consoleHost(replies: Record<'read' | 'type', Reply>) {
  const files = new Map<string, string>();
  const calls: { argv: readonly string[]; init?: { timeoutMs?: number; env?: Record<string, string> } }[] = [];
  const host = {
    fs: { write: vi.fn(async (path: string, text: string) => { files.set(path, text); }) },
    process: { run: vi.fn(async (argv: readonly string[], init?: { timeoutMs?: number; env?: Record<string, string> }) => {
      calls.push({ argv, init });
      const r = replies[argv.at(-1) as 'read' | 'type'];
      if (r instanceof Error) throw r;
      return r;
    }) },
  };
  return { host, files, calls };
}

const readOk = (rows: string[], pid = 4242): Reply => ({ exitCode: 0, stdout: `${JSON.stringify({ pid, rows })}\r\n` });
const typedOk = (pid = 4242): Reply => ({ exitCode: 0, stdout: `${JSON.stringify({ pid, typed: 2 * (CLEAR_TEXT.length + 1) })}\n` });

describe('0.5.17 consoleClear helper calls (mocked process.run)', () => {
  it('reads, judges idle, then types /clear + Enter into the pid it found', async () => {
    const c = consoleHost({ read: readOk(idleWaitingForAgents), type: typedOk() });
    const r = await consoleClear(c.host, { sessionId: 'sess-1', dir: 'F:/h' });
    expect(r).toEqual({ ok: true, pid: 4242 });
    expect(c.calls.map(x => x.argv.at(-1))).toEqual(['read', 'type']);
    expect(c.calls[0]!.argv[0]).toBe('powershell');
    expect(c.calls[0]!.argv).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File']));
    expect(c.calls[0]!.init?.env).toEqual({ FJ_SID: 'sess-1' });
    expect(c.calls[1]!.init?.env).toEqual({ FJ_SID: 'sess-1', FJ_PID: '4242', FJ_TEXT: '/clear' });
    const script = c.calls[0]!.argv.at(-2)!;
    expect(script).toBe('F:\\h\\console-clear.ps1');
    expect(c.files.get(script)).toBe(CONSOLE_HELPER_PS1);
  });

  it('never runs the type step when the screen is busy or the box is not empty', async () => {
    for (const rows of [busyThinking, [NAMED_RULE, '\u276f half typed', RULE, STATUS], ['Do you want to proceed?']]) {
      const c = consoleHost({ read: readOk(rows), type: typedOk() });
      const r = await consoleClear(c.host, { sessionId: 's', dir: 'F:/h' });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('console not ready (pid 4242)') });
      expect(c.calls.map(x => x.argv.at(-1))).toEqual(['read']);
    }
  });

  it('reports the helper refusing at type time (the screen changed in between)', async () => {
    const c = consoleHost({ read: readOk(idleDone), type: { exitCode: 0, stdout: '{"pid":4242,"refused":"session is busy (esc to interrupt on screen)"}\n' } });
    expect(await consoleClear(c.host, { sessionId: 's', dir: 'F:/h' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('session is busy') });
  });

  it.each([
    ['no live process', { read: { exitCode: 0, stdout: '{"error":"no live claude process owns session s"}\n' }, type: typedOk() }, 'no live claude process'],
    ['attach failure', { read: { exitCode: 0, stdout: '{"pid":4242,"error":"AttachConsole(4242) failed, code 5"}\n' }, type: typedOk() }, 'AttachConsole(4242) failed'],
    ['empty helper output', { read: { exitCode: 1, stdout: '' }, type: typedOk() }, 'returned nothing'],
    ['garbled output', { read: { exitCode: 0, stdout: 'Add-Type : boom\n' }, type: typedOk() }, 'returned nothing'],
    ['a short write', { read: readOk(idleDone), type: { exitCode: 0, stdout: '{"pid":4242,"typed":3}\n' } }, 'typed 3 of 14'],
    ['a type-step error', { read: readOk(idleDone), type: { exitCode: 0, stdout: '{"pid":4242,"error":"WriteConsoleInputW failed, code 6"}\n' } }, 'WriteConsoleInputW failed'],
    ['a spawn error', { read: new Error('spawn powershell ENOENT'), type: typedOk() }, 'spawn powershell ENOENT'],
  ] as const)('%s comes back as a failure with the text, never a throw', async (_name, replies, text) => {
    const c = consoleHost(replies as Record<'read' | 'type', Reply>);
    const r = await consoleClear(c.host, { sessionId: 's', dir: 'F:/h' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(text) });
  });

  it('the helper script is ASCII only and takes its input from the environment', () => {
    expect([...CONSOLE_HELPER_PS1].every(ch => ch.charCodeAt(0) < 128)).toBe(true);
    expect(CONSOLE_HELPER_PS1).toContain('FJ_SID');
    expect(CONSOLE_HELPER_PS1).toContain('esc to interrupt');
  });
});

/** A host holding a complete handoff for OLD; the refusal text is thrown by `clear` until `clearAfter` runs. */
const OLD = 'old-session';
const NEW = 'new-session';

function setup(opts: { runError?: unknown; consoleClear?: (input: { sessionId: string; dir: string }) => Promise<any>; idChangesOnConsole?: boolean } = {}) {
  let sid = OLD;
  const files = new Map<string, string>([[`F:/h/${OLD}/latest.md`, `# ${OLD}\nCOMPLETE\n`]]);
  const logs: string[] = [];
  const calls: string[] = [];
  const store = new Map<string, unknown>([[stateKey(OLD), { forcedOrders: 1, clearFailures: 0, orderAt: 1 }]]);
  const host = {
    session: { id: async () => sid },
    clock: { now: async () => 5, sleep: vi.fn(async () => {}) },
    fs: {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
      write: async (p: string, t: string) => { files.set(p, t); },
      stat: async (p: string) => ({ kind: 'file', size: files.get(p)?.length ?? 0, mtimeMs: 10 }),
    },
    store: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k: string) => { store.delete(k); },
    },
    prompt: { submit: vi.fn(async ({ text }: { text: string }) => { calls.push(`submit:${text.slice(0, 14)}`); }) },
    command: {
      list: async () => [{ name: 'clear' }],
      run: vi.fn(async ({ command }: { command: string }) => {
        calls.push(`run:${command}`);
        if (opts.runError !== undefined) throw opts.runError;
        sid = NEW;
        return {};
      }),
    },
    process: { run: vi.fn(async () => ({ exitCode: 1 })) },
  };
  const typed = vi.fn(opts.consoleClear ?? (async () => ({ ok: true, pid: 4242 })));
  const consoleFn = vi.fn(async (input: { sessionId: string; dir: string }) => {
    calls.push('console');
    const r = await typed(input);
    if (r.ok && opts.idChangesOnConsole !== false) sid = NEW;
    return r;
  });
  const pending: Promise<void>[] = [];
  const step = async (withConsole = true) => {
    await handoffStep(host as unknown as HandoffHost, {
      sessionId: OLD, visible: 1, thresholdsEnabled: true,
      config: { handoffAt: 250_000, handoffForceAt: 300_000, handoffDir: 'F:/h' },
      log: async t => { logs.push(t); },
      detach: work => { pending.push(work()); },
      consoleClear: withConsole ? consoleFn : undefined,
    });
    await Promise.all(pending);
  };
  return { host, files, logs, calls, store, step, typed, consoleFn };
}

describe('0.5.17 fallback wiring in the handoff clear', () => {
  it('a stopped-session refusal types /clear via the console, then follows the new id and resumes', async () => {
    const s = setup({ runError: new Error(REFUSAL) });
    await s.step();
    expect(s.typed).toHaveBeenCalledWith({ sessionId: OLD, dir: 'F:/h' });
    expect(s.calls).toEqual(['run:clear', 'console', 'submit:HANDOFF RESUME']);
    expect(s.logs).toContain('handoff clear via console fallback (pid 4242)');
    expect(s.logs.some(l => l.includes('handoff clear failed'))).toBe(false);
    expect(s.logs.some(l => l.includes('session id CHANGED at the clear (old-sess -> new-sess)'))).toBe(true);
    expect(s.files.get(`F:/h/${NEW}/latest.md`)).toContain('COMPLETE');
    expect(s.store.has(stateKey(OLD))).toBe(false);
  });

  it('a console that is not ready counts as one failed attempt, logs why, and the next turn retries', async () => {
    const s = setup({ runError: new Error(REFUSAL), consoleClear: async () => ({ ok: false, error: 'console not ready (pid 4242): session is busy (esc to interrupt on screen)' }) });
    await s.step();
    const line = s.logs.find(l => l.includes('handoff clear failed (attempt 1 of 3)'))!;
    expect(line).toContain('the session was stopped and nobody has sent input since');
    expect(line).toContain('console fallback: console not ready (pid 4242): session is busy');
    expect(line).toContain('will retry on the next turn');
    expect(s.logs.some(l => l.includes('via console fallback'))).toBe(false);
    expect(s.calls).toEqual(['run:clear', 'console']);
    expect((s.store.get(stateKey(OLD)) as { clearFailures: number }).clearFailures).toBe(1);
    expect(s.files.has(`F:/h/${OLD}/latest.md`)).toBe(true);
    await s.step();
    expect(s.calls).toEqual(['run:clear', 'console', 'run:clear', 'console']);
    expect((s.store.get(stateKey(OLD)) as { clearFailures: number }).clearFailures).toBe(2);
  });

  it('typed but the session id never changes: logged, counted as a failure, no resume order', async () => {
    const s = setup({ runError: new Error(REFUSAL), idChangesOnConsole: false, consoleClear: async () => ({ ok: true, pid: 77 }) });
    await s.step();
    const line = s.logs.find(l => l.includes('handoff clear failed (attempt 1 of 3)'))!;
    expect(line).toContain('console fallback typed /clear (pid 77) but the session id did not change within 30 s');
    expect(s.calls).not.toContain('submit:HANDOFF RESUME');
    expect(s.host.clock.sleep.mock.calls.length).toBeGreaterThan(10);
  });

  it('other clear errors never use the console', async () => {
    for (const message of ['clear refused', 'host error 500', 'the session was cleared']) {
      const s = setup({ runError: new Error(message) });
      await s.step();
      expect(s.typed).not.toHaveBeenCalled();
      expect(s.logs.some(l => l.includes('handoff clear failed (attempt 1 of 3)') && l.includes(message))).toBe(true);
      expect(s.logs.some(l => l.includes('console fallback'))).toBe(false);
    }
  });

  it('without a console hook (other platforms) the refusal behaves as in 0.5.16', async () => {
    const s = setup({ runError: new Error(REFUSAL) });
    await s.step(false);
    expect(s.typed).not.toHaveBeenCalled();
    expect(s.calls).toEqual(['run:clear']);
    const line = s.logs.find(l => l.includes('handoff clear failed (attempt 1 of 3)'))!;
    expect(line).toContain('will retry on the next turn');
    expect(line).not.toContain('console fallback');
  });

  it('a normal clear never touches the console', async () => {
    const s = setup();
    await s.step();
    expect(s.typed).not.toHaveBeenCalled();
    expect(s.calls).toEqual(['run:clear', 'submit:HANDOFF RESUME']);
  });
});
