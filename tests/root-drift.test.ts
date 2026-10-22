import { describe, expect, it, vi } from 'vitest';
import { register, createHandoffRoots } from '../hooks/fast-jev.ts';
import { findTreeRoot, handoffStep, normalizeRoot, type HandoffHost } from '../hooks/handoff.ts';

// 0.5.15: the handoff root never sits inside var/handoffs (incident 15635d41, Mechanism_Analyst, 2026-10-22).
const MA = 'F:\\REPS2\\Mechanism_Analyst';
const MA_BAD = `${MA}\\var\\handoffs`;
const SID = '15635d41-0000-4000-8000-000000000000';
const NEW = '9a9a9a9a-0000-4000-8000-0000000000aa';
const noWarn = async () => {};

describe('normalizeRoot', () => {
  it('cuts the exact incident path back to the tree', () => {
    expect(normalizeRoot(MA_BAD)).toBe(MA);
  });
  it('cuts any depth under var/handoffs, both separators, any case', () => {
    expect(normalizeRoot(`${MA_BAD}\\${SID}`)).toBe(MA);
    expect(normalizeRoot(`${MA_BAD}\\${SID}\\deeper\\still`)).toBe(MA);
    expect(normalizeRoot('F:/tree_a/var/handoffs/')).toBe('F:/tree_a');
    expect(normalizeRoot('F:/tree_a/VAR/Handoffs/x')).toBe('F:/tree_a');
    expect(normalizeRoot('/home/u/t/var/handoffs')).toBe('/home/u/t');
  });
  it('leaves other paths and lookalikes alone', () => {
    expect(normalizeRoot(MA)).toBe(MA);
    expect(normalizeRoot('F:/tree_a/var/handoffs_old')).toBe('F:/tree_a/var/handoffs_old');
    expect(normalizeRoot('F:/tree_a/var')).toBe('F:/tree_a/var');
    expect(normalizeRoot(undefined)).toBeUndefined();
  });
});

describe('findTreeRoot', () => {
  const fsOf = (...dirs: string[]) => async (p: string) => dirs.includes(p);
  it('prefers the nearest ancestor that holds var/handoffs', async () => {
    expect(await findTreeRoot(`${MA}\\src\\deep`, fsOf(`${MA}\\var\\handoffs`))).toBe(MA);
  });
  it('falls back to the git toplevel', async () => {
    expect(await findTreeRoot('F:/r/sub/dir', fsOf('F:/r/.git'))).toBe('F:/r');
  });
  it('normalises first, and keeps the cwd when nothing is found or the probe throws', async () => {
    expect(await findTreeRoot(MA_BAD, fsOf())).toBe(MA);
    expect(await findTreeRoot('F:/x/y', fsOf())).toBe('F:/x/y');
    expect(await findTreeRoot('F:/x/y', async () => { throw new Error('boom'); })).toBe('F:/x/y');
  });
});

describe('handoff roots', () => {
  it('a first capture inside var/handoffs resolves to the tree, not the nested path', async () => {
    const roots = createHandoffRoots();
    const dir = await roots.resolve(MA_BAD, SID, 'var/handoffs', noWarn);
    expect(dir).toBe(`${MA}\\var/handoffs`);
    expect(dir).not.toContain('handoffs\\var');
  });
  it('a first capture from a subfolder takes the tree root when a probe sees var/handoffs', async () => {
    const roots = createHandoffRoots();
    roots.useProbe(async p => p === `${MA}\\var\\handoffs`);
    expect(await roots.resolve(`${MA}\\src`, SID, 'var/handoffs', noWarn)).toBe(`${MA}\\var/handoffs`);
    expect(roots.rootOf(SID)).toBe(MA);
  });
  it('heals a stored bad root on load: the live Mechanism_Analyst session', async () => {
    const roots = createHandoffRoots([[SID, MA_BAD]]);
    const warn = vi.fn(async () => {});
    const dir = await roots.resolve(MA, SID, 'var/handoffs', warn);
    expect(dir).toBe(`${MA}\\var/handoffs`);
    expect(roots.rootOf(SID)).toBe(MA);
    expect(warn).not.toHaveBeenCalled();
  });
  it('a clear that changes the id gives the new id the old root, even over a drifted capture', async () => {
    const roots = createHandoffRoots();
    await roots.resolve(MA, SID, '.', noWarn);
    await roots.resolve('F:\\REPS2\\Other\\drift', NEW, '.', noWarn); // new id's first event came first
    roots.seed(SID, NEW);
    expect(await roots.resolve('F:\\REPS2\\Other\\drift', NEW, 'var/handoffs', noWarn)).toBe(`${MA}\\var/handoffs`);
  });
  it('seeding from a stored bad root hands over the healed one', async () => {
    const roots = createHandoffRoots([[SID, MA_BAD]]);
    roots.seed(SID, NEW);
    expect(roots.rootOf(NEW)).toBe(MA);
  });
  it('still warns once for a real drift', async () => {
    const roots = createHandoffRoots();
    const warn = vi.fn(async () => {});
    await roots.resolve('F:/a', SID, '.', warn);
    await roots.resolve('F:/b', SID, '.', warn);
    await roots.resolve('F:/b', SID, '.', warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---- defence in depth: handoffStep accepts <treeRoot>/var/handoffs/<sid>/latest.md --------------------
function stepHost(files: Map<string, string>, id = SID) {
  const mtimes = new Map<string, number>();
  const logs: string[] = [];
  const host: HandoffHost = {
    session: { id: async () => id },
    clock: { now: async () => 1000, sleep: async () => {} },
    fs: {
      exists: async p => files.has(p),
      read: async p => files.get(p) ?? '',
      write: async (p, t) => { files.set(p, t); mtimes.set(p, 5000); },
      stat: async p => ({ kind: 'file', size: (files.get(p) ?? '').length, mtimeMs: mtimes.get(p) ?? 5000 }),
    },
    store: { get: async () => ({ forcedOrders: 1, clearFailures: 0, orderAt: 1000 }), set: async () => {}, delete: async () => {} },
    prompt: { submit: vi.fn(async () => ({})) },
    command: { run: vi.fn(async () => ({})), list: async () => [{ name: 'clear' }] },
    process: { run: async () => ({ exitCode: 1 }) },
  };
  return { host, logs, files };
}
const good = `# Handoff for session ${SID}\nbody\nCOMPLETE\n`;
const run = async (h: ReturnType<typeof stepHost>, dir: string, treeRoot?: string) => {
  await handoffStep(h.host, {
    sessionId: SID, visible: 100, thresholdsEnabled: true,
    config: { handoffAt: 90_000, handoffForceAt: 100_000, handoffDir: dir },
    log: async t => { h.logs.push(t); }, detach: work => { void work(); }, treeRoot,
  });
  await new Promise(r => setTimeout(r, 20));
};

describe('missing latest.md falls back to the tree root', () => {
  it('the exact incident: expected ...\\var\\handoffs\\var/handoffs\\<sid>\\latest.md, written at ...\\var\\handoffs\\<sid>\\latest.md', async () => {
    const files = new Map<string, string>([[`${MA_BAD}\\${SID}\\latest.md`, good]]);
    const h = stepHost(files);
    await run(h, `${MA_BAD}\\var/handoffs`);
    expect(h.host.command.run).toHaveBeenCalledTimes(1);
    const lines = h.logs.filter(l => l.includes('accepting the complete'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${MA_BAD}\\${SID}\\latest.md`);
    expect(h.host.prompt.submit).toHaveBeenCalledWith({ text: expect.stringContaining('HANDOFF RESUME') });
    expect(h.host.prompt.submit).toHaveBeenCalledWith({ text: expect.stringContaining(`${MA_BAD}\\${SID}\\latest.md`) });
  });
  it('uses the passed tree root when the dir itself carries no var/handoffs', async () => {
    const files = new Map<string, string>([[`F:/tree_a/var/handoffs/${SID}/latest.md`, good]]);
    const h = stepHost(files);
    await run(h, 'F:/elsewhere/handoffs', 'F:/tree_a');
    expect(h.host.command.run).toHaveBeenCalledTimes(1);
    expect(h.logs.some(l => l.includes('accepting the complete'))).toBe(true);
  });
  it('does not accept a file with the wrong header or no COMPLETE', async () => {
    const files = new Map<string, string>([[`F:/tree_a/var/handoffs/${SID}/latest.md`, `# Handoff for session someone-else\nbody\nCOMPLETE\n`]]);
    const h = stepHost(files);
    await run(h, 'F:/tree_a/var/handoffs/var/handoffs');
    files.set(`F:/tree_a/var/handoffs/${SID}/latest.md`, `# Handoff for session ${SID}\nbody\n`);
    await run(h, 'F:/tree_a/var/handoffs/var/handoffs');
    expect(h.host.command.run).not.toHaveBeenCalled();
    expect(h.logs.some(l => l.includes('accepting the complete'))).toBe(false);
  });
  it('a stale expected file (older than the order) also falls back', async () => {
    const files = new Map<string, string>([[`F:/tree_a/var/handoffs/${SID}/latest.md`, good]]);
    const h = stepHost(files);
    const stale = 'F:/tree_a/var/handoffs/var/handoffs';
    files.set(`${stale}/${SID}/latest.md`, good);
    const base = h.host.fs.stat;
    h.host.fs.stat = async p => p.startsWith(stale) ? { kind: 'file', size: good.length, mtimeMs: 10 } : base(p);
    await run(h, stale);
    expect(h.host.command.run).toHaveBeenCalledTimes(1);
    expect(h.logs.some(l => l.includes('older than the order') && l.includes('accepting the complete'))).toBe(true);
  });
});

// ---- end to end through the hooks ---------------------------------------------------------------------
function harness(cwd: () => string, sid: () => string) {
  const handlers: Record<string, Function> = {};
  register(((name: string, ...a: any[]) => { handlers[name] = a.at(-1); }) as any, { apiKey: 'f', preserveRecentMessages: 1, minReductionRatio: 1, handoffForceAt: 100000, handoffAt: 90000 });
  const files = new Map<string, string>(); const logs: string[] = []; const store = new Map<string, unknown>();
  const $: any = { env: { get: async (k: string) => k === 'DISABLE_AUTO_COMPACT' ? '1' : 'F:/temp/x' }, settings: { read: async () => ({}) },
    fs: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p) ?? '', write: async (p: string, t: string) => { files.set(p, t); }, stat: async () => ({ kind: 'file', size: 1, mtimeMs: 5000 }) },
    http: { fetch: vi.fn() }, clock: { sleep: async () => {}, now: async () => 1000 }, ui: { log: (s: string) => logs.push(s), toast: vi.fn() },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v); }, delete: async (k: string) => { store.delete(k); } },
    prompt: { submit: vi.fn(async () => ({})) }, command: { run: vi.fn(async () => ({})), list: async () => [{ name: 'clear' }] },
    session: { id: async () => sid(), cwd: async () => cwd(), usage: vi.fn(async () => ({ context: { tokens: 200000, percent: 1 } })), messages: async () => [], compact: vi.fn(async () => ({ messages: [] })) },
    process: { run: async () => ({ exitCode: 1 }) } };
  return { handlers, files, logs, $ };
}
describe('hooks end to end', () => {
  const turn = async (h: ReturnType<typeof harness>) => { await h.handlers['turn.complete'](h.$, {}, async (e: any) => e); await new Promise(r => setTimeout(r, 10)); };
  it('a session whose first cwd is ...\\var\\handoffs expects latest.md under the tree, never nested', async () => {
    const h = harness(() => MA_BAD, () => SID);
    await turn(h);
    const want = h.logs.filter(l => l.includes('handoff order NOW')).map(l => /expecting (\S+)/.exec(l)![1]);
    expect(want).toEqual([`${MA}\\var/handoffs/${SID}/latest.md`]);
    expect(h.logs.some(l => /handoffs[\\/]+var[\\/]+handoffs/.test(l))).toBe(false);
  });
  it('the new id after a clear keeps the old root when the cwd drifted into var/handoffs', async () => {
    let id = SID; let cwd = MA;
    const h = harness(() => cwd, () => id);
    h.$.command.run = vi.fn(async () => { id = NEW; cwd = MA_BAD; return {}; });
    await turn(h);
    h.files.set(`${MA}\\var/handoffs/${SID}/latest.md`, good);
    await turn(h);
    expect(h.$.command.run).toHaveBeenCalledTimes(1);
    await turn(h);
    const want = h.logs.filter(l => l.includes('handoff order NOW')).map(l => /expecting (\S+)/.exec(l)![1]);
    expect(want.at(-1)).toBe(`${MA}\\var/handoffs/${NEW}/latest.md`);
  });
});
