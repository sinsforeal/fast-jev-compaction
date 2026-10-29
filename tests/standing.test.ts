import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import { pendingOrders } from '../hooks/handoff.ts';
import { isUserPrompt, parseStandingOptions, validateStanding, cleanReply } from '../hooks/standing.ts';

/** 0.5.19 standing handover: window.json `standing`, the backstop writer, the fresh-start clear. Fake host. */
const SID = 'abcdef0123456789';
const NEW = 'fedcba9876543210';
const MIN = 60_000;
const DIR = 'F:/h';
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const WARM = 'Reply with the single word ok.';
const usage = { input_tokens: 3, output_tokens: 700, cache_read_input_tokens: 212345, cache_creation_input_tokens: 41 };

type Timer = { ms: number; fn: () => void; cancelled: boolean; armedAt: number };

/** A handover in the design's format, for session `sid`. */
function standingText(sid: string, extra = ''): string {
  return [
    `session: ${sid}`, 'standing: 2026-10-29 16:30', '',
    '## Unanswered questions from the User', 'none', '',
    '## Running now', 'none', '',
    '## Tracker issues open', 'tk-1 owner meta', '',
    '## Git', 'main abc1234, nothing unpushed', '',
    '## State to know', `fixture ${extra}`, '',
    '## Next steps', '1. wait', '', 'COMPLETE', '',
  ].join('\n');
}

afterEach(() => { vi.useRealTimers(); pendingOrders.clear(); });

function harness(opts: { standing?: Record<string, unknown> | false; options?: Record<string, unknown>; fork?: (prompt: string) => Promise<any>; tokens?: number; clearListed?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  let sid = SID;
  let tokens = opts.tokens ?? 200_000;
  const handlers: Record<string, Function> = {};
  const on = ((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any;
  register(on, { apiKey: 'fixture', handoffDir: DIR, idleWarmMinutes: 50, idleWarmMax: 6, ...opts.options });
  const timers: Timer[] = [];
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const put = (path: string, text: string) => { files.set(path, text); mtimes.set(path, Date.now()); };
  if (opts.standing !== false) put(`${DIR}/window.json`, JSON.stringify({ handoffAt: 250000, standing: { enabled: true, ...opts.standing } }));
  const prompts: string[] = [];
  const fork = vi.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    if (opts.fork) return opts.fork(prompt);
    return { text: prompt === WARM ? 'ok' : standingText(sid), usage };
  });
  const clearRun = vi.fn(async (c: { command: string }) => { if (c.command === 'clear') sid = NEW; return {}; });
  const $: any = {
    env: { get: async (k: string) => k === 'USERPROFILE' ? '/home' : k === 'DISABLE_AUTO_COMPACT' ? '1' : undefined },
    fs: {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
      write: async (p: string, t: string) => { put(p, t); },
      stat: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { kind: 'file', size: files.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0 }; },
    },
    store: new Map(),
    settings: { read: async () => ({}) },
    http: { fetch: vi.fn() },
    clock: {
      now: async () => Date.now(), sleep: async () => {},
      after: (ms: number, fn: () => void) => { const t: Timer = { ms, fn, cancelled: false, armedAt: Date.now() }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    },
    model: { fork },
    ui: { log: vi.fn(), toast: vi.fn() },
    session: {
      id: async () => sid, cwd: async () => 'F:/tree', messages: vi.fn(async () => []),
      usage: vi.fn(async () => ({ context: { percent: 1, tokens } })),
      compact: vi.fn(async () => ({ skip: 'fixture not due' })),
    },
    prompt: { submit: vi.fn(async () => ({})) },
    command: { list: vi.fn(async () => opts.clearListed === false ? [] : [{ name: 'clear' }]), run: clearRun },
    process: { run: vi.fn(async () => ({ exitCode: 1, stdout: '' })) },
  };
  const kv = new Map<string, unknown>();
  $.store = {
    get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => { kv.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async (k: string) => { kv.delete(k); },
  };
  const seen: any[] = [];
  /** A prompt of the given origin; `seen` holds what reached the model (text + context). */
  const submit = async (origin: Record<string, unknown> = { kind: 'composer' }, text = 'hi') =>
    handlers['prompt.submit']($, { text, turnId: undefined, wait: false, origin }, async (e: any) => { seen.push(e); return { text: e.text, context: e.context }; });
  const complete = async () => handlers['turn.complete']($, {}, async (e: unknown) => e);
  const live = () => timers.filter(t => !t.cancelled);
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
  const fire = async (t: Timer) => {
    vi.setSystemTime(Math.max(Date.now(), t.armedAt + t.ms));
    const wasLive = !t.cancelled; t.fn(); t.cancelled = wasLive ? true : t.cancelled; await flush();
  };
  const log = () => files.get('/home/.claude/fast-jev-compaction.log') ?? '';
  const standingPath = (id = SID) => `${DIR}/${id}/standing.md`;
  return { $, files, put, kv, fork, prompts, clearRun, submit, complete, live, advance, fire, log, seen, standingPath, timers,
    setTokens: (n: number) => { tokens = n; }, sid: () => sid };
}

/** The User's message, then a turn of `turnMin` minutes, then turn.complete: the idle gap starts at the end. */
async function userTurn(h: ReturnType<typeof harness>, turnMin = 10) {
  await h.submit({ kind: 'composer' });
  h.advance(turnMin * MIN);
  await h.complete();
}

describe('standing: window.json options', () => {
  it('parses defaults, overrides, off and bad values', () => {
    expect(parseStandingOptions(undefined)).toBeUndefined();
    expect(parseStandingOptions({ enabled: false })).toBeNull();
    expect(parseStandingOptions({ enabled: true })).toEqual({ minTokens: 150000, userQuietMinutes: 60, coldMarginMinutes: 5 });
    expect(parseStandingOptions({ enabled: true, minTokens: 90000, userQuietMinutes: 30, coldMarginMinutes: 2 })).toEqual({ minTokens: 90000, userQuietMinutes: 30, coldMarginMinutes: 2 });
    expect(typeof parseStandingOptions({ enabled: 'yes' })).toBe('string');
    expect(typeof parseStandingOptions({ enabled: true, minTokens: 'x' })).toBe('string');
    expect(typeof parseStandingOptions({ enabled: true, userQuietMinutes: -1 })).toBe('string');
    expect(typeof parseStandingOptions({ enabled: true, coldMarginMinutes: 60 })).toBe('string');
    expect(typeof parseStandingOptions([])).toBe('string');
  });

  it('a bad standing key is warned once and the rest of window.json stays in force', async () => {
    const h = harness({ standing: false });
    h.put(`${DIR}/window.json`, JSON.stringify({ handoffAt: 200000, standing: { enabled: 'maybe' } }));
    await h.submit(); await h.complete(); await h.complete();
    expect(h.log().split('\n').filter(l => l.includes('standing ignored'))).toHaveLength(1);
    expect(h.log()).toContain('handoff window 200000/');
    expect(h.live()[0]!.ms).toBe(50 * MIN); // plain idle warm
  });
});

describe('standing: the format and the User-quiet rule', () => {
  it('validates header, sections and the last line', () => {
    expect(validateStanding(standingText(SID), SID)).toEqual({ ok: true });
    expect(validateStanding(standingText(SID).replace('COMPLETE', 'done'), SID)).toMatchObject({ ok: false });
    expect(validateStanding(standingText(SID), NEW)).toMatchObject({ ok: false, reason: expect.stringContaining('not this one') });
    expect(validateStanding(standingText(SID).replace('## Git', '## Repos'), SID)).toMatchObject({ ok: false, reason: expect.stringContaining('Git') });
    expect(validateStanding(standingText(SID).replace('standing: 2026-10-29 16:30', 'when: now'), SID)).toMatchObject({ ok: false });
    expect(validateStanding(standingText(SID).replace('session: ', 'sess '), SID)).toMatchObject({ ok: false });
    expect(cleanReply('```markdown\nabc\nCOMPLETE\n```')).toBe('abc\nCOMPLETE');
  });

  it('counts the User, the feed and pick-assist records; not peer, heartbeat, task or plugin prompts', () => {
    expect(isUserPrompt({ kind: 'composer' }, 'x')).toBe(true);
    expect(isUserPrompt({ kind: 'bridge' }, 'x')).toBe(true);
    expect(isUserPrompt({ kind: 'channel', server: 'feed' }, 'x')).toBe(true);
    expect(isUserPrompt({ kind: 'channel', server: 'pick-assist' }, 'x')).toBe(true);
    expect(isUserPrompt({ kind: 'unclassified' }, '<channel source="feed" reply_id="1">hi</channel>')).toBe(true);
    expect(isUserPrompt({ kind: 'unclassified' }, '<channel source="pick-assist" msg_id="1">hi</channel>')).toBe(true);
    expect(isUserPrompt({ kind: 'channel', server: 'peer' }, '<channel source="peer" msg_id="1">hi</channel>')).toBe(false);
    expect(isUserPrompt({ kind: 'unclassified' }, '<channel source="peer" msg_id="1" from_name="heartbeat">x</channel>')).toBe(false);
    expect(isUserPrompt({ kind: 'peer' }, 'x')).toBe(false);
    expect(isUserPrompt({ kind: 'task-notification' }, 'x')).toBe(false);
    expect(isUserPrompt({ kind: 'scheduled-trigger' }, 'x')).toBe(false);
    expect(isUserPrompt({ kind: 'plugin', name: 'fast-jev-compaction' }, 'x')).toBe(false);
    expect(isUserPrompt(undefined, 'x')).toBe(false);
    // 0.5.21: the restart tool's typed first prompt is not the User (10-29: it held two standing clears 60 min).
    expect(isUserPrompt({ kind: 'composer' }, 'Window restarted by Ryan v2 at 17:10; resume from the HANDOFF RESUME order')).toBe(false);
  });
});

describe('standing: timer and backstop', () => {
  it('disabled (enabled false or no window.json): behaviour exactly as 0.5.18', async () => {
    for (const standing of [{ enabled: false }, false] as const) {
      const h = harness({ standing: standing === false ? false : { enabled: false } });
      await userTurn(h);
      expect(h.live()).toHaveLength(1);
      expect(h.live()[0]!.ms).toBe(50 * MIN);
      await h.fire(h.live()[0]!);
      expect(h.prompts).toEqual([WARM]);
      expect(h.clearRun).not.toHaveBeenCalled();
      expect([...h.files.keys()].filter(k => k.includes('standing'))).toEqual([]);
      expect(h.log()).toContain('idle warm 1 after 50 min');
      expect(h.log()).not.toContain('standing:');
    }
  });

  it('below minTokens: nothing at all, no write, no clear, no ping', async () => {
    const h = harness({ tokens: 100_000 });
    await userTurn(h);
    expect(h.live()[0]!.ms).toBe(55 * MIN);
    await h.fire(h.live()[0]!);
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.clearRun).not.toHaveBeenCalled();
    expect(h.live()).toHaveLength(0);
    expect(h.log()).toContain('standing: skip, context 100000 is under minTokens 150000');
  });

  it('arms at the cold boundary (60 - margin), also when idleWarmMinutes is 0', async () => {
    const h = harness({ standing: { coldMarginMinutes: 8 }, options: { idleWarmMinutes: 0 } });
    await userTurn(h);
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]!.ms).toBe(52 * MIN);
  });

  it('writes the handover when stale and the User is quiet; keeps the old file as standing.prev.md', async () => {
    const h = harness({ clearListed: false });
    h.put(h.standingPath(), standingText(SID, 'OLD'));
    await userTurn(h);
    await h.fire(h.live()[0]!);
    expect(h.prompts).toHaveLength(2); // the write, then the ping the missing clear leaves
    expect(h.prompts[0]).toContain('STANDING HANDOVER');
    expect(h.prompts[0]).toContain(`session: ${SID}`);
    expect(h.files.get(h.standingPath())).toBe(`${standingText(SID)}`);
    expect(h.files.get(`${DIR}/${SID}/standing.prev.md`)).toBe(standingText(SID, 'OLD'));
    expect(h.log()).toMatch(/standing: WROTE F:\/h\/abcdef0123456789\/standing\.md/);
    expect(h.clearRun).not.toHaveBeenCalled();
  });

  it('the User spoke within 60 min: a warm ping, no write, no clear; the next check comes when the quiet is up', async () => {
    const h = harness();
    await h.submit({ kind: 'composer' });
    await h.complete(); // short turn: the User spoke at the gap start
    await h.fire(h.live()[0]!); // 55 min idle, User spoke 55 min ago
    expect(h.prompts).toEqual([WARM]);
    expect(h.files.has(h.standingPath())).toBe(false);
    expect(h.clearRun).not.toHaveBeenCalled();
    expect(h.log()).toContain('standing: skip, the User spoke 55 min ago');
    expect(h.log()).toContain('idle warm 1 after 55 min');
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]!.ms).toBe(5 * MIN);
    await h.fire(h.live()[0]!); // 60 min after the User: quiet now, cache still warm from the ping
    expect(h.prompts.filter(p => p !== WARM)).toHaveLength(1);
    expect(h.clearRun).toHaveBeenCalledTimes(1);
  });

  it('a peer prompt does not move the User-quiet clock; his feed message does', async () => {
    const h = harness({ clearListed: false });
    await h.submit({ kind: 'composer' });
    await h.complete();
    h.advance(20 * MIN);
    await h.submit({ kind: 'peer' });
    await h.complete();
    await h.fire(h.live()[0]!); // 55 min after the peer turn = 75 min after the User
    expect(h.prompts[0]).toContain('STANDING HANDOVER');

    const g = harness({ clearListed: false });
    await g.submit({ kind: 'composer' });
    await g.complete();
    g.advance(20 * MIN);
    await g.submit({ kind: 'unclassified' }, '<channel source="feed" reply_id="9" tree="x">now</channel>');
    await g.complete();
    await g.fire(g.live()[0]!); // 55 min after the feed message
    expect(g.prompts).toEqual([WARM]);
    expect(g.log()).toContain('standing: skip, the User spoke 55 min ago');
  });

  it('persists the User time in plugin state at the arm', async () => {
    const h = harness();
    await userTurn(h, 0);
    expect(h.kv.get(`standing:${SID}`)).toEqual({ lastUserAt: Date.now() });
  });

  it('rejects an invalid fork text: old file kept, no prev, no clear, logged', async () => {
    const h = harness({ fork: async () => ({ text: standingText(SID).replace('COMPLETE', 'finished'), usage }) });
    h.put(h.standingPath(), standingText(SID, 'OLD'));
    await userTurn(h);
    const before = h.files.get(h.standingPath());
    await h.fire(h.live()[0]!);
    expect(h.files.get(h.standingPath())).toBe(before);
    expect(h.files.has(`${DIR}/${SID}/standing.prev.md`)).toBe(false);
    expect(h.clearRun).not.toHaveBeenCalled();
    expect(h.log()).toMatch(/standing: fork text REJECTED \(last line is not COMPLETE/);
    expect(h.live()).toHaveLength(1); // checks again at the cold boundary
    expect(h.live()[0]!.ms).toBe(55 * MIN);
  });

  it('rejects text for another session and a text missing a section', async () => {
    const h = harness({ fork: async () => ({ text: standingText(NEW), usage }) });
    await userTurn(h);
    await h.fire(h.live()[0]!);
    expect(h.files.has(h.standingPath())).toBe(false);
    expect(h.log()).toContain('REJECTED (header names session fedcba98');
    const g = harness({ fork: async () => ({ text: standingText(SID).replace('## Next steps', '## Later'), usage }) });
    await userTurn(g);
    await g.fire(g.live()[0]!);
    expect(g.files.has(g.standingPath())).toBe(false);
    expect(g.log()).toContain('section "Next steps" is missing');
  });

  it('a null fork (cold cache) writes nothing and stops', async () => {
    const h = harness({ fork: async () => null });
    await userTurn(h);
    await h.fire(h.live()[0]!);
    expect(h.files.has(h.standingPath())).toBe(false);
    expect(h.live()).toHaveLength(0);
    expect(h.log()).toContain('standing: write failed, fork returned null');
  });
});

describe('standing: the fresh start', () => {
  it('fresh and complete: clears at the boundary with no prompt and no fork; the next prompt carries the resume line once', async () => {
    const h = harness();
    await userTurn(h);
    h.advance(1000);
    h.put(h.standingPath(), standingText(SID)); // the session wrote it itself after its last activity
    await h.fire(h.live()[0]!);
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.clearRun).toHaveBeenCalledWith({ command: 'clear' });
    expect(h.$.prompt.submit).not.toHaveBeenCalled();
    expect(h.sid()).toBe(NEW);
    const rec = JSON.parse(h.files.get(`${DIR}/${NEW}/standing_clear.json`)!);
    expect(rec).toMatchObject({ old_sid: SID, tokens: 200000 });
    expect(typeof rec.at).toBe('string');
    expect(JSON.parse(h.files.get(`${DIR}/${SID}/standing_clear.json`)!).old_sid).toBe(SID);
    expect(JSON.parse(h.files.get(`${DIR}/current_session.json`)!)).toMatchObject({ id: NEW, previous_id: SID });
    expect(JSON.parse(h.files.get(`${DIR}/${SID}/resumed.json`)!)).toMatchObject({ by: 'plugin', file: h.standingPath() });
    expect(h.log()).toContain(`standing: CLEARED ${SID.slice(0, 8)} -> ${NEW.slice(0, 8)}`);
    // the next prompt, of any origin
    await h.submit({ kind: 'peer' }, 'wake up');
    expect(h.seen.at(-1).context).toEqual([`STANDING RESUME: read ${h.standingPath()} first, then answer the prompt.`]);
    expect(h.log()).toContain('standing: resume line carried as context');
    await h.submit({ kind: 'composer' }, 'second');
    expect(h.seen.at(-1).context).toBeUndefined();
  });

  it('the resume line also survives a plugin reload (store record) and waits out a dropped prompt', async () => {
    const h = harness();
    await userTurn(h);
    h.advance(1000);
    h.put(h.standingPath(), standingText(SID));
    await h.fire(h.live()[0]!);
    expect(h.kv.get(`standing_resume:${NEW}`)).toMatchObject({ path: h.standingPath(), old_sid: SID });
    // a registration with empty memory, same store
    const handlers: Record<string, Function> = {};
    register(((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any, { apiKey: 'fixture', handoffDir: DIR });
    const dropped = await handlers['prompt.submit']!(h.$, { text: 'a', wait: false, origin: { kind: 'composer' } }, async () => ({ drop: 'x' }));
    expect(dropped.drop).toBe('x');
    let got: any;
    await handlers['prompt.submit']!(h.$, { text: 'b', wait: false, origin: { kind: 'composer' } }, async (e: any) => { got = e; return { text: e.text }; });
    expect(got.context).toEqual([expect.stringContaining('STANDING RESUME: read')]);
  });

  it('a running turn blocks the clear', async () => {
    const h = harness();
    await userTurn(h);
    h.advance(1000);
    h.put(h.standingPath(), standingText(SID));
    const t = h.live()[0]!;
    await h.submit({ kind: 'composer' }); // a turn is running; pretend the cancel was lost
    t.cancelled = false;
    await h.fire(t);
    expect(h.clearRun).not.toHaveBeenCalled();
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.sid()).toBe(SID);
  });

  it('a prompt that lands while the handover is written blocks the clear', async () => {
    let release: (v: unknown) => void = () => {};
    const h = harness({ fork: () => new Promise(resolve => { release = resolve; }) });
    await userTurn(h);
    const firing = h.fire(h.live()[0]!);
    await flush();
    await h.submit({ kind: 'composer' });
    release({ text: standingText(SID), usage });
    await firing;
    await flush();
    expect(h.clearRun).not.toHaveBeenCalled();
    expect(h.log()).toContain('a prompt came while the handover was written');
  });

  it('a pending handoff order blocks the clear and keeps the session warm', async () => {
    const h = harness();
    await userTurn(h);
    h.advance(1000);
    h.put(h.standingPath(), standingText(SID));
    pendingOrders.set(SID, 'HANDOFF NOW: fixture');
    await h.fire(h.live()[0]!);
    expect(h.clearRun).not.toHaveBeenCalled();
    expect(h.log()).toContain('standing: skip clear, a handoff order is pending; warm ping');
    expect(h.prompts).toEqual([WARM]);
    // and a stored outstanding order (SOON/NOW sent, file not yet taken) blocks too
    pendingOrders.clear();
    await h.$.store.set(`handoff:${SID}`, { forcedOrders: 1, clearFailures: 0, orderAt: 5 });
    await h.fire(h.live()[0]!);
    expect(h.clearRun).not.toHaveBeenCalled();
    expect(h.log()).toContain('a handoff order is outstanding');
  });

  it('a stale handover (older than the last activity) is rewritten, not used', async () => {
    const h = harness({ clearListed: false });
    h.put(h.standingPath(), standingText(SID, 'OLD')); // written before the turn
    await userTurn(h);
    await h.fire(h.live()[0]!);
    expect(h.log()).toContain('older than the order; asking the session for the handover');
  });

  it('a failed /clear is logged and keeps the session warm; no prompt, no resume line', async () => {
    const h = harness();
    h.clearRun.mockImplementation(async () => { throw new Error('host says no'); });
    await userTurn(h);
    h.advance(1000);
    h.put(h.standingPath(), standingText(SID));
    await h.fire(h.live()[0]!);
    expect(h.log()).toContain('standing: clear failed: host says no');
    expect(h.sid()).toBe(SID);
    expect(h.kv.has(`standing_resume:${NEW}`)).toBe(false);
    expect(h.$.prompt.submit).not.toHaveBeenCalled();
    expect(h.prompts).toEqual([WARM]);
  });

  it('no pings after a clear: the old timers are dead and the new small session is not kept warm', async () => {
    const h = harness();
    await userTurn(h);
    h.advance(1000);
    h.put(h.standingPath(), standingText(SID));
    const t = h.live()[0]!;
    await h.fire(t);
    expect(h.sid()).toBe(NEW);
    expect(h.live()).toHaveLength(0);
    t.cancelled = false;
    h.advance(5 * 60 * MIN);
    await h.fire(t); // a stale timer of the old id
    expect(h.fork).not.toHaveBeenCalled();
    // the new session answers a prompt; its context is small, so nothing is armed to ping
    h.setTokens(40_000);
    await h.submit({ kind: 'peer' }, 'wake');
    await h.complete();
    for (const x of h.live()) await h.fire(x);
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.clearRun).toHaveBeenCalledTimes(1);
    expect(h.log()).not.toMatch(/idle warm \d/);
  });
});
