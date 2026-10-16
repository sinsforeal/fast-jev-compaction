import { describe, expect, it, vi } from 'vitest';
import { handoffStep, stateKey, type HandoffHost } from '../hooks/handoff.ts';
import { newestColor, transcriptPath } from '../hooks/color-carry.ts';

const OLD = 'old-session';
const NEW = 'new-session';
const OLD_JSONL = 'H:/.claude/projects/F--tree/old-session.jsonl';
const NEW_JSONL = 'H:/.claude/projects/F--tree/new-session.jsonl';
const rec = (color: string, sid = OLD) => JSON.stringify({ type: 'agent-color', agentColor: color, sessionId: sid });

/** A host holding a complete handoff for OLD; `scan` is what grep/findstr prints for the transcript. */
function setup(opts: { scan?: { exitCode: number; stdout?: string } | Error; listed?: string[]; colorRun?: Error } = {}) {
  let sid = OLD;
  const files = new Map<string, string>([[`F:/h/${OLD}/latest.md`, `# ${OLD}\nCOMPLETE\n`]]);
  const logs: string[] = [];
  const calls: string[] = [];
  const store = new Map<string, unknown>([[stateKey(OLD), { forcedOrders: 1, clearFailures: 0, orderAt: 1 }]]);
  const host = {
    session: { id: async () => sid },
    clock: { now: async () => 5, sleep: async () => {} },
    fs: {
      exists: async (p: string) => files.has(p),
      read: vi.fn(async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; }),
      write: vi.fn(async (p: string, t: string) => { files.set(p, t); }),
      stat: async (p: string) => ({ kind: 'file', size: files.get(p)?.length ?? 0, mtimeMs: 10 }),
    },
    store: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
    },
    prompt: { submit: vi.fn(async ({ text }: { text: string }) => { calls.push(`submit:${text.slice(0, 14)}`); }) },
    command: {
      list: async () => ['clear', ...(opts.listed ?? ['color'])].map(name => ({ name })),
      run: vi.fn(async ({ command, args }: { command: string; args?: string }) => {
        if (command === 'color' && opts.colorRun) throw opts.colorRun;
        calls.push(`run:${command}${args ? ` ${args}` : ''}`);
        if (command === 'clear') sid = NEW;
        return {};
      }),
    },
    process: { run: vi.fn(async (argv: readonly string[]) => {
      if (argv.some(a => a === 'grep' || a === 'findstr')) {
        if (opts.scan instanceof Error) throw opts.scan;
        return opts.scan ?? { exitCode: 1, stdout: '' };
      }
      return { exitCode: 1 };
    }) },
  };
  const pending: Promise<void>[] = [];
  const step = async () => {
    await handoffStep(host as unknown as HandoffHost, {
      sessionId: OLD, visible: 1, thresholdsEnabled: true,
      config: { handoffAt: 250_000, handoffForceAt: 300_000, handoffDir: 'F:/h' },
      log: async t => { logs.push(t); },
      detach: work => { pending.push(work()); },
      transcriptPathFor: async id => (id === OLD ? OLD_JSONL : NEW_JSONL),
    });
    await Promise.all(pending);
  };
  return { host, files, logs, calls, store, step };
}

describe('color carry across the handoff clear', () => {
  it('re-applies the newest color with /color after the clear and before the resume order', async () => {
    const s = setup({ scan: { exitCode: 0, stdout: `${rec('blue')}\n${rec('red')}\n` } });
    await s.step();
    expect(s.calls).toEqual(['run:clear', 'run:color red', 'submit:HANDOFF RESUME']);
    expect(s.host.process.run.mock.calls[0]![0].at(-1)).toContain('old-session.jsonl');
    expect(s.files.has(NEW_JSONL)).toBe(false);
  });

  it('submits nothing when the transcript holds no color record', async () => {
    const s = setup({ scan: { exitCode: 1, stdout: '' } });
    await s.step();
    expect(s.calls).toEqual(['run:clear', 'submit:HANDOFF RESUME']);
  });

  it('scans a large transcript through the child process, never reading it into the plugin', async () => {
    const s = setup({ scan: { exitCode: 0, stdout: `${rec('green')}\n${rec('purple')}\n` } });
    s.files.set(OLD_JSONL, 'x'.repeat(5_000_000));
    await s.step();
    expect(s.host.fs.read.mock.calls.map(c => c[0])).not.toContain(OLD_JSONL);
    expect(s.calls).toContain('run:color purple');
  });

  it('newestColor takes the last record and ignores lines that only mention the word', () => {
    const out = [rec('blue'), rec('red'), '{"type":"user","text":"agent-color blue"}', 'agent-color noise'].join('\n');
    expect(newestColor(out)?.agentColor).toBe('red');
    expect(newestColor('')).toBeUndefined();
  });

  it.each([
    ['a thrown scan', new Error('spawn failed')],
    ['a failing scan exit', { exitCode: 2, stdout: '' }],
  ] as const)('%s is logged and the handoff still clears and resumes', async (_name, scan) => {
    const s = setup({ scan });
    await s.step();
    expect(s.calls).toEqual(['run:clear', 'submit:HANDOFF RESUME']);
    expect(s.logs.some(l => l.includes('could not read the session color'))).toBe(true);
  });

  it('never writes the new transcript when /color is not listed; logs instead', async () => {
    const s = setup({ scan: { exitCode: 0, stdout: `${rec('red')}\n` }, listed: [] });
    await s.step();
    expect(s.calls).toEqual(['run:clear', 'submit:HANDOFF RESUME']);
    expect(s.files.has(NEW_JSONL)).toBe(false);
    expect(s.host.fs.write.mock.calls.some((c: unknown[]) => c[0] === NEW_JSONL)).toBe(false);
    expect(s.logs.some(l => l.includes('not carried'))).toBe(true);
  });

  it('a failing /color logs, writes nothing and cannot break the handoff', async () => {
    const s = setup({ scan: { exitCode: 0, stdout: `${rec('red')}\n` }, colorRun: new Error('refused') });
    await s.step();
    expect(s.calls).toEqual(['run:clear', 'submit:HANDOFF RESUME']);
    expect(s.host.fs.write.mock.calls.some((c: unknown[]) => c[0] === NEW_JSONL)).toBe(false);
    expect(s.logs.some(l => l.includes('color not carried'))).toBe(true);
  });

  it('builds the transcript path from home, cwd slug and session id', () => {
    expect(transcriptPath('C:\\Users\\a', 'F:\\REPS2\\Meta_Orchestrator', 'abc'))
      .toBe('C:\\Users\\a/.claude/projects/F--REPS2-Meta-Orchestrator/abc.jsonl');
  });
});
