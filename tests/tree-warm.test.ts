import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../hooks/fast-jev.ts';

/** 0.5.12: `<handoffDir>/window.json` may carry idleWarmMinutes / idleWarmMax, read at each arm. */
const SID = 'treewarm0123456789';
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/** armedAt = faked Date.now() at arm time: a ping needs a full interval of real idle (0.5.18). */
type Timer = { ms: number; fn: () => void; cancelled: boolean; armedAt: number };

afterEach(() => { vi.useRealTimers(); });

function harness(options: Record<string, unknown> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T10:00:00Z'));
  let now = 1000;
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const timers: Timer[] = [];
  const handlers: Record<string, Function> = {};
  register(((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any,
    { apiKey: 'fixture', handoffDir: 'F:/h', ...options });
  const put = (path: string, text: string) => { files.set(path, text); mtimes.set(path, ++now); };
  const fork = vi.fn(async () => ({ text: 'ok', usage: {
    input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 212345, cache_creation_input_tokens: 41 } }));
  const $: any = {
    env: { get: async (k: string) => k === 'USERPROFILE' ? 'F:/temp/jev-treewarm' : k === 'DISABLE_AUTO_COMPACT' ? '1' : undefined },
    settings: { read: async () => ({}) },
    fs: {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
      write: async (p: string, t: string) => { files.set(p, t); },
      stat: async (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return { kind: 'file', size: files.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0 };
      },
    },
    store: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    clock: {
      now: async () => now, sleep: async () => {},
      after: (ms: number, fn: () => void) => { const t: Timer = { ms, fn, cancelled: false, armedAt: Date.now() }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    },
    model: { fork },
    http: { fetch: vi.fn() },
    ui: { log: vi.fn(), toast: vi.fn() },
    session: { id: async () => SID, cwd: async () => 'F:/tree', messages: async () => [], usage: vi.fn(async () => ({ context: { percent: 1, tokens: 1000 } })) },
    prompt: { submit: vi.fn(async () => ({})) },
    command: { list: vi.fn(async () => []), run: vi.fn(async () => ({})) },
  };
  const win = 'F:/h/window.json';
  const live = () => timers.filter(t => !t.cancelled);
  const diskLog = () => files.get('F:/temp/jev-treewarm/.claude/fast-jev-compaction.log') ?? '';
  const complete = async () => { await handlers['turn.complete']!($, {}, async (e: unknown) => e); };
  const submit = async () => handlers['prompt.submit']!($, { text: 'hi', turnId: 't' }, async () => ({ text: 'hi' }));
  const drop = async () => handlers['prompt.submit']!($, { text: 'hi', turnId: 't' }, async () => ({ drop: 'fixture' }));
  const fire = async (t: Timer) => { vi.setSystemTime(Math.max(Date.now(), t.armedAt + t.ms)); t.fn(); t.cancelled = true; await flush(); };
  const lines = (needle: string) => diskLog().split('\n').filter(l => l.includes(needle));
  return { put, win, live, timers, fork, complete, submit, drop, fire, diskLog, lines, files };
}

describe('per-tree idle warm (window.json)', () => {
  it('window.json turns the warm on while the option is off, with its own interval', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ idleWarmMinutes: 50, idleWarmMax: 2 }));
    await h.submit(); await h.complete();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(50 * 60_000);
    await h.fire(h.live()[0]);
    await h.fire(h.live()[0]);
    expect(h.fork).toHaveBeenCalledTimes(2);
    expect(h.live()).toHaveLength(0); // idleWarmMax 2 from the file
    expect(h.diskLog()).toContain('idle warm 2 after 100 min: cache_read 212345, cache_write 41, out 2');
  });

  it('no file and option off: no timer', async () => {
    const h = harness();
    await h.submit(); await h.complete();
    expect(h.timers).toHaveLength(0);
  });

  it('idleWarmMinutes 0 in the file turns the warm off for the tree although the option is on', async () => {
    const h = harness({ idleWarmMinutes: 50 });
    await h.submit(); await h.complete();
    expect(h.live()).toHaveLength(1);
    h.put(h.win, JSON.stringify({ idleWarmMinutes: 0 }));
    await h.submit(); await h.complete();
    expect(h.live()).toHaveLength(0);
    expect(h.lines('handoff window')[0]).toContain('idle warm off');
  });

  it('a missing key falls back to the option', async () => {
    const h = harness({ idleWarmMinutes: 40, idleWarmMax: 3 });
    h.put(h.win, JSON.stringify({ idleWarmMax: 1 }));       // minutes from the option
    await h.submit(); await h.complete();
    expect(h.live()[0].ms).toBe(40 * 60_000);
    await h.fire(h.live()[0]);
    expect(h.live()).toHaveLength(0);                         // max 1 from the file
    h.put(h.win, JSON.stringify({ idleWarmMinutes: 25 }));  // max from the option (3)
    await h.submit(); await h.complete();
    expect(h.live()[0].ms).toBe(25 * 60_000);
    await h.fire(h.live()[0]); await h.fire(h.live()[0]); await h.fire(h.live()[0]);
    expect(h.live()).toHaveLength(0);
    expect(h.fork).toHaveBeenCalledTimes(4);
  });

  it('a handoff-only file leaves the option warm in force', async () => {
    const h = harness({ idleWarmMinutes: 30 });
    h.put(h.win, JSON.stringify({ handoffAt: 200000 }));
    await h.submit(); await h.complete();
    expect(h.live()[0].ms).toBe(30 * 60_000);
    expect(h.lines('handoff window')[0]).not.toContain('idle warm');
  });

  it('a bad value rejects the whole file: warning, option stays', async () => {
    for (const bad of [{ idleWarmMinutes: -5 }, { idleWarmMax: -1 }, { idleWarmMinutes: '50' }, { idleWarmMinutes: 50, idleWarmMax: 'x' }]) {
      const h = harness({ idleWarmMinutes: 30 });
      h.put(h.win, JSON.stringify({ handoffAt: 200000, ...bad }));
      await h.submit(); await h.complete(); await h.complete();
      expect(h.live()[0].ms).toBe(30 * 60_000);
      expect(h.lines('window.json ignored (')).toHaveLength(1);
      expect(h.lines('handoff window ')).toHaveLength(0);
    }
    const h = harness();
    h.put(h.win, JSON.stringify({ idleWarmMinutes: -5 }));
    await h.submit(); await h.complete();
    expect(h.timers).toHaveLength(0);
    expect(h.lines('window.json ignored (')[0]).toContain('idleWarmMinutes -5 is negative');
  });

  it('an edit is picked up at the next turn.complete, and disappearing returns to the option', async () => {
    const h = harness();
    await h.submit(); await h.complete();
    expect(h.timers).toHaveLength(0);
    h.put(h.win, JSON.stringify({ idleWarmMinutes: 50 }));
    await h.submit(); await h.complete();
    expect(h.live()[0].ms).toBe(50 * 60_000);
    h.put(h.win, JSON.stringify({ idleWarmMinutes: 20 }));
    await h.submit(); await h.complete();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(20 * 60_000);
    h.files.delete(h.win);
    await h.submit(); await h.complete();
    expect(h.live()).toHaveLength(0);
    expect(h.lines('handoff window back to options')).toHaveLength(1);
  });

  it('the window-change line names the warm setting', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 150000, handoffForceAt: 200000, idleWarmMinutes: 50, idleWarmMax: 2, arm: 'block1 W1 S1' }));
    await h.submit(); await h.complete(); await h.complete();
    const lines = h.lines('handoff window');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('handoff window 150000/200000, idle warm 50 min x2 from window.json (arm block1 W1 S1)');
  });

  it('a dropped submission arms with the per-tree value too', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ idleWarmMinutes: 15 }));
    await h.complete();
    const armed = h.live()[0];
    await h.drop();
    expect(armed.cancelled).toBe(true);
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(15 * 60_000);
  });
});
