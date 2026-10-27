import { afterEach, describe, expect, it, vi } from 'vitest';
import { register, resolveHookConfig } from '../hooks/fast-jev.ts';

const SID = 'abcdef0123456789';
const SID2 = 'fedcba9876543210';
const MIN = 60_000;
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** armedAt = faked Date.now() when the timer was armed. A ping needs a full interval of real idle (0.5.18). */
type Timer = { ms: number; fn: () => void; cancelled: boolean; armedAt: number };

afterEach(() => { vi.useRealTimers(); });

function harness(options: Record<string, unknown> = {}, forkImpl?: () => Promise<any>) {
  // Only Date is faked: the harness flush() keeps real setTimeout. Timers are the harness's own clock.after.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T10:00:00Z'));
  let sid = SID;
  const handlers: Record<string, Function> = {};
  const on = ((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any;
  register(on, { apiKey: 'fixture', ...options });
  const timers: Timer[] = [];
  const files = new Map<string, string>();
  const fork = vi.fn(forkImpl ?? (async () => ({ text: 'ok', usage: {
    input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 212345, cache_creation_input_tokens: 41 } })));
  const $ = {
    env: { get: async (k: string) => k === 'USERPROFILE' ? '/home' : k === 'DISABLE_AUTO_COMPACT' ? '1' : undefined },
    fs: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p) ?? '', write: async (p: string, t: string) => { files.set(p, t); } },
    settings: { read: async () => ({}) },
    http: { fetch: vi.fn() },
    clock: {
      sleep: async () => {},
      after: (ms: number, fn: () => void) => { const t: Timer = { ms, fn, cancelled: false, armedAt: Date.now() }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    },
    model: { fork },
    ui: { log: vi.fn(), toast: vi.fn() },
    session: { id: async () => sid, usage: vi.fn(async () => ({ context: { percent: 1, tokens: 1000 } })), messages: vi.fn(async () => []) },
  };
  const live = () => timers.filter(t => !t.cancelled);
  const disk = () => [...files.values()].join('');
  const submit = async () => handlers['prompt.submit']($, { text: 'hi', turnId: 't' }, async () => ({ text: 'hi' }));
  const submitDrop = async () => handlers['prompt.submit']($, { text: 'hi', turnId: 't' }, async () => ({ drop: 'fixture' }));
  const complete = async (event: Record<string, unknown> = {}) => handlers['turn.complete']($, { ...event }, async (e: unknown) => e);
  // A main-thread assistant append (door 'model'); `agentId` makes it a child's.
  const append = async (agentId?: string) => handlers['session.append']($,
    { door: 'model', uuid: `u${Math.random()}`, agentId, message: { type: 'assistant', content: [{ kind: 'text', text: '' }] } }, async (e: unknown) => e);
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
  /** Moves Date to the timer's due time (never backwards), then fires it. */
  const fire = async (t: Timer) => {
    vi.setSystemTime(Math.max(Date.now(), t.armedAt + t.ms));
    const wasLive = !t.cancelled; t.fn(); t.cancelled = wasLive ? true : t.cancelled; await flush();
  };
  const setSid = (next: string) => { sid = next; };
  return { $, timers, live, disk, fork, submit, submitDrop, complete, fire, append, advance, setSid };
}

describe('idle warm', () => {
  it('is off by default: no timer, no fork, config 0', async () => {
    expect(resolveHookConfig({}).idleWarmMinutes).toBe(0);
    expect(resolveHookConfig({}).idleWarmMax).toBe(6);
    const h = harness();
    await h.submit();
    await h.complete();
    expect(h.timers).toHaveLength(0);
    expect(h.fork).not.toHaveBeenCalled();
  });

  it('reads the options and rejects a negative interval', () => {
    expect(resolveHookConfig({ idleWarmMinutes: 50, idleWarmMax: 3 })).toMatchObject({ idleWarmMinutes: 50, idleWarmMax: 3 });
    expect(resolveHookConfig({ idleWarmMinutes: -5, idleWarmMax: 0 })).toMatchObject({ idleWarmMinutes: 0, idleWarmMax: 6 });
  });

  it('arms one timer on turn.complete, in milliseconds', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit();
    await h.complete();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(50 * 60_000);
    await h.complete();
    expect(h.live()).toHaveLength(1);
    expect(h.timers).toHaveLength(2);
  });

  it('ignores a subagent turn.complete', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.complete({ agentId: 'child' });
    expect(h.timers).toHaveLength(0);
  });

  it('cancels on prompt.submit and never forks while the turn runs', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.complete();
    const armed = h.timers[0];
    await h.submit();
    expect(armed.cancelled).toBe(true);
    expect(h.live()).toHaveLength(0);
    await h.fire(armed); // a dispatch already in flight when the prompt came
    expect(h.fork).not.toHaveBeenCalled();
  });

  it('does not fork when the timer fires during a running turn it did not cancel', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.complete();
    const armed = h.timers[0];
    // submit marks the turn running; pretend the cancel was lost
    await h.submit();
    armed.cancelled = false;
    await h.fire(armed);
    expect(h.fork).not.toHaveBeenCalled();
  });

  it('sends one fork with the minimal prompt, logs usage, and re-arms', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.complete();
    await h.fire(h.live()[0]);
    expect(h.fork).toHaveBeenCalledTimes(1);
    expect(h.fork).toHaveBeenCalledWith({ prompt: 'Reply with the single word ok.' });
    expect(h.disk()).toMatch(/\[abcdef01\] idle warm 1 after 50 min: cache_read 212345, cache_write 41, out 2\n/);
    expect(h.live()).toHaveLength(1);
  });

  it('stops after idleWarmMax warms per gap, and a new turn starts a new gap', async () => {
    const h = harness({ idleWarmMinutes: 10, idleWarmMax: 2 });
    await h.complete();
    await h.fire(h.live()[0]);
    await h.fire(h.live()[0]);
    expect(h.fork).toHaveBeenCalledTimes(2);
    expect(h.live()).toHaveLength(0);
    expect(h.disk()).toContain('idle warm 2 after 20 min: cache_read 212345');
    await h.submit();
    await h.complete();
    expect(h.live()).toHaveLength(1);
    await h.fire(h.live()[0]);
    expect(h.fork).toHaveBeenCalledTimes(3);
    expect(h.disk()).toContain('idle warm 1 after 10 min');
  });

  it('a prompt that lands during the fork wins the next arm', async () => {
    let release: (v: unknown) => void = () => {};
    const h = harness({ idleWarmMinutes: 50 }, () => new Promise(resolve => { release = resolve; }));
    await h.complete();
    await h.fire(h.live()[0]);
    await h.submit();
    release({ text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } });
    await flush();
    expect(h.live()).toHaveLength(0); // the turn's own turn.complete will arm
    await h.complete();
    expect(h.live()).toHaveLength(1);
  });

  it('swallows a throwing fork, logs once, and stops warming this gap', async () => {
    const h = harness({ idleWarmMinutes: 50 }, async () => { throw new Error('boom secret'); });
    await h.complete();
    await h.fire(h.live()[0]);
    const lines = h.disk().split('\n').filter(l => l.includes('idle warm'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/idle warm 1 failed after 50 min: fork threw/);
    expect(lines[0]).not.toContain('secret');
    expect(h.live()).toHaveLength(0);
  });

  it('logs a null fork (cold snapshot) once and stops', async () => {
    const h = harness({ idleWarmMinutes: 50 }, async () => null);
    await h.complete();
    await h.fire(h.live()[0]);
    expect(h.disk().split('\n').filter(l => l.includes('idle warm'))).toHaveLength(1);
    expect(h.disk()).toContain('fork returned null');
    expect(h.live()).toHaveLength(0);
  });

  it('survives a host without clock.after', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    (h.$.clock as any).after = () => { throw new Error('no timers'); };
    await expect(h.complete()).resolves.toBeDefined();
  });

  it('a turn resets the timer: the old one is cancelled and the new one counts from the turn end', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    const a = h.live()[0];
    h.advance(30 * MIN);
    await h.submit();
    expect(a.cancelled).toBe(true);
    await h.complete();
    const b = h.live()[0];
    expect(b).not.toBe(a);
    expect(b.armedAt - a.armedAt).toBe(30 * MIN);
    await h.fire(a); // the dead timer, even if it still runs
    expect(h.fork).not.toHaveBeenCalled();
    await h.fire(b); // 50 min after the second turn end
    expect(h.fork).toHaveBeenCalledTimes(1);
    expect(h.disk()).toContain('idle warm 1 after 50 min');
  });

  it('an uncancelled early timer re-arms for the remainder instead of pinging', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    const a = h.live()[0];
    h.advance(30 * MIN);
    await h.submit(); await h.complete(); // turn end at +30
    a.cancelled = false; // pretend the cancel was lost
    await h.fire(a); // due at +50, only 20 min idle
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.live().filter(t => t !== a)).toHaveLength(1);
  });

  it('a main-thread append resets the idle clock: no ping at +50, a re-arm for the remainder, a ping later', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    const a = h.live()[0];
    h.advance(40 * MIN);
    await h.append(); // a delivery-started turn: no prompt.submit
    await h.fire(a); // due at +50, idle 10 min
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(40 * MIN); // 50 min need minus 10 min idle
    await h.fire(h.live()[0]); // now 50 min after the append
    expect(h.fork).toHaveBeenCalledTimes(1);
  });

  it('a child append is not activity', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    const a = h.live()[0];
    h.advance(40 * MIN);
    await h.append('child');
    await h.fire(a);
    expect(h.fork).toHaveBeenCalledTimes(1);
  });

  it('no ping before idleWarmMinutes of real idle, a ping after', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    const a = h.live()[0];
    h.advance(49 * MIN); // the host fires nothing yet; if it fired now it would find 49 min of idle
    a.fn(); await flush();
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.live().filter(t => t !== a)).toHaveLength(1);
    await h.fire(h.live().filter(t => t !== a)[0]); // due at 49 + 1 min: 50 min of idle
    expect(h.fork).toHaveBeenCalledTimes(1);
  });

  it('a ping is not activity: the second ping comes 100 min after the turn end', async () => {
    const h = harness({ idleWarmMinutes: 50, idleWarmMax: 3 });
    await h.submit(); await h.complete();
    await h.fire(h.live()[0]);
    expect(h.fork).toHaveBeenCalledTimes(1);
    await h.fire(h.live()[0]);
    expect(h.fork).toHaveBeenCalledTimes(2);
    expect(h.disk()).toContain('idle warm 2 after 100 min');
  });

  it('a clear (new session id) drops the old id timers', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    const a = h.live()[0];
    h.setSid(SID2);
    await h.submit(); // first activity of the new session
    expect(a.cancelled).toBe(true);
    await h.complete();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]).not.toBe(a);
    a.cancelled = false;
    await h.fire(a); // a stale timer must not fork into the new conversation
    expect(h.fork).not.toHaveBeenCalled();
  });

  it('an old-id timer that fires after the id changed, before any activity, does not fork', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    const a = h.live()[0];
    h.setSid(SID2);
    await h.fire(a);
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.live()).toHaveLength(0);
  });

  it('a prompt that lands between turn.complete and its arm wins the next arm', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete(); // the receipt and window reads are warm now
    const done = h.complete();
    await h.submit(); // runs while turn.complete waits on its window read
    await done;
    expect(h.live()).toHaveLength(0); // the new turn's own turn.complete arms
    await h.complete();
    expect(h.live()).toHaveLength(1);
  });

  it('re-arms after a dropped submission, which runs no turn', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.complete();
    const armed = h.timers[0];
    await h.submitDrop();
    expect(armed.cancelled).toBe(true);
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]).not.toBe(armed);
  });
});
