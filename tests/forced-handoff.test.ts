import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register, toSessionMessages } from '../hooks/fast-jev.ts';
import { setLogSettleMs } from '../hooks/disk-log.ts';
import { applyDecisions, decideCall, messageChars } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { collectPins, pinStoreKey, readPinProvenance, readPinRecord } from '../hooks/pin-provenance.js';
import { CLEAR_RETRY_COOLDOWN_MS, MAX_CLEAR_FAILURES,MAX_FORCED_REPEATS, pendingOrders } from '../hooks/handoff.ts';
import { platformSource } from '../hooks/platform.ts';
import type { Message } from '../src/types.js';

const m = (role: Message['role'], text: string, extra = {}): Message => ({ role, text, toolUses: [], ...extra });
const chars = (rows: readonly Message[]) => rows.reduce((n, row) => n + messageChars(row), 0);

/** Real scoring/rebuild, exactly 10,000 incoming characters. No mocked compactor. */
function ratioRows(savings: number): Message[] {
  const rows = [m('user', 'task'), m('assistant', '', {
    toolUses: [{ tool_use_id: 'old', tool: 'Read', input: {} }],
  }), m('user', '', { toolResults: [{ tool_use_id: 'old', text: 'z'.repeat(3000) }] }), m('assistant', 'done')];
  const calls = collectToolCalls(rows, 1);
  const decisions = calls.map(call => decideCall(call, { keepCall: 0, keepResult: 0 }, { keepThreshold: 0.5 }));
  const currentSavings = chars(rows) - chars(toSessionMessages(rows, applyDecisions(rows, decisions, calls, 300)));
  rows[2]!.toolResults![0]!.text = 'z'.repeat(3000 + savings - currentSavings);
  rows[0]!.text += 'x'.repeat(10_000 - chars(rows));
  expect(chars(rows)).toBe(10_000);
  expect(chars(rows) - chars(toSessionMessages(rows, applyDecisions(rows, decisions, calls, 300)))).toBe(savings);
  return rows;
}

let sequence = 0;
function harness(flag: '1' | 'unset' | 'unreadable' | 'other' = '1', options = {}) {
  let sid = `floor-session-${++sequence}`;
  const initialSid = sid;
  let tokens: number | undefined = 1234;
  let now = 1000;
  let mode = flag;
  let rows = ratioRows(2490);
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const kinds = new Map<string, string>();
  const store = new Map<string, unknown>();
  const logs: string[] = [];
  const pauses: (() => void)[] = [];
  const handlers: Record<string, Function> = {};
  const install = () => register(((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any,
    // orderRepeatGraceMs 0: the older tests drive a repeat at each turn end on a clock that barely moves. The
    // 0.5.29 grace (product default 5 min) has its own tests below, which pass { orderRepeatGraceMs: 300000 }.
    { apiKey: 'fixture', preserveRecentMessages: 1, targetVisibleTokens: 0, handoffDir: 'F:/h', orderRepeatGraceMs: 0, ...options });
  install();
  const put = (path: string, text: string, at = ++now) => { files.set(path, text); mtimes.set(path, at); };
  const $: any = {
    env: { get: vi.fn(async (name: string) => {
      if (name === 'DISABLE_AUTO_COMPACT') {
        if (mode === 'unreadable') throw new Error('private environment failure');
        return mode === '1' ? '1' : mode === 'other' ? 'private-other-value' : undefined;
      }
      return name === 'USERPROFILE' ? 'F:/temp/jev-floor' : undefined;
    }) },
    settings: { read: async () => ({}) },
    fs: {
      exists: async (path: string) => files.has(path),
      read: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; }),
      write: vi.fn(async (path: string, text: string) => { put(path, text); }),
      stat: vi.fn(async (path: string) => ({ kind: kinds.get(path) ?? 'file', size: files.get(path)?.length ?? 0, mtimeMs: mtimes.get(path) ?? 0 })),
    },
    store: {
      get: vi.fn(async (key: string) => store.get(key)),
      set: vi.fn(async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    },
    clock: { now: async () => now, sleep: vi.fn(() => new Promise<void>(resolve => pauses.push(resolve))) },
    http: { fetch: vi.fn(async (_url: string, init: any) => ({ status: 200, ok: true,
      text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(key => [key, { noul: 0 }])) }) })) },
    ui: { log: vi.fn((text: string) => { logs.push(text); }), toast: vi.fn() },
    session: {
      id: async () => sid, cwd: async () => 'F:/tree', messages: async () => rows,
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
  const core = vi.fn(async () => ({ messages: [m('user', 'forbidden summary')] }));
  const cut = () => handlers['session.compact']!($, { trigger: 'manual', messages: rows }, core);
  const turn = (event = {}) => handlers['turn.complete']!($, event, async (out: unknown) => out);
  const append = (text: string, uuid: string) => handlers['session.append']!($,
    { door: 'delivery', uuid, origin: { kind: 'engine' }, message: { type: 'attachment', content: [{ type: 'text', text }] } }, async (event: unknown) => event);
  const flush = async () => { for (const resume of pauses.splice(0)) resume(); await new Promise<void>(resolve => setImmediate(resolve)); };
  const root = `F:/h/${initialSid}`;
  const latest = `${root}/latest.md`;
  const good = `# Handoff for session ${initialSid}\nbody\nCOMPLETE\n`;
  return { $, files, mtimes, kinds, store, logs, core, cut, turn, append, flush, put, root, latest, good, handlers, sid: initialSid,
    advance: (ms: number) => { now += ms; }, getNow: () => now, setNow: (value: number) => { now = value; },
    install, marker: () => JSON.parse(files.get(`${root}/order.json`)!),
    setRows: (value: Message[]) => { rows = value; }, getRows: () => rows,
    setTokens: (value: number | undefined) => { tokens = value; },
    setFlag: (value: typeof mode) => { mode = value; }, setSid: (value: string) => { sid = value; } };
}

async function force(h: ReturnType<typeof harness>) {
  expect((await h.cut()).skip).toContain('written handoff required');
  await h.flush();
  expect(h.core).not.toHaveBeenCalled();
}

describe('registered forced handoff floor', () => {
  it.each(['1', 'unset', 'unreadable', 'other'] as const)('24.9%% forces NOW below the token threshold with env %s', async flag => {
    const h = harness(flag);
    const incoming = JSON.stringify(h.getRows());
    await force(h);
    expect(h.marker()).toMatchObject({ order: 'now', tokens: 1234, limit: 300000, attempt: 1, reason: expect.stringContaining('reduction 24.9% below 25% minimum') });
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    expect(h.$.prompt.submit.mock.calls[0][0].text).toContain('HANDOFF NOW: reduction 24.9% below 25% minimum');
    expect(h.$.prompt.submit.mock.calls[0][0].text).toContain('current context is 1234 tokens');
    expect(h.store.get(`handoff:${h.sid}`)).toMatchObject({ forceReason: expect.stringContaining('24.9%'), forcedOrders: 1 });
    expect(h.$.store.set.mock.calls.some(([key]: [string]) => key.startsWith('delivery-pins:'))).toBe(false);
    expect(JSON.stringify(h.getRows())).toBe(incoming);
    expect(h.$.command.run).not.toHaveBeenCalled();
    expect([...h.files.values()].join('')).not.toContain('private-other-value');
    expect([...h.files.values()].join('')).not.toContain('private environment failure');
  });

  it.each(['1', 'unset', 'unreadable'] as const)('exactly 25%% retains the real replacement with env %s', async flag => {
    const h = harness(flag); h.setRows(ratioRows(2500));
    const out = await h.cut(); await h.flush();
    expect(out.skip).toBeUndefined();
    expect(chars(out.messages)).toBe(7500);
    expect(h.files.has(`${h.root}/order.json`)).toBe(false);
    expect(h.store.has(`handoff:${h.sid}`)).toBe(false);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.$.prompt.submit).not.toHaveBeenCalled();
  });

  it('uses null, not a synthetic threshold, when actual usage is unavailable', async () => {
    const h = harness('unreadable'); h.$.session.usage.mockRejectedValue(new Error('usage unavailable'));
    await force(h);
    expect(h.marker()).toMatchObject({ tokens: null, reason: expect.stringContaining('24.9%') });
    expect(h.$.prompt.submit.mock.calls[0][0].text).toContain('token count unavailable');
    expect(h.logs.join('\n')).not.toContain('at ~300000 tokens');
  });

  it('persists the forced reason across callback re-registration and lost env/usage', async () => {
    const h = harness(); await force(h);
    h.install(); h.setFlag('unreadable'); h.$.session.usage.mockRejectedValue(new Error('usage unavailable'));
    await h.turn(); await h.flush();
    expect(h.marker()).toMatchObject({ order: 'now', attempt: 2, tokens: null, reason: expect.stringContaining('24.9%') });
    h.put(h.latest, h.good);
    await h.turn(); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(1);
    expect(h.$.prompt.submit.mock.calls.at(-1)[0].text).toContain('HANDOFF RESUME');
    expect(h.core).not.toHaveBeenCalled();
  });

  it('a late ratio miss retains live history, late pins and old durable fingerprints', async () => {
    const h = harness('unset'); h.setRows(ratioRows(2500));
    const prior = collectPins([m('user', 'old durable instruction')], new Set([0]));
    h.store.set(pinStoreKey(h.sid), { version: 2, pins: prior });
    const write = h.$.fs.write.getMockImplementation()!;
    let delivered = false;
    h.$.fs.write.mockImplementation(async (path: string, text: string) => {
      if (!delivered && text.includes('replacement prepared')) {
        delivered = true;
        await h.append('late pinned instruction '.repeat(100), 'late-floor');
      }
      return write(path, text);
    });
    const incoming = JSON.stringify(h.getRows());
    await force(h);
    expect(delivered).toBe(true);
    expect(h.marker().reason).toContain('late deliveries: reduction');
    expect(JSON.stringify(h.getRows())).toBe(incoming);
    expect(readPinRecord(h.store.get(pinStoreKey(h.sid)))).toEqual(expect.arrayContaining(prior));
    h.setRows(ratioRows(8000));
    const retry = await h.cut(); await h.flush();
    expect(retry.skip).toBeUndefined();
    expect(retry.messages.filter((row: Message) => row.text === 'late pinned instruction '.repeat(100))).toHaveLength(1);
    expect(readPinProvenance(retry.messages, readPinRecord(h.store.get(pinStoreKey(h.sid)))).find(row => row.text === 'late pinned instruction '.repeat(100))?.pinned).toBe(true);
    expect(h.core).not.toHaveBeenCalled();
  });

  it.each(['missing', 'incomplete', 'stale', 'wrong session', 'session prefix', 'directory', 'changing read'] as const)('%s handoff never clears', async kind => {
    const h = harness('unset'); await force(h);
    if (kind !== 'missing') h.put(h.latest, h.good);
    if (kind === 'incomplete') h.put(h.latest, `# ${h.sid}\nbody\n`);
    if (kind === 'stale') h.mtimes.set(h.latest, 1000);
    if (kind === 'wrong session') h.put(h.latest, '# Handoff for another-session\nCOMPLETE\n');
    if (kind === 'session prefix') h.put(h.latest, `# Handoff for ${h.sid}-other\nCOMPLETE\n`);
    if (kind === 'directory') h.kinds.set(h.latest, 'directory');
    if (kind === 'changing read') {
      const read = h.$.fs.read.getMockImplementation()!;
      h.$.fs.read.mockImplementation(async (path: string) => {
        const text = await read(path);
        if (path === h.latest) h.mtimes.set(path, h.mtimes.get(path)! + 1);
        return text;
      });
    }
    await h.turn(); await h.flush();
    expect(h.$.command.run).not.toHaveBeenCalled();
    expect(h.$.prompt.submit.mock.calls.every(([input]: [{ text: string }]) => !input.text.startsWith('HANDOFF RESUME'))).toBe(true);
    expect(h.core).not.toHaveBeenCalled();
  });

  it('aborted turns neither repeat nor clear, even with a valid file', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    for (let i = 0; i < 6; i++) await h.turn({ isAborted: true });
    await h.flush();
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    expect(h.$.command.run).not.toHaveBeenCalled();
    await h.turn(); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(1);
  });

  it('the first completion does not duplicate the immediate order; repeats remain bounded across compact requests', async () => {
    const h = harness('unset'); await force(h);
    await h.turn(); await h.flush();
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) { await h.cut(); await h.turn(); await h.flush(); }
    // Compact requests must not consume or reset the turn-completion repeat budget.
    // Each compact marks this turn just-forced, so use independent later turns.
    for (let i = 0; i < 10; i++) { await h.turn(); await h.flush(); }
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1 + MAX_FORCED_REPEATS);
    expect(h.store.get(`handoff:${h.sid}`)).toMatchObject({ forcedOrders: 4, gaveUp: true });
    expect(h.files.has(`${h.root}/order.json`)).toBe(false);
    expect(h.logs.filter(line => line.includes('built-in summary not requested'))).toHaveLength(1);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.$.command.run).not.toHaveBeenCalled();
  });

  // eve c68f35dd, plugin log 2026-11-19T00:42:03Z to 00:43:05Z: order, then turn ends at +46 s, +51 s, +55 s and
  // +62 s while the session was writing the file. 0.5.28 repeated the order on each and gave up the clear.
  it('0.5.29 turn ends seconds apart while the file is being written repeat nothing, and the finished file clears', async () => {
    const h = harness('unset', { orderRepeatGraceMs: 300_000 }); await force(h);
    await h.turn(); await h.flush();
    const partial = `# Handoff for session ${h.sid}\nbody, still writing\n`;
    for (const gap of [46_000, 5_000, 4_000, 7_000]) {
      h.advance(gap); h.put(h.latest, partial, h.getNow());
      await h.turn(); await h.flush();
    }
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    expect(h.logs.some(line => line.includes('handoff order repeated'))).toBe(false);
    expect(h.logs.filter(line => line.includes('no repeat before 5 min'))).toHaveLength(1);
    h.advance(172_000); h.put(h.latest, h.good, h.getNow());   // finished 3 min 54 s after the order
    await h.turn(); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(1);
    expect(h.store.get(`handoff:${h.sid}`)?.gaveUp).not.toBe(true);
  });

  it('0.5.29 a write to the file restarts the wait; five quiet minutes repeat the order once', async () => {
    const h = harness('unset', { orderRepeatGraceMs: 300_000 }); await force(h);
    await h.turn(); await h.flush();
    h.advance(200_000); h.put(h.latest, `# Handoff for session ${h.sid}\npart\n`, h.getNow());
    h.advance(200_000); await h.turn(); await h.flush();        // 400 s after the order, 200 s after the write
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    h.advance(101_000); await h.turn(); await h.flush();        // 301 s with no write
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(2);
    expect(h.logs.some(line => line.includes('handoff order repeated (1 of 3)'))).toBe(true);
    h.advance(10_000); await h.turn(); await h.flush();         // the repeat is an order too: its own wait
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(2);
  });

  it('0.5.29 a file finished after the first order still counts after a repeat (0.5.28: "older than the order")', async () => {
    const h = harness('unset', { orderRepeatGraceMs: 300_000 }); await force(h);
    await h.turn(); await h.flush();
    const writtenAt = h.getNow() + 100_000;
    h.advance(301_000); await h.turn(); await h.flush();
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(2);         // repeated at +301 s
    h.put(h.latest, h.good, writtenAt);                          // the file dates from before that repeat
    h.advance(1_000); await h.turn(); await h.flush();
    expect(h.logs.some(line => line.includes('older than the order'))).toBe(false);
    expect(h.$.command.run).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'throws'] as const)('clear capability %s fails closed', async mode => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    if (mode === 'missing') h.$.command.list.mockResolvedValue([]);
    else h.$.command.list.mockRejectedValue(new Error('capability unavailable'));
    await h.turn(); await h.flush();
    expect(h.store.get(`handoff:${h.sid}`)).toMatchObject({ clearBlocked: true });
    expect(h.$.command.run).not.toHaveBeenCalled();
    expect(h.core).not.toHaveBeenCalled();
  });

  it('concurrent capability lookups schedule only one detached clear', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    const releases: (() => void)[] = [];
    h.$.command.list.mockImplementation(() => new Promise(resolve => releases.push(() => resolve([{ name: 'clear' }]))));
    const first = h.turn(); const second = h.turn();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releases).toHaveLength(2);
    for (const release of releases) release();
    await Promise.all([first, second]); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(1);
    expect(h.$.prompt.submit.mock.calls.filter(([input]: [{ text: string }]) => input.text.startsWith('HANDOFF RESUME'))).toHaveLength(1);
  });

  it.each(['detached delay', 'resumed marker write', 'clear log', 'valid replacement'] as const)('replacement during %s is rechecked before clear', async when => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    const replace = () => h.put(h.latest, when === 'valid replacement' ? `${h.good.trimEnd()}\n\n` : '# replaced and incomplete\n');
    if (when === 'resumed marker write' || when === 'valid replacement') {
      const write = h.$.fs.write.getMockImplementation()!;
      h.$.fs.write.mockImplementation(async (path: string, text: string) => {
        await write(path, text);
        if (path.endsWith('/resumed.json')) replace();
      });
    } else if (when === 'clear log') {
      const write = h.$.fs.write.getMockImplementation()!;
      h.$.fs.write.mockImplementation(async (path: string, text: string) => {
        await write(path, text);
        if (text.includes('clearing the session and resuming from the file')) replace();
      });
    }
    await h.turn();
    if (when === 'detached delay') replace();
    await h.flush();
    expect(h.$.command.run).not.toHaveBeenCalled();
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    expect(h.core).not.toHaveBeenCalled();
  });

  it('a changed session during the detached delay is never cleared', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    await h.turn(); h.setSid('replacement-session'); await h.flush();
    expect(h.$.command.run).not.toHaveBeenCalled();
    expect(h.core).not.toHaveBeenCalled();
  });

  it.each(['read', 'stat'] as const)('a changed session during the final file %s is never cleared', async when => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    let reads = 0;
    let stats = 0;
    const read = h.$.fs.read.getMockImplementation()!;
    const stat = h.$.fs.stat.getMockImplementation()!;
    h.$.fs.read.mockImplementation(async (path: string) => {
      const text = await read(path);
      if (path === h.latest && ++reads === 3 && when === 'read') h.setSid('replacement-session');
      return text;
    });
    h.$.fs.stat.mockImplementation(async (path: string) => {
      const info = await stat(path);
      if (path === h.latest && ++stats === 6 && when === 'stat') h.setSid('replacement-session');
      return info;
    });
    await h.turn(); await h.flush();
    expect(h.$.command.run).not.toHaveBeenCalled();
    expect(reads).toBe(3);
    expect(stats).toBe(6);
    expect(h.files.has(`${h.root}/resumed.json`)).toBe(true);
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    expect(h.core).not.toHaveBeenCalled();
  });

  it('clear failures stop at the bounded limit without submitting resume', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    h.$.command.run.mockRejectedValue(new Error('clear refused'));
    for (let i = 0; i < 8; i++) { await h.turn(); await h.flush(); }
    expect(h.$.command.run).toHaveBeenCalledTimes(MAX_CLEAR_FAILURES);
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(1);
    // 0.5.16: the marker survives the cap, the clear is still pending.
    expect(h.files.has(`${h.root}/order.json`)).toBe(true);
    expect(h.core).not.toHaveBeenCalled();
  });

  it('0.5.16 logs the thrown error text in the clear failed line', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    h.$.command.run.mockRejectedValue(new Error('the session was stopped and nobody has sent input since'));
    await h.turn(); await h.flush();
    const line = h.logs.find(entry => entry.includes('handoff clear failed (attempt 1 of 3)'));
    expect(line).toContain('the session was stopped and nobody has sent input since');
  });

  it.runIf(process.platform === 'win32')('0.5.17 a stopped-session refusal is cleared through the console helper (registered wiring)', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    h.$.command.run.mockRejectedValue(new Error('fast-jev-compaction: $.command.run: the session was stopped and nobody has sent input since'));
    const idle = ['x', '\u2500'.repeat(40), '\u276f', '\u2500'.repeat(40), '  status'];
    h.$.process.run.mockImplementation(async (argv: string[], init: any) => {
      if (argv[0] !== 'powershell') return { exitCode: 1 };
      expect(init.env.FJ_SID).toBe(h.sid);
      if (argv.at(-1) === 'read') return { exitCode: 0, stdout: JSON.stringify({ pid: 31337, rows: idle }) };
      h.setSid('typed-clear-session');
      return { exitCode: 0, stdout: JSON.stringify({ pid: 31337, typed: 14 }) };
    });
    await h.turn();
    for (let i = 0; i < 4; i++) await h.flush();
    expect(h.logs.slice(-5).join(' | ')).toContain('handoff clear via console fallback (pid 31337)');
    expect(h.logs.some(entry => entry.includes('handoff clear failed'))).toBe(false);
    expect(h.files.has('F:\\h\\console-clear.ps1')).toBe(true);
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(2);
  });

  it('0.5.31 the console fallback is wired when the host shows no process.platform (the plugin host on Windows)', async () => {
    const real = platformSource.processPlatform;
    platformSource.processPlatform = () => undefined;
    try {
      const h = harness('unset'); await force(h); h.put(h.latest, h.good);
      h.$.command.run.mockRejectedValue(new Error('fast-jev-compaction: $.command.run: the session was stopped and nobody has sent input since'));
      const idle = ['x', '─'.repeat(40), '❯', '─'.repeat(40), '  status'];
      h.$.process.run.mockImplementation(async (argv: string[]) => {
        if (argv[0] !== 'powershell') return { exitCode: 1 };
        if (argv.at(-1) === 'read') return { exitCode: 0, stdout: JSON.stringify({ pid: 31337, rows: idle }) };
        h.setSid('typed-clear-session');
        return { exitCode: 0, stdout: JSON.stringify({ pid: 31337, typed: 14 }) };
      });
      await h.turn();
      for (let i = 0; i < 4; i++) await h.flush();
      expect(h.logs.slice(-5).join(' | ')).toContain('handoff clear via console fallback (pid 31337)');
    } finally { platformSource.processPlatform = real; }
  });

  it('0.5.16 retries after the cooldown once the burst is spent, and then clears', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    h.$.command.run.mockRejectedValue(new Error('clear refused'));
    for (let i = 0; i < 5; i++) { await h.turn(); await h.flush(); }
    expect(h.$.command.run).toHaveBeenCalledTimes(MAX_CLEAR_FAILURES);
    h.advance(CLEAR_RETRY_COOLDOWN_MS - 1000);
    await h.turn(); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(MAX_CLEAR_FAILURES);
    h.advance(2000);
    h.$.command.run.mockResolvedValue({});
    await h.turn(); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(MAX_CLEAR_FAILURES + 1);
    expect(h.files.has(`${h.root}/order.json`)).toBe(false);
    expect(h.$.prompt.submit).toHaveBeenCalledTimes(2);
  });

  it('0.5.16 a person prompt resets the failure count, a peer prompt does not', async () => {
    const h = harness('unset'); await force(h); h.put(h.latest, h.good);
    h.$.command.run.mockRejectedValue(new Error('clear refused'));
    for (let i = 0; i < 4; i++) { await h.turn(); await h.flush(); }
    expect(h.$.command.run).toHaveBeenCalledTimes(MAX_CLEAR_FAILURES);
    const next = async (e: any) => ({ text: e.text });
    await h.handlers['prompt.submit'](h.$, { text: 'x', wait: false, origin: { kind: 'peer' } }, next);
    await h.turn(); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(MAX_CLEAR_FAILURES);
    await h.handlers['prompt.submit'](h.$, { text: 'hello', wait: false, origin: { kind: 'composer' } }, next);
    expect(h.logs.some(line => line.includes('reset by a person prompt'))).toBe(true);
    await h.turn(); await h.flush();
    expect(h.$.command.run).toHaveBeenCalledTimes(MAX_CLEAR_FAILURES + 1);
  });
});

describe('0.5.15 order delivery when the plugin own submit never reaches the model', () => {
  const promptEvent = (kind: string) => ({ text: 'peer says hi', wait: false, origin: { kind } });

  it('attaches the pending order as context to the next prompt of any origin, once', async () => {
    const h = harness();
    // The own submit never resolves: no error, no enqueue (the 21687c6d case).
    h.$.prompt.submit.mockImplementation(() => new Promise(() => {}));
    await force(h);
    const seen: any[] = [];
    const next = async (e: any) => { seen.push(e); return { text: e.text, context: e.context }; };
    await h.handlers['prompt.submit'](h.$, promptEvent('peer'), next);
    expect(seen[0].context).toHaveLength(1);
    expect(seen[0].context[0]).toContain('HANDOFF NOW: reduction 24.9% below 25% minimum');
    expect(h.logs.some(line => line.includes('handoff order carried as context'))).toBe(true);
    await h.handlers['prompt.submit'](h.$, promptEvent('notification'), next);
    expect(seen[1].context).toBeUndefined();
  });

  it('does not attach it when the order text is already in the session, or for a plugin origin', async () => {
    const h = harness();
    await force(h);
    const text = h.$.prompt.submit.mock.calls[0][0].text as string;
    const seen: any[] = [];
    const next = async (e: any) => { seen.push(e); return { text: e.text, context: e.context }; };
    await h.handlers['prompt.submit'](h.$, promptEvent('plugin'), next);
    expect(seen[0].context).toBeUndefined();
    h.setRows([...h.getRows(), { role: 'user', text: `The fast-jev-compaction plugin sent a message:\n${text}`, toolUses: [] } as Message]);
    await h.handlers['prompt.submit'](h.$, promptEvent('peer'), next);
    expect(seen[1].context).toBeUndefined();
  });

  it('logs a dropped submit with its reason and stops carrying once the order is cleared', async () => {
    const h = harness();
    h.$.prompt.submit.mockImplementation(async () => ({ drop: 'blocked by a settings hook' }));
    await force(h);
    expect(h.logs.some(line => line.includes('submit DROPPED') && line.includes('blocked by a settings hook'))).toBe(true);
    h.put(h.latest, h.good, 5000);
    await h.turn();
    await h.flush();
    const seen: any[] = [];
    await h.handlers['prompt.submit'](h.$, promptEvent('peer'), async (e: any) => { seen.push(e); return { text: e.text }; });
    expect(seen[0].context).toBeUndefined();
  });
});

describe('module-loaded callback receipt', () => {
  it.each(['1', 'unset', 'unreadable', 'other'] as const)('records build, full session and env read result %s on disk only, once', async flag => {
    const h = harness(flag);
    expect(h.files.size).toBe(0); // Registration/manifest contents are not a receipt.
    await Promise.all([h.turn(), h.turn()]);
    await h.handlers['session.compact']!(h.$, { trigger: 'precompute', messages: h.getRows() }, h.core);
    await h.append('observed delivery', 'receipt-append');
    const disk = h.files.get('F:/temp/jev-floor/.claude/fast-jev-compaction.log')!;
    expect(disk.match(/module-loaded/g)).toHaveLength(1);
    expect(disk).toContain(`module-loaded hook=fast-jev-compaction@0.5.33/forced-handoff-floor; session=${h.sid}; DISABLE_AUTO_COMPACT=${flag}`);
    expect(h.logs.some(line => line.includes('module-loaded'))).toBe(false);
    expect(h.$.ui.toast).not.toHaveBeenCalled();
    expect(disk).not.toContain('private-other-value');
    expect(disk).not.toContain('private environment failure');
    h.setSid('new-receipt-session'); await h.turn();
    expect(h.files.get('F:/temp/jev-floor/.claude/fast-jev-compaction.log')!.match(/module-loaded/g)).toHaveLength(2);
  });

  it('keeps receipt and forced-notice dedupe local to each registration and session', async () => {
    const h = harness('unset');
    await force(h); await force(h);
    expect(h.logs.filter(line => line.includes('built-in summary not requested'))).toHaveLength(1);
    h.install(); await force(h);
    expect(h.logs.filter(line => line.includes('built-in summary not requested'))).toHaveLength(2);
    expect(h.files.get('F:/temp/jev-floor/.claude/fast-jev-compaction.log')!.match(/module-loaded/g)).toHaveLength(2);
    h.setSid('second-dedupe-session'); await force(h); await force(h);
    expect(h.logs.filter(line => line.includes('built-in summary not requested'))).toHaveLength(3);
    expect(h.files.get('F:/temp/jev-floor/.claude/fast-jev-compaction.log')!.match(/module-loaded/g)).toHaveLength(3);
    expect(h.core).not.toHaveBeenCalled();
  });

  it('a failed receipt write cannot reopen summary or block a forced handoff', async () => {
    const h = harness('unset');
    const write = h.$.fs.write.getMockImplementation()!;
    h.$.fs.write.mockImplementation(async (path: string, text: string) => {
      if (path.endsWith('fast-jev-compaction.log')) throw new Error('disk unavailable');
      return write(path, text);
    });
    await force(h);
    expect(h.marker().order).toBe('now');
  });
});

// 0.5.24: the host has no append, so two processes can read the log before either writes and the
// later write replaces the earlier line (11-12: two of six restarted sessions lost their receipt).
describe('disk log with concurrent writers', () => {
  const LOG = 'F:/temp/jev-floor/.claude/fast-jev-compaction.log';
  beforeEach(() => setLogSettleMs(10)); // production waits 25 ms; the suite default is 0 (tests/setup.ts)
  afterEach(() => setLogSettleMs(0));

  it('second session reads before the first writes: both module-loaded receipts survive', async () => {
    const h1 = harness('unset');
    const h2 = harness('unset');
    const disk = h1.files; // one disk for both hosts
    let release!: () => void;
    const firstWritten = new Promise<void>(resolve => { release = resolve; });
    const write1 = h1.$.fs.write.getMockImplementation()!;
    h1.$.fs.write.mockImplementation(async (path: string, text: string) => {
      await write1(path, text);
      if (path === LOG) release();
    });
    let stale = true;
    let clobbered = false;
    h2.$.fs.exists = async (path: string) => {
      if (path === LOG && stale) { stale = false; const snapshot = disk.get(path); await firstWritten; return snapshot !== undefined; }
      return disk.has(path);
    };
    h2.$.fs.read = async (path: string) => { if (!disk.has(path)) throw new Error('missing'); return disk.get(path)!; };
    let h2Writes = 0;
    h2.$.fs.write = async (path: string, text: string) => {
      if (path === LOG && ++h2Writes === 1) clobbered = !text.includes(`session=${h1.sid}`) && (disk.get(LOG) ?? '').includes(`session=${h1.sid}`);
      disk.set(path, text);
    };
    await Promise.all([h1.turn(), h2.turn()]);
    expect(clobbered).toBe(true); // the second write really did replace the first line
    const text = disk.get(LOG)!;
    expect(text.match(/module-loaded/g)).toHaveLength(2);
    expect(text).toContain(`session=${h1.sid};`);
    expect(text).toContain(`session=${h2.sid};`);
  });

  it('a log that always loses to another writer gives up after a bounded number of writes, never throws, and has written', async () => {
    const h = harness('unset');
    h.put(LOG, 'foreign line\n');
    let receiptWrites = 0;
    const read = h.$.fs.read.getMockImplementation()!;
    h.$.fs.read.mockImplementation(async (path: string) => (path === LOG ? 'foreign line\n' : read(path)));
    const write = h.$.fs.write.getMockImplementation()!;
    h.$.fs.write.mockImplementation(async (path: string, text: string) => {
      if (path === LOG && text.includes('module-loaded')) receiptWrites++;
      return write(path, text);
    });
    const started = Date.now();
    await h.turn();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(receiptWrites).toBeGreaterThan(1); // it retried
    expect(receiptWrites).toBeLessThanOrEqual(4); // and stopped
    expect(h.files.get(LOG)).toContain("[floor-se] "); // the last write is on disk, as before 0.5.24
  });

  it('a read-back that fails stops after the first write, no retry', async () => {
    const h = harness('unset');
    let receiptWrites = 0;
    const read = h.$.fs.read.getMockImplementation()!;
    h.$.fs.read.mockImplementation(async (path: string) => { if (path === LOG) throw new Error('read refused'); return read(path); });
    const write = h.$.fs.write.getMockImplementation()!;
    h.$.fs.write.mockImplementation(async (path: string, text: string) => {
      if (path === LOG && text.includes('module-loaded')) receiptWrites++;
      return write(path, text);
    });
    await h.turn();
    expect(receiptWrites).toBe(1);
    expect(h.files.get(LOG)).toContain("[floor-se] ");
  });

  it('trims an oversized log to its newest half in the same write, keeping the new line', async () => {
    const h = harness('unset');
    h.put(LOG, `${'x'.repeat(600_000)}\nold last line\n`);
    await h.turn();
    const text = h.files.get(LOG)!;
    expect(text.length).toBeLessThan(300_000);
    expect(text).toContain('old last line\n');
    expect(text.match(/module-loaded/g)).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('0.5.33 a dropped order submit falls through to delivery', () => {
  const STOPPED = 'the session was stopped and nobody has sent input since';
  const idle = ['x', '\u2500'.repeat(40), '\u276f', '\u2500'.repeat(40), '  status'];
  const busy = ['x', 'working... esc to interrupt', '\u2500'.repeat(40), '\u276f', '\u2500'.repeat(40)];
  type Opts = { submit?: 'ok' | 'drop' | 'throw'; console?: 'ok' | 'busy' | 'nothing'; peer?: 'ok' | 'fail' | 'nothing' };
  /** The harness with a scripted submit, console helper (powershell) and peer helper (python); the move/del commands still work. */
  function scripted(opts: Opts) {
    const h = harness('unset');
    const base = h.$.process.run.getMockImplementation()!;
    const calls: { argv: string[]; env: Record<string, string> | undefined }[] = [];
    h.$.process.run.mockImplementation(async (argv: string[], init: any) => {
      if (argv[0] === 'powershell') {
        calls.push({ argv, env: init?.env });
        if (opts.console === 'nothing') return { exitCode: 1 };
        if (argv.at(-1) === 'read') return { exitCode: 0, stdout: JSON.stringify({ pid: 4242, rows: opts.console === 'busy' ? busy : idle }) };
        return { exitCode: 0, stdout: JSON.stringify({ pid: 4242, typed: 2 * (init.env.FJ_TEXT.length + 1) }) };
      }
      if (argv[0] === 'python') {
        calls.push({ argv, env: init?.env });
        if (opts.peer === 'nothing') return { exitCode: 1 };
        return { exitCode: opts.peer === 'ok' ? 0 : 2, stdout: JSON.stringify(opts.peer === 'ok'
          ? { ok: true, detail: 'peer to trading: queued; session started' } : { ok: false, error: 'wake: no channel' }) };
      }
      return base(argv, init);
    });
    if (opts.submit === 'drop') h.$.prompt.submit.mockResolvedValue({ drop: STOPPED });
    if (opts.submit === 'throw') h.$.prompt.submit.mockRejectedValue(new Error('host refused the submit'));
    const typed = () => calls.filter(c => c.argv[0] === 'powershell' && c.argv.at(-1) === 'type');
    const peer = () => calls.filter(c => c.argv[0] === 'python');
    return { h, calls, typed, peer };
  }

  it('a submit that enters runs no other route', async () => {
    const s = scripted({ submit: 'ok' });
    await force(s.h);
    expect(s.calls).toHaveLength(0);
    expect(s.h.logs.some(l => l.includes('handoff order submit returned after'))).toBe(true);
    expect(s.h.logs.some(l => l.includes('DROPPED') || l.includes('DELIVERED'))).toBe(false);
  });

  it('dropped, then the console takes the order: typed once, the peer is never asked', async () => {
    const s = scripted({ submit: 'drop', console: 'ok', peer: 'ok' });
    await force(s.h);
    const order = s.h.$.prompt.submit.mock.calls[0][0].text as string;
    expect(s.typed()).toHaveLength(1);
    expect(s.typed()[0]!.env!.FJ_TEXT).toBe(order);
    expect(s.typed()[0]!.env!.FJ_SPLIT).toBe('1');
    expect(s.peer()).toHaveLength(0);
    const line = s.h.logs.find(l => l.includes('handoff order DELIVERED'))!;
    expect(line).toContain('by the console route');
    expect(line).toContain('submit dropped');
    expect(line).toContain(STOPPED);
    expect(s.h.logs.some(l => l.includes('DROPPED'))).toBe(false);
  });

  it('a thrown submit falls through the same way', async () => {
    const s = scripted({ submit: 'throw', console: 'ok' });
    await force(s.h);
    expect(s.typed()).toHaveLength(1);
    expect(s.h.logs.find(l => l.includes('handoff order DELIVERED'))).toContain('host refused the submit');
  });

  it('dropped, console refused (busy), then the peer send delivers', async () => {
    const s = scripted({ submit: 'drop', console: 'busy', peer: 'ok' });
    await force(s.h);
    const order = s.h.$.prompt.submit.mock.calls[0][0].text as string;
    expect(s.typed()).toHaveLength(0);
    expect(s.peer()).toHaveLength(1);
    expect(s.peer()[0]!.env).toMatchObject({ FJ_TEXT: order, FJ_ROOT: 'F:/REPS2/Meta_Orchestrator' });
    expect(s.peer()[0]!.env!.FJ_CWD).toBeTruthy();
    expect(s.h.files.get('F:/h/peer-send.py')).toContain('send.send(');
    const line = s.h.logs.find(l => l.includes('handoff order DELIVERED'))!;
    expect(line).toContain('by the peer route');
    expect(line).toContain('console route: console not ready (pid 4242): session is busy');
    expect(line).toContain('peer to trading: queued; session started');
    expect(s.h.logs.some(l => l.includes('DROPPED'))).toBe(false);
  });

  it('every route failing logs DROPPED with each reason', async () => {
    const s = scripted({ submit: 'drop', console: 'busy', peer: 'fail' });
    await force(s.h);
    const line = s.h.logs.find(l => l.includes('handoff order submit DROPPED'))!;
    expect(line).toContain('submit dropped');
    expect(line).toContain('console route: console not ready (pid 4242): session is busy');
    expect(line).toContain('peer route: wake: no channel');
    expect(s.h.logs.some(l => l.includes('DELIVERED'))).toBe(false);
  });

  it('helpers that return nothing are reasons too, not silence', async () => {
    const s = scripted({ submit: 'drop', console: 'nothing', peer: 'nothing' });
    await force(s.h);
    const line = s.h.logs.find(l => l.includes('handoff order submit DROPPED'))!;
    expect(line).toContain('console route: console helper (read) returned nothing');
    expect(line).toContain('peer route: peer helper returned nothing (exit 1)');
  });

  it('the order marker guards the fallback: a cleared order is not delivered by the next route', async () => {
    const s = scripted({ submit: 'drop', console: 'busy', peer: 'ok' });
    const run = s.h.$.process.run.getMockImplementation()!;
    s.h.$.process.run.mockImplementation(async (argv: string[], init: any) => {
      const out = await run(argv, init);
      if (argv[0] === 'powershell') pendingOrders.delete(s.h.sid); // the cycle ended while the console route ran
      return out;
    });
    await force(s.h);
    expect(s.peer()).toHaveLength(0);
    expect(s.h.logs.find(l => l.includes('fallback stopped before the peer route'))).toContain('no longer pending');
  });

  it('no double delivery: the delivered order is not carried again, a later prompt carries nothing', async () => {
    const s = scripted({ submit: 'drop', console: 'ok' });
    await force(s.h);
    const order = s.h.$.prompt.submit.mock.calls[0][0].text as string;
    const seen: any[] = [];
    const next = async (e: any) => { seen.push(e); return { text: e.text, context: e.context }; };
    // the typed line arrives as a prompt: it is the order, so it carries no copy of it
    await s.h.handlers['prompt.submit'](s.h.$, { text: order, wait: false, origin: { kind: 'composer' } }, next);
    await s.h.handlers['prompt.submit'](s.h.$, { text: 'hello', wait: false, origin: { kind: 'composer' } }, next);
    expect(seen.every(e => !(e.context ?? []).some((c: string) => c.includes(order)))).toBe(true);
    expect(s.h.logs.some(l => l.includes('handoff order carried as context'))).toBe(false);
  });

  it('still carried as context when every route failed and the next prompt is someone else\'s', async () => {
    const s = scripted({ submit: 'drop', console: 'busy', peer: 'fail' });
    await force(s.h);
    const order = s.h.$.prompt.submit.mock.calls[0][0].text as string;
    const seen: any[] = [];
    await s.h.handlers['prompt.submit'](s.h.$, { text: 'hello', wait: false, origin: { kind: 'composer' } },
      async (e: any) => { seen.push(e); return { text: e.text }; });
    expect(seen[0].context.join('\n')).toContain(order);
  });
});
