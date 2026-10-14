import { describe, expect, it, vi } from 'vitest';
import { register, toSessionMessages, compactSession, resolveHookConfig, estimateSessionTokens } from '../hooks/fast-jev.ts';
import { compact, type Message } from '../src/index.js';

const m = (role: Message['role'], text: string, extra = {}) => ({ role, text, toolUses: [], ...extra });
const jevFetch = vi.fn(async (_url: string, init: { body: string }) => ({ status: 200, ok: true,
  text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(k => [k, { noul: k.startsWith('call') ? 0.9 : 0.1 }])) }),
}));
const transcript = () => [m('user', 'never edit generated files', { handle: 'old-u' }),
  m('assistant', 'observed exact fact', { handle: 'old-a' }),
  m('assistant', '', { handle: 'old-call', toolUses: [{ tool_use_id: 'read', tool: 'Read', input: {}, text: 'data '.repeat(1000) }] }),
  m('user', '', { handle: 'old-result', toolResults: [{ tool_use_id: 'read', text: 'data '.repeat(1000), isError: false }] }),
  m('user', 'continue', { handle: 'old-next' })];

function harness(options = {}) {
  const handlers: Record<string, Function> = {};
  const on = ((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any;
  register(on, { preserveRecentMessages: 1, apiKey: 'fixture', ...options });
  const logs: string[] = [];
  const $ = { env: { get: async (k: string) => k === 'DISABLE_AUTO_COMPACT' ? '1' : undefined }, settings: { read: async () => ({}) },
    http: { fetch: vi.fn(jevFetch) }, clock: { sleep: async () => {} },
    ui: { log: (text: string) => logs.push(text), toast: vi.fn() },
    session: { usage: vi.fn(async () => ({ context: { percent: 70 } })),
      messages: vi.fn(async () => transcript()),
      compact: vi.fn(async () => ({ messages: [], tokensBefore: 200000, tokensAfter: 45000 })) } };
  const core = vi.fn(async (event: any) => ({ messages: [m('user', 'builtin summary including queued user prompt')] }));
  const event = (trigger = 'auto') => ({ trigger, messages: transcript() });
  return { handlers, $, logs, core, event };
}

describe('applied versus speculative cuts and safe fallback', () => {
  it('vetoes precompute without a Jev call, summary call or success toast', async () => {
    const h = harness();
    const out = await h.handlers['session.compact'](h.$, h.event('precompute'), h.core);
    expect(out.skip).toBeDefined();
    expect(h.$.http.fetch).not.toHaveBeenCalled();
    expect(h.core).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
  });

  it('uses handleless Jev reconstruction on the first and subsequent resumed cuts', async () => {
    // Adapted for 0.4.1 brief: handleless rebuild itself is the resume baseline.
    const h = harness();
    const firstEvent = h.event();
    await h.handlers['session.compact'](h.$, firstEvent, h.core);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.$.http.fetch).toHaveBeenCalledTimes(1);
    const result = await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(result.messages.every((row: any) => !row.handle)).toBe(true);
    expect(h.$.http.fetch).toHaveBeenCalled();
    expect(h.logs.some(s => s.startsWith('decisions'))).toBe(false);
    expect(h.logs.some(s => s.startsWith('kept') && s.includes('replacement prepared'))).toBe(true);
  });

  it('pins accepted mid-turn prompts through Jev and ignores dropped submissions', async () => {
    // Adapted for 0.4.1 brief: retain instructions, never a standing core flag.
    const h = harness();
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    await h.handlers['prompt.submit'](h.$, { text: 'do not run', turnId: 'active', wait: false }, async () => ({ text: 'do not run' }));
    const event = h.event();
    const out = await h.handlers['session.compact'](h.$, event, h.core);
    expect(out.messages.some(row => row.text === 'do not run')).toBe(true);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.$.http.fetch).toHaveBeenCalledTimes(2);
    await h.handlers['prompt.submit'](h.$, { text: 'ignored', turnId: 'active', wait: false }, async () => ({ drop: 'fixture' }));
    const later = await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(later.messages.some(row => row.text === 'ignored')).toBe(false);
    expect(h.$.http.fetch).toHaveBeenCalled();
  });

  it('keeps a prompt accepted during Jev preparation verbatim in this cut', async () => {
    // Adapted for 0.4.1 brief: late arrivals are inserted before returning history.
    const h = harness();
    h.$.http.fetch.mockImplementationOnce(async (url, init) => {
      await h.handlers['prompt.submit'](h.$, { text: 'new', turnId: 'active' }, async () => ({ text: 'new' }));
      return jevFetch(url, init);
    });
    const out = await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(out.messages.some(row => row.text === 'new')).toBe(true);
    expect(h.$.http.fetch).toHaveBeenCalledTimes(1);
    expect(h.core).not.toHaveBeenCalled();
  });

  it('protects internal queued deliveries that bypass prompt.submit', async () => {
    // Adapted for 0.4.1 brief: capture rendered blocks from the observer, pin them.
    const h = harness();
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    const appended = { door: 'delivery', uuid: 'delivery', message: { type: 'attachment', name: 'queued_command', content: [{ kind: 'text', text: 'exact queued instruction' }] } };
    const next = vi.fn(async e => e);
    await h.handlers['session.append'](h.$, appended, next);
    expect(next).toHaveBeenCalledWith(appended);
    const out = await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(out.messages.some(row => row.text === 'exact queued instruction')).toBe(true);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.$.http.fetch).toHaveBeenCalledTimes(2);
  });

  it('044: missing observer content logs and compacts observable transcript on every cut', async () => {
    // User 15:23: only a missed reduction ratio permits built-in summary.
    const h = harness();
    await h.handlers['session.append'](h.$, { door: 'delivery', uuid: 'opaque',
      message: { type: 'attachment' } }, async e => e);
    await h.handlers['session.compact'](h.$, h.event(), async () => ({ skip: 'blocked' }));
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(h.$.http.fetch).toHaveBeenCalledTimes(2);
    expect(h.core).not.toHaveBeenCalled();
    await h.handlers['session.append'](h.$, { door: 'delivery', uuid: 'opaque2',
      message: { type: 'attachment' } }, async e => e);
    const broken = vi.fn(async () => { throw new Error('core failed'); });
    const out = await h.handlers['session.compact'](h.$, h.event(), broken);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(broken).not.toHaveBeenCalled();
    expect(h.logs.join(' ')).toContain('observer omitted content blocks');
  });

  it('does not establish a blanket summary policy when the delivery observer is unavailable', async () => {
    // Adapted for 0.4.1 brief: missing observer is not missing compaction event.
    const handlers: Record<string, Function> = {};
    register(((name: string, handler: Function) => {
      if (name === 'session.append') throw new Error('unsupported');
      handlers[name] = handler;
    }) as any, { apiKey: 'fixture', preserveRecentMessages: 1 });
    const h = harness();
    await handlers['session.compact'](h.$, h.event(), h.core);
    await handlers['session.compact'](h.$, h.event(), h.core);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.$.http.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports post-cut size without triggering a summary', async () => {
    // Adapted for 0.4.1 brief: target is a warning threshold at every value.
    const h = harness({ maxPostCompactTokens: 10 });
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.logs.some(s => s.includes('exceeds target 10'))).toBe(true);
  });

  it('opt-in diagnostics include kept calls as well as dropped results', async () => {
    const h = harness({ logDecisions: true });
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(h.logs.some(s => s.startsWith('decisions:') && s.includes('call=0.90/result=0.10'))).toBe(true);
  });

  it('never compacts the main session in response to a subagent completion', async () => {
    const h = harness();
    const next = vi.fn(async (event: any) => event);
    await h.handlers['turn.complete'](h.$, { agentId: 'child' }, next);
    expect(h.$.session.usage).not.toHaveBeenCalled();
    expect(h.$.session.compact).not.toHaveBeenCalled();
    await h.handlers['turn.complete'](h.$, {}, next);
    expect(h.$.session.compact).toHaveBeenCalledTimes(1);
    expect(h.logs.at(-1)).toBe('applied compaction: 200000 -> 45000 tokens (engine measurement)');
  });

  it('allows only one auto cut after overlapping usage reads', async () => {
    const h = harness();
    let finish!: () => void;
    h.$.session.compact.mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { messages: [], tokensBefore: 200000, tokensAfter: 45000 };
    });
    const next = async e => e;
    const one = h.handlers['turn.complete'](h.$, {}, next);
    const two = h.handlers['turn.complete'](h.$, {}, next);
    await Promise.resolve(); await Promise.resolve();
    expect(h.$.session.compact).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([one, two]);
  });

  it('does not log secret material echoed in a failing transport', async () => {
    const h = harness();
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    h.$.http.fetch.mockImplementation(async () => { throw new Error('fixture-secret-should-not-appear'); });
    await h.handlers['session.compact'](h.$, h.event(), h.core);
    expect(h.logs.join('\n')).not.toContain('fixture-secret-should-not-appear');
  });
});

describe('host reconstruction and resume (#129, #137, #145)', () => {
  it('never hands the host stale handles, even on pinned unchanged rows', () => {
    const input = transcript();
    const out = toSessionMessages(input as any, input);
    expect(out.every(row => row.handle === undefined)).toBe(true);
    expect(out[0]?.text).toBe(input[0]?.text);
    expect(input[0].handle).toBe('old-u'); // input immutable
  });

  it('rebuilds parallel siblings together and keeps both results adjacent', async () => {
    const input = [m('user', 'task'),
      m('assistant', '', { handle: 'row-a', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }] }),
      m('assistant', '', { handle: 'row-b', toolUses: [{ tool_use_id: 'b', tool: 'Read', input: {} }] }),
      m('user', '', { handle: 'res-a', toolResults: [{ tool_use_id: 'a', text: 'x'.repeat(2000), isError: false }] }),
      m('user', '', { handle: 'res-b', toolResults: [{ tool_use_id: 'b', text: 'keep B exactly', isError: false }] }),
      m('user', 'next')];
    const { messages } = await compactSession(input as any, { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'fixture' },
      async (_url, init) => {
        const names = Object.keys(JSON.parse(init!.body!).questions);
        return { status: 200, ok: true, text: JSON.stringify({ answers: Object.fromEntries(names.map(k => [k, { noul: k === 'result_t1' ? 0.1 : 0.9 }])) }) };
      });
    const assistant = messages.find(row => row.toolUses.length)!;
    const at = messages.indexOf(assistant);
    expect(assistant.toolUses.map(t => t.tool_use_id)).toEqual(['a', 'b']);
    expect(messages[at + 1]?.toolResults?.map(t => t.tool_use_id)).toEqual(['a', 'b']);
    expect(messages[at + 1]?.toolResults?.[1]?.text).toBe('keep B exactly');
  });

  it('does not reuse assistant IDs or parents over repeated compact and resume rounds', () => {
    // Contract model pinned to 2.1.299 bpe/Ajt/rlr and append persistence:
    // handle restores message.id/parentUuid; a fresh row lets host mint both.
    type Row = { uuid: string; parentUuid: string | null; id?: string; role: string; text: string };
    let serial = 0;
    const rows: Row[] = [];
    let input: any[] = [m('user', 'constraint'), m('assistant', 'exact evidence')];
    const stable = new Map<string, Row>();
    for (let round = 0; round < 4; round++) {
      const boundary = { uuid: `boundary-${round}`, parentUuid: null, role: 'system', text: '' };
      rows.push(boundary);
      let parent = boundary.uuid;
      const out = toSessionMessages(input, input);
      input = out.map(row => {
        const own = row.handle ? stable.get(row.handle) : undefined;
        const uuid = `uuid-${++serial}`;
        const persisted = { uuid, parentUuid: own?.parentUuid ?? parent,
          id: own?.id ?? (row.role === 'assistant' ? `id-${serial}` : undefined), role: row.role, text: row.text };
        rows.push(persisted); stable.set(uuid, persisted); parent = uuid;
        return { ...row, handle: uuid };
      });
      const chain: Row[] = [];
      let cursor: string | null = parent;
      while (cursor) { const row = rows.find(r => r.uuid === cursor)!; chain.push(row); cursor = row.parentUuid; }
      expect(chain.map(r => r.uuid)).toContain(boundary.uuid);
      expect(chain.filter(r => r.role === 'assistant').map(r => r.text)).toEqual(['exact evidence']);
    }
    const ids = rows.filter(r => r.id).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('estimates visible output once, without double-counting mirrored tool text', () => {
    const input = transcript();
    const baseline = estimateSessionTokens(input);
    input[2].toolUses[0].text = 'mirror'.repeat(100000);
    expect(estimateSessionTokens(input)).toBe(baseline);
    input[3].toolResults[0].text = 'output'.repeat(100000);
    expect(estimateSessionTokens(input)).toBeGreaterThan(baseline);
  });
});
