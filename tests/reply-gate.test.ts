import { describe, expect, it, vi } from 'vitest';
import { handoffStep, stateKey, sessionFile, type HandoffHost, type StepContext } from '../hooks/handoff.ts';
import {
  analyzeTail, classifyUser, gateWait, parseTail, readTail, readTailNode, slimLine, TAIL_HELPER_PS1,
  type NodeFsLike, type Slim, type TailHost,
} from '../hooks/reply-gate.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

// Lines shaped like the real transcript records (Claude Code 2.1.3xx, read 2026-11-16).
const userLine = (t: number, origin: object | undefined, text: string, meta = false): string => JSON.stringify({
  parentUuid: 'p', isSidechain: false, ...(meta ? { isMeta: true } : {}), type: 'user', ...(origin ? { origin } : {}),
  message: { role: 'user', content: text }, timestamp: iso(t),
});
const his = (t: number, text = 'do the thing'): string => userLine(t, { kind: 'human' }, text);
const channel = (t: number, server: string): string => userLine(t, { kind: 'channel', server }, `<channel source="${server}" msg_id="1">hi</channel>`, true);
const taskNote = (t: number): string => userLine(t, { kind: 'task-notification', producer: 'session-task', runId: 'r1' }, '<task-notification>done</task-notification>');
const pluginPrompt = (t: number): string => userLine(t, { kind: 'plugin', name: 'fast-jev-compaction' }, 'HANDOFF NOW: write the file');
const companion = (t: number): string => userLine(t, undefined, 'Stop hook feedback: keep going', true);
const interrupt = (t: number): string => userLine(t, undefined, '[Request interrupted by user]');
const reply = (t: number, text = 'done'): string => JSON.stringify({
  type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: iso(t),
});
const toolResult = (t: number): string => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'big' }] }, timestamp: iso(t),
});
const end = (t: number): string => JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: iso(t) });

/** A node:fs stand-in over an in-memory jsonl, so readTailNode runs for real. */
function memFs(get: () => string): NodeFsLike {
  const bytes = (): Uint8Array => new TextEncoder().encode(get());
  return {
    openSync: () => 1,
    fstatSync: () => ({ size: bytes().length }),
    readSync: (_fd, buf, off, len, pos) => { const b = bytes(); const n = Math.max(0, Math.min(len, b.length - pos)); buf.set(b.subarray(pos, pos + n), off); return n; },
    closeSync: () => {},
  };
}

let sequence = 0;

type Rig = ReturnType<typeof rig>;

function rig(initial: string[], options: { minMs?: number; unreadable?: boolean } = {}) {
  const sid = `gate-session-${++sequence}`;
  const dir = 'F:/h';
  const lines = [...initial];
  let now = T0;
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const store = new Map<string, unknown>();
  const logs: string[] = [];
  const works: Promise<void>[] = [];
  const latest = sessionFile(dir, sid, 'latest.md');
  const good = `# Handoff for session ${sid}\nbody\nCOMPLETE\n`;
  const state: { onSleep?: (at: number) => void; clearedAt?: number } = {};
  const put = (path: string, text: string, at: number): void => { files.set(path, text); mtimes.set(path, at); };
  const host: HandoffHost = {
    session: { id: async () => sid },
    clock: { now: async () => now, sleep: vi.fn(async (ms: number) => { now += ms; state.onSleep?.(now); }) },
    fs: {
      exists: async path => files.has(path),
      read: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
      write: async (path, text) => { put(path, text, now); },
      stat: async path => ({ kind: 'file', size: files.get(path)?.length ?? 0, mtimeMs: mtimes.get(path) ?? 0 }),
    },
    store: {
      get: async key => store.get(key),
      set: async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); },
      delete: async key => { store.delete(key); },
    },
    prompt: { submit: vi.fn(async () => ({})) },
    command: { list: async () => [{ name: 'clear' }], run: vi.fn(async () => { state.clearedAt = now; return {}; }) },
    process: { run: vi.fn(async (argv: readonly string[]) => {
      const norm = (path: string): string => path.replace(/\\/g, '/');
      if (argv.some(arg => arg === 'move' || arg === 'mv')) {
        const [from, to] = argv.slice(-2).map(norm);
        if (!files.has(from!)) return { exitCode: 1 };
        put(to!, files.get(from!)!, now); files.delete(from!);
      } else if (argv.some(arg => arg === 'del' || arg === 'rm')) files.delete(norm(argv.at(-1)!));
      else return { exitCode: 1 };
      return { exitCode: 0 };
    }) },
  };
  const tailHost: TailHost = { fs: { write: async () => {} }, process: { run: async () => ({ exitCode: 1 }) } };
  const read = vi.fn(async (): Promise<Awaited<ReturnType<typeof readTail>>> => options.unreadable
    ? { ok: false, error: 'fixture: unreadable' }
    : readTail(tailHost, { path: 'F:/t.jsonl', dir }, memFs(() => lines.join('\n') + '\n')));
  const order = async (at = T0 - MIN, fileAt = T0 - 30_000): Promise<void> => {
    store.set(stateKey(sid), { forcedOrders: 1, clearFailures: 0, orderAt: at });
    put(latest, good, fileAt);
  };
  const step = async (replyGate: StepContext['replyGate'] | null = { minMs: options.minMs ?? 10 * MIN, read }): Promise<void> => {
    await handoffStep(host, {
      sessionId: sid, visible: 5000, thresholdsEnabled: false, repeatForced: true,
      config: { handoffAt: 200000, handoffForceAt: 250000, handoffDir: dir },
      log: async text => { logs.push(text); },
      detach: work => { works.push(work().catch(() => {})); },
      ...(replyGate ? { replyGate } : {}),
    });
    while (works.length) await works.shift();
  };
  return { sid, dir, lines, host, files, mtimes, store, logs, latest, good, put, order, step, read, state,
    setNow: (value: number) => { now = value; }, now: () => now,
    clearCalls: () => (host.command.run as ReturnType<typeof vi.fn>).mock.calls.length,
    submits: () => (host.prompt.submit as ReturnType<typeof vi.fn>).mock.calls.map(call => String((call[0] as { text: string }).text)) };
}

/** A finished turn of his: prompt, reply, end. */
const hisTurn = (promptAt: number, replyAt: number, kind: 'human' | 'feed' | 'pick-assist' = 'human'): string[] => [
  kind === 'human' ? his(promptAt) : channel(promptAt, kind), reply(replyAt), end(replyAt + 500),
];

describe('slimLine and classifyUser on real-shaped lines', () => {
  const kind = (line: string): string => { const rec = slimLine(line); return rec ? (rec.r === 'u' ? classifyUser(rec) : rec.r) : 'dropped'; };

  it('classifies each record kind', () => {
    expect(kind(his(T0))).toBe('his');
    expect(kind(channel(T0, 'peer'))).toBe('other');
    expect(kind(channel(T0, 'feed'))).toBe('his');
    expect(kind(channel(T0, 'pick-assist'))).toBe('his');
    expect(kind(taskNote(T0))).toBe('other');
    expect(kind(pluginPrompt(T0))).toBe('other');
    expect(kind(companion(T0))).toBe('companion');
    expect(kind(interrupt(T0))).toBe('interrupt');
    expect(kind(userLine(T0, undefined, 'an older transcript prompt'))).toBe('his');
    expect(kind(userLine(T0, undefined, '<channel source="feed" reply_id="1">hi</channel>'))).toBe('his');
    expect(kind(reply(T0))).toBe('a');
    expect(kind(end(T0))).toBe('e');
  });

  it('drops tool results, tool-only assistant records and other system records', () => {
    expect(slimLine(toolResult(T0))).toBeUndefined();
    expect(slimLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }] }, timestamp: iso(T0) }))).toBeUndefined();
    expect(slimLine(JSON.stringify({ type: 'system', subtype: 'informational', timestamp: iso(T0) }))).toBeUndefined();
    expect(slimLine('not json at all')).toBeUndefined();
  });

  it('analyzeTail takes the last reply to him and ignores peer, task and plugin turns', () => {
    const recs = parseTail([
      his(T0), reply(T0 + 10_000), end(T0 + 10_500),
      channel(T0 + 20_000, 'peer'), reply(T0 + 25_000), end(T0 + 25_500),
      taskNote(T0 + 30_000), reply(T0 + 31_000), end(T0 + 31_500),
      pluginPrompt(T0 + 40_000), reply(T0 + 41_000), end(T0 + 41_500),
    ].join('\n'));
    const view = analyzeTail(recs);
    expect(view.replyAt).toBe(T0 + 10_000);
    expect(view.lastPromptAt).toBe(T0 + 40_000);
    expect(view.busy).toBe(false);
    expect(gateWait(view, T0 + 10_000 + 4 * MIN, 10 * MIN)).toBe(6 * MIN);
    expect(gateWait(view, T0 + 10_000 + 10 * MIN, 10 * MIN)).toBe(0);
    expect(gateWait(view, T0, 0)).toBe(0);
  });

  it('busy is true while a turn has no end, false after an interrupt', () => {
    expect(analyzeTail(parseTail([his(T0), reply(T0 + 1000)].join('\n'))).busy).toBe(true);
    expect(analyzeTail(parseTail([his(T0), reply(T0 + 1000), interrupt(T0 + 2000)].join('\n'))).busy).toBe(false);
  });
});

describe('readTail', () => {
  const host = (run: TailHost['process']['run']): TailHost => ({ fs: { write: vi.fn(async () => {}) }, process: { run: vi.fn(run) } as TailHost['process'] });

  it('reads with node fs and drops the cut first line when the window starts inside the file', () => {
    const text = [his(T0), reply(T0 + 1000), end(T0 + 1500), his(T0 + 5000), reply(T0 + 6000)].join('\n') + '\n';
    const size = new TextEncoder().encode(text).length;
    const all = readTailNode(memFs(() => text), 'x');
    expect(all.map(r => r.r)).toEqual(['u', 'a', 'e', 'u', 'a']);
    const lastTwo = new TextEncoder().encode(his(T0 + 5000) + '\n' + reply(T0 + 6000) + '\n').length;
    const part = readTailNode(memFs(() => text), 'x', lastTwo + 10); // cuts into the 'end' line, so that line is dropped
    expect(part.map(r => r.r)).toEqual(['u', 'a']);
    expect(size).toBeGreaterThan(lastTwo);
  });

  it('falls back to the child process when node fs throws, and parses its records', async () => {
    const h = host(async () => ({ exitCode: 0, stdout: `{"r":"u","t":"${iso(T0)}","origin":{"kind":"human"},"head":"hi"}\n{"r":"a","t":"${iso(T0 + 5000)}"}\n` }));
    const broken: NodeFsLike = { ...memFs(() => ''), openSync: () => { throw new Error('EACCES'); } };
    const out = await readTail(h, { path: 'F:/t.jsonl', dir: 'F:/h' }, broken);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.records.map(r => r.r)).toEqual(['u', 'a']);
    expect(h.process.run).toHaveBeenCalledTimes(1);
    const argv = (h.process.run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    if (process.platform === 'win32') {
      expect(argv).toContain('Hidden');
      expect(h.fs.write).toHaveBeenCalledWith(expect.stringContaining('reply-tail.ps1'), TAIL_HELPER_PS1);
    }
  });

  it('a helper that fails comes back not ok, never throws', async () => {
    const failing = await readTail(host(async () => ({ exitCode: 2 })), { path: 'x', dir: 'F:/h' }, null);
    expect(failing.ok).toBe(false);
    const throwing = await readTail(host(async () => { throw new Error('spawn denied'); }), { path: 'x', dir: 'F:/h' }, null);
    expect(throwing).toMatchObject({ ok: false, error: expect.stringContaining('spawn denied') });
  });
});

describe('0.5.25 the clear waits for a visible reply to him', () => {
  it('a reply 2 min old holds the clear until it is 10 min old', async () => {
    const replyAt = T0 - 2 * MIN;
    const r = rig(hisTurn(replyAt - 5000, replyAt));
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.state.clearedAt!).toBeGreaterThanOrEqual(replyAt + 10 * MIN);
    expect(r.state.clearedAt!).toBeLessThan(replyAt + 10 * MIN + 31_000);
    expect(r.logs.some(l => /clear held \d+ s: last reply to the user at \d\d:\d\d:\d\d/.test(l))).toBe(true);
    expect(r.logs.some(l => l.startsWith('handoff: clear goes, last reply to the user'))).toBe(true);
    expect(r.submits().at(-1)).toContain('HANDOFF RESUME');
  });

  it('a reply 11 min old clears at once', async () => {
    const replyAt = T0 - 11 * MIN;
    const r = rig(hisTurn(replyAt - 5000, replyAt));
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.state.clearedAt! - T0).toBeLessThan(1000);
    expect(r.logs.some(l => l.includes('clear held'))).toBe(false);
  });

  it('a last turn from a peer channel message clears at once, even seconds old', async () => {
    const r = rig([...hisTurn(T0 - 30 * MIN, T0 - 29 * MIN), channel(T0 - 10_000, 'peer'), reply(T0 - 5000, 'sent'), end(T0 - 4500)]);
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.state.clearedAt! - T0).toBeLessThan(1000);
  });

  it('task notification and plugin prompt turns do not count either', async () => {
    const r = rig([...hisTurn(T0 - 30 * MIN, T0 - 29 * MIN), taskNote(T0 - 20_000), reply(T0 - 15_000), end(T0 - 14_500),
      pluginPrompt(T0 - 10_000), reply(T0 - 5000), end(T0 - 4500)]);
    await r.order(); await r.step();
    expect(r.state.clearedAt! - T0).toBeLessThan(1000);
  });

  it.each(['feed', 'pick-assist'] as const)('a %s channel message counts as his', async server => {
    const replyAt = T0 - 2 * MIN;
    const r = rig(hisTurn(replyAt - 5000, replyAt, server));
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.state.clearedAt!).toBeGreaterThanOrEqual(replyAt + 10 * MIN);
  });

  it('a new reply to him during the wait restarts the clock', async () => {
    const first = T0 - 2 * MIN;
    const r = rig(hisTurn(first - 5000, first));
    let second = 0;
    r.state.onSleep = at => {
      if (second || at < T0 + 4 * MIN) return;
      second = at; // he writes again, the model answers, the model refreshes the handoff
      r.lines.push(his(at - 2000), reply(at), end(at + 500));
      r.put(r.latest, r.good, at + 600);
    };
    await r.order(); await r.step();
    expect(second).toBeGreaterThan(0);
    expect(r.clearCalls()).toBe(1);
    expect(r.state.clearedAt!).toBeGreaterThanOrEqual(second + 10 * MIN);
    expect(r.state.clearedAt!).toBeLessThan(second + 10 * MIN + 32_000);
    expect(r.logs.filter(l => l.includes('clear held')).length).toBeGreaterThanOrEqual(2);
  });

  it('replyVisibleMinMs 0 turns it off: no transcript read, the clear goes', async () => {
    const r = rig(hisTurn(T0 - 20_000, T0 - 10_000), { minMs: 0 });
    await r.order(); await r.step({ minMs: 0, read: r.read });
    expect(r.read).not.toHaveBeenCalled();
    expect(r.state.clearedAt! - T0).toBeLessThan(1000);
    const none = rig(hisTurn(T0 - 20_000, T0 - 10_000));
    await none.order(); await none.step(null);
    expect(none.state.clearedAt! - T0).toBeLessThan(1000);
  });

  it('an unreadable transcript never blocks the clear, and warns once per session', async () => {
    const r = rig([], { unreadable: true });
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.state.clearedAt! - T0).toBeLessThan(1000);
    // a second cycle in the same session
    await r.order(T0 + MIN, T0 + 2 * MIN); r.setNow(T0 + 3 * MIN); await r.step();
    expect(r.clearCalls()).toBe(2);
    const unreadable = r.logs.filter(l => l.includes('reply gate could not read the transcript'));
    expect(unreadable).toHaveLength(2);
    expect(unreadable.filter(l => l.startsWith('WARNING'))).toHaveLength(1);
    expect(unreadable[0]).toMatch(/^WARNING handoff: .*fixture: unreadable/);
  });

  it('a read that throws counts as unreadable', async () => {
    const r = rig([]);
    await r.order(); await r.step({ minMs: 10 * MIN, read: async () => { throw new Error('boom'); } });
    expect(r.clearCalls()).toBe(1);
    expect(r.logs.some(l => l.startsWith('WARNING') && l.includes('boom'))).toBe(true);
  });

  it('a stop-hook feedback companion keeps the turn his and uses the final reply time', async () => {
    const promptAt = T0 - 150_000;
    const firstReply = T0 - 140_000;
    const finalReply = T0 - 60_000;
    const r = rig([his(promptAt), reply(firstReply), companion(T0 - 100_000), reply(finalReply), end(finalReply + 500)]);
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.state.clearedAt!).toBeGreaterThanOrEqual(finalReply + 10 * MIN);
    expect(r.state.clearedAt!).toBeLessThan(finalReply + 10 * MIN + 31_000);
  });
});

describe('0.5.25 hold end, stale file and running turn', () => {
  it('after the hold ends the file is still fresh and the clear goes', async () => {
    const replyAt = T0 - 3 * MIN;
    const r = rig(hisTurn(replyAt - 3000, replyAt));
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.submits().every(text => !text.includes('HANDOFF NOW'))).toBe(true);
    expect(r.store.has(stateKey(r.sid))).toBe(false); // the cycle ended
  });

  it('a prompt newer than the file that came during the wait forces a fresh handoff first, then the clear', async () => {
    const replyAt = T0 - 2 * MIN;
    const r = rig(hisTurn(replyAt - 3000, replyAt));
    let peerAt = 0;
    r.state.onSleep = at => {
      if (peerAt || at < T0 + 2 * MIN) return;
      peerAt = at; // a peer message answered during the wait: not his, so the clock stays, but the file is older than it
      r.lines.push(channel(at, 'peer'), reply(at + 3000), end(at + 3500));
    };
    await r.order(); await r.step();
    expect(peerAt).toBeGreaterThan(0);
    expect(r.clearCalls()).toBe(0);
    const orders = r.submits().filter(text => text.includes('HANDOFF NOW'));
    expect(orders).toHaveLength(1);
    expect(r.logs.some(l => l.includes('ordering a fresh handoff (1 of 2)'))).toBe(true);
    expect(r.store.get(stateKey(r.sid))).toMatchObject({ refreshes: 1, forcedOrders: 1 });
    expect(JSON.parse(r.files.get(sessionFile(r.dir, r.sid, 'order.json'))!)).toMatchObject({ order: 'now' });
    // the model writes the fresh file; the next turn end clears, his reply is 10 min old by now
    r.put(r.latest, r.good, r.now() + 1000);
    r.setNow(r.now() + 5000);
    r.lines.push(pluginPrompt(r.now() - 4000), reply(r.now() - 3000, 'written'), end(r.now() - 2500));
    await r.step();
    expect(r.clearCalls()).toBe(1);
    expect(r.submits().at(-1)).toContain('HANDOFF RESUME');
  });

  it('a turn still running when the hold ends defers the clear to the next turn end', async () => {
    const replyAt = T0 - 2 * MIN;
    const r = rig(hisTurn(replyAt - 3000, replyAt));
    let peerAt = 0;
    r.state.onSleep = at => {
      if (peerAt || at < T0 + 2 * MIN) return;
      peerAt = at;
      r.lines.push(channel(at, 'peer'), reply(at + 3000)); // no turn end: still running
    };
    await r.order(); await r.step();
    expect(r.clearCalls()).toBe(0);
    expect(r.logs.some(l => l.includes('clear deferred after the hold'))).toBe(true);
    expect(r.store.get(stateKey(r.sid))).toMatchObject({ orderAt: T0 - MIN });
    // the turn ends, the file is refreshed by the model: next turn end clears
    r.lines.push(end(r.now()));
    r.put(r.latest, r.good, r.now() + 100);
    await r.step();
    expect(r.clearCalls()).toBe(1);
  });
});
