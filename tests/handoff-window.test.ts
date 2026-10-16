import { describe, expect, it, vi } from 'vitest';
import { register } from '../hooks/fast-jev.ts';

/** 0.5.10: `<handoffDir>/window.json` overrides handoffAt/handoffForceAt per tree, re-read by mtime. */
let sequence = 0;
function harness(options = {}) {
  const sid = `window-session-${++sequence}`;
  let tokens: number | undefined = 210_000;
  let now = 1000;
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const logs: string[] = [];
  const pauses: (() => void)[] = [];
  const handlers: Record<string, Function> = {};
  register(((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any,
    { apiKey: 'fixture', preserveRecentMessages: 1, targetVisibleTokens: 0, handoffDir: 'F:/h', ...options });
  const put = (path: string, text: string, at = ++now) => { files.set(path, text); mtimes.set(path, at); };
  const store = new Map<string, unknown>();
  const $: any = {
    env: { get: vi.fn(async (name: string) => name === 'DISABLE_AUTO_COMPACT' ? '1' : name === 'USERPROFILE' ? 'F:/temp/jev-window' : undefined) },
    settings: { read: async () => ({}) },
    fs: {
      exists: async (path: string) => files.has(path),
      read: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; }),
      write: vi.fn(async (path: string, text: string) => { put(path, text); }),
      stat: vi.fn(async (path: string) => {
        if (!files.has(path)) throw new Error('ENOENT');
        return { kind: 'file', size: files.get(path)!.length, mtimeMs: mtimes.get(path) ?? 0 };
      }),
    },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); },
      delete: async (key: string) => { store.delete(key); },
    },
    clock: { now: async () => now, sleep: vi.fn(() => new Promise<void>(resolve => pauses.push(resolve))) },
    http: { fetch: vi.fn() },
    ui: { log: vi.fn((text: string) => { logs.push(text); }), toast: vi.fn() },
    session: {
      id: async () => sid, cwd: async () => 'F:/tree', messages: async () => [],
      usage: vi.fn(async () => ({ context: { tokens, percent: 0 } })),
      compact: vi.fn(async () => ({ skip: 'fixture not due' })),
    },
    prompt: { submit: vi.fn(async () => ({})) },
    command: { list: vi.fn(async () => [{ name: 'clear' }]), run: vi.fn(async () => ({})) },
    process: { run: vi.fn(async (argv: string[]) => {
      const norm = (path: string) => path.replace(/\\/g, '/');
      if (argv.some(arg => arg === 'move' || arg === 'mv')) {
        const [from, to] = argv.slice(-2).map(norm);
        if (!files.has(from!)) return { exitCode: 1 };
        put(to!, files.get(from!)!); files.delete(from!);
      } else if (argv.some(arg => arg === 'del' || arg === 'rm')) files.delete(norm(argv.at(-1)!));
      else return { exitCode: 1 };
      return { exitCode: 0 };
    }) },
  };
  const turn = async () => {
    await handlers['turn.complete']!($, {}, async (out: unknown) => out);
    for (const resume of pauses.splice(0)) resume();
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const win = 'F:/h/window.json';
  const diskLog = () => files.get('F:/temp/jev-window/.claude/fast-jev-compaction.log') ?? '';
  const windowLines = () => diskLog().split('\n').filter(l => l.includes('handoff window'));
  const warnLines = () => diskLog().split('\n').filter(l => l.includes('window.json ignored ('));
  const windowReads = () => $.fs.read.mock.calls.filter(([p]: [string]) => p === win).length;
  const windowStats = () => $.fs.stat.mock.calls.filter(([p]: [string]) => p === win).length;
  return { $, files, put, turn, win, logs, diskLog, windowLines, warnLines, windowReads, windowStats, sid,
    marker: () => JSON.parse(files.get(`F:/h/${sid}/order.json`)!),
    setTokens: (value: number | undefined) => { tokens = value; } };
}

describe('handoff window.json', () => {
  it('absent file: options win, no log noise', async () => {
    const h = harness();
    await h.turn();
    expect(h.$.prompt.submit).not.toHaveBeenCalled();
    expect(h.windowLines()).toEqual([]);
    expect(h.warnLines()).toEqual([]);
    h.setTokens(260_000); await h.turn();
    expect(h.marker()).toMatchObject({ order: 'soon', limit: 250000, window: '250000/300000 from options' });
  });

  it('valid file: lowers the write limit, logs the window once, tags the order', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 200000, handoffForceAt: 250000, arm: 'B', until: '2026-10-17T01:00' }));
    await h.turn();
    expect(h.marker()).toMatchObject({ order: 'soon', tokens: 210000, limit: 200000, window: '200000/250000 from window.json (arm B)' });
    expect(h.windowLines()).toHaveLength(1);
    expect(h.windowLines()[0]).toContain('handoff window 200000/250000 from window.json (arm B)');
    expect(h.windowLines()[0]).toContain('until 2026-10-17T01:00');
    const soon = h.logs.concat(h.diskLog().split('\n')).find(l => l.includes('handoff order SOON'))!;
    expect(soon).toContain('window window.json (arm B)');
  });

  it('valid file without arm is labelled window.json', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 200000 }));
    await h.turn();
    expect(h.windowLines()[0]).toContain('handoff window 200000/300000 from window.json');
    expect(h.marker().window).toBe('200000/300000 from window.json');
  });

  it('malformed JSON: ignored, one warning per mtime, options keep deciding', async () => {
    const h = harness();
    h.put(h.win, '{ not json');
    await h.turn(); await h.turn(); await h.turn();
    expect(h.$.prompt.submit).not.toHaveBeenCalled();
    expect(h.warnLines()).toHaveLength(1);
    expect(h.warnLines()[0]).toContain('not valid JSON');
    expect(h.windowLines()).toEqual([]);
    // a new mtime with the same bad text warns again, once
    h.put(h.win, '{ still not json');
    await h.turn(); await h.turn();
    expect(h.warnLines()).toHaveLength(2);
  });

  it('non-number values are ignored with a warning', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: '200000', handoffForceAt: 250000 }));
    await h.turn();
    expect(h.$.prompt.submit).not.toHaveBeenCalled();
    expect(h.warnLines()).toHaveLength(1);
    expect(h.warnLines()[0]).toContain('handoffAt is not a number');
  });

  it('handoffAt below 50000: ignored, warned, options keep deciding', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 40000, handoffForceAt: 60000 }));
    await h.turn(); await h.turn();
    expect(h.$.prompt.submit).not.toHaveBeenCalled();
    expect(h.warnLines()).toHaveLength(1);
    expect(h.warnLines()[0]).toContain('below 50000');
    expect(h.windowLines()).toEqual([]);
  });

  it('handoffAt exactly 50000 is accepted', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 50000, handoffForceAt: 90000 }));
    h.setTokens(60_000); await h.turn();
    expect(h.marker()).toMatchObject({ order: 'soon', limit: 50000 });
  });

  it('handoffForceAt under handoffAt is raised to handoffAt', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 200000, handoffForceAt: 100000 }));
    await h.turn();
    // 210000 is past the raised force limit of 200000, so the first order is NOW
    expect(h.marker()).toMatchObject({ order: 'now', limit: 200000, window: '200000/200000 from window.json' });
    expect(h.windowLines()[0]).toContain('handoff window 200000/200000');
  });

  it('mtime cache: an unchanged file is stat-ed each turn but parsed once', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 200000, handoffForceAt: 250000 }));
    await h.turn(); await h.turn(); await h.turn();
    expect(h.windowReads()).toBe(1);
    expect(h.windowStats()).toBeGreaterThanOrEqual(3);
    h.put(h.win, JSON.stringify({ handoffAt: 220000, handoffForceAt: 250000 }));
    await h.turn();
    expect(h.windowReads()).toBe(2);
  });

  it('logs a change once: appears, changes, disappears', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 200000, handoffForceAt: 250000, arm: 'B' }));
    await h.turn(); await h.turn();
    expect(h.windowLines()).toHaveLength(1);
    h.put(h.win, JSON.stringify({ handoffAt: 220000, handoffForceAt: 260000, arm: 'C' }));
    await h.turn(); await h.turn();
    expect(h.windowLines()).toHaveLength(2);
    expect(h.windowLines()[1]).toContain('handoff window 220000/260000 from window.json (arm C)');
    h.files.delete(h.win);
    await h.turn(); await h.turn();
    expect(h.windowLines()).toHaveLength(3);
    expect(h.windowLines()[2]).toContain('handoff window back to options 250000/300000');
  });

  it('a file that turns invalid after a good one falls back to the options and says so', async () => {
    const h = harness();
    h.put(h.win, JSON.stringify({ handoffAt: 200000, handoffForceAt: 250000 }));
    await h.turn();
    h.put(h.win, 'garbage');
    await h.turn();
    expect(h.warnLines()).toHaveLength(1);
    expect(h.windowLines().at(-1)).toContain('back to options 250000/300000');
  });
});
