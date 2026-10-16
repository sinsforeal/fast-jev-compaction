import { describe, expect, it, vi } from 'vitest';
import { register, resolveHookConfig } from '../hooks/fast-jev.ts';

const SID = 'abcdef0123456789';
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

type Timer = { ms: number; fn: () => void; cancelled: boolean };

function harness(options: Record<string, unknown> = {}, forkImpl?: () => Promise<any>) {
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
      after: (ms: number, fn: () => void) => { const t: Timer = { ms, fn, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    },
    model: { fork },
    ui: { log: vi.fn(), toast: vi.fn() },
    session: { id: async () => SID, usage: vi.fn(async () => ({ context: { percent: 1, tokens: 1000 } })), messages: vi.fn(async () => []) },
  };
  const live = () => timers.filter(t => !t.cancelled);
  const disk = () => [...files.values()].join('');
  const submit = async () => handlers['prompt.submit']($, { text: 'hi', turnId: 't' }, async () => ({ text: 'hi' }));
  const submitDrop = async () => handlers['prompt.submit']($, { text: 'hi', turnId: 't' }, async () => ({ drop: 'fixture' }));
  const complete = async (event: Record<string, unknown> = {}) => handlers['turn.complete']($, { ...event }, async (e: unknown) => e);
  const fire = async (t: Timer) => { const wasLive = !t.cancelled; t.fn(); t.cancelled = wasLive ? true : t.cancelled; await flush(); };
  return { $, timers, live, disk, fork, submit, submitDrop, complete, fire };
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
    const t0 = h.live()[0]; t0.cancelled = true; t0.fn();
    await flush();
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
