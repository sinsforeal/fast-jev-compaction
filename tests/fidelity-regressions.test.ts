// 0.4.1 brief, 2026-10-14 08:05: all imports exist on 4cc723a.
// Run this same file on that revision; failures must be assertions, not imports.
import { expect, it, vi } from 'vitest';
import { register, resolveHookConfig } from '../hooks/fast-jev.ts';

const m = (role: 'user' | 'assistant', text: string, extra = {}) => ({ role, text, toolUses: [], ...extra });
const history = () => [m('user', 'task', { handle: 'u' }),
  m('assistant', '', { handle: 'a', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: {} }] }),
  m('user', '', { handle: 'r', toolResults: [{ tool_use_id: 'r', text: 'data '.repeat(1200) }] }),
  m('assistant', 'later fact', { handle: 'later' }), m('user', 'continue', { handle: 'last' })];
function harness(options = {}) {
  const handlers: Record<string, Function> = {};
  register(((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any,
    { apiKey: 'fixture', preserveRecentMessages: 1, ...options });
  let rows = history();
  const logs: string[] = [];
  const fetch = vi.fn(async (_url, init) => ({ status: 200, ok: true,
    text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(k => [k, { noul: 0 }])) }) }));
  const $ = { env: { get: async () => undefined }, settings: { read: async () => ({}) },
    http: { fetch }, clock: { sleep: vi.fn(async () => {}) },
    ui: { log: (s: string) => logs.push(s), toast: vi.fn() }, session: { messages: async () => rows } };
  const core = vi.fn(async () => ({ messages: [m('user', 'summary')] }));
  const cut = (extra = {}) => handlers['session.compact']($, { trigger: 'auto', messages: rows, ...extra }, core);
  const setRows = (next: ReturnType<typeof history>) => { rows = next; };
  const append = (text: string, uuid = 'delivery', agentId?: string) => handlers['session.append']($,
    { door: 'delivery', uuid, agentId, message: { type: 'attachment', name: 'queued_command', content: [{ kind: 'text', text }] } }, async e => e);
  return { handlers, $, fetch, logs, core, cut, setRows, append };
}

it('041: post-cut target defaults to measurement-only zero', () => {
  expect(resolveHookConfig({}).maxPostCompactTokens).toBe(0);
});
it('041: first cut after startup/resume rebuilds through Jev', async () => {
  const h = harness(); const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalled();
  expect(out.messages.every(row => !row.handle)).toBe(true);
});
it('041: an exceeded token target warns and keeps Jev at every positive value', async () => {
  const h = harness({ maxPostCompactTokens: 1 }); await h.cut(); await h.cut();
  expect(h.core).not.toHaveBeenCalled();
  expect(h.logs.some(s => s.startsWith('kept ') && s.includes('target 1'))).toBe(true);
  expect(h.logs.some(s => s.startsWith('warn:'))).toBe(true);
});
it('041: no reduction still returns verbatim Jev replacement', async () => {
  const h = harness({ minReductionRatio: 1 }); h.setRows([m('user', 'task'), m('assistant', 'fact')]);
  const out = await h.cut(); expect(h.core).not.toHaveBeenCalled(); expect(out.messages[1].text).toBe('fact');
});
it('041: accepted mid-turn prompt omitted by projection is pinned in chronological order', async () => {
  const h = harness(); h.setRows(history().slice(0, 3));
  const text = '<system-reminder>' + 'do not trade '.repeat(150) + '</system-reminder>';
  await h.handlers['prompt.submit'](h.$, { text, turnId: 'active', wait: false }, async () => ({ text }));
  h.setRows(history()); const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled();
  const index = out.messages.findIndex(row => row.text === text);
  expect(index).toBeGreaterThan(0); expect(out.messages[index + 1].text).toBe('later fact');
});
it('041: hidden delivery is reinserted verbatim and remains pinned on a second cut', async () => {
  const h = harness(); h.setRows(history().slice(0, 3));
  const text = '<system-reminder>' + 'exact notification '.repeat(180) + '</system-reminder>';
  await h.append(text); h.setRows(history());
  const one = await h.cut(); expect(h.core).not.toHaveBeenCalled();
  expect(one.messages.filter(row => row.text === text)).toHaveLength(1);
  h.setRows(one.messages); const two = await h.cut();
  expect(two.messages.filter(row => row.text === text)).toHaveLength(1);
});
it('041: subagent queued rendered attachment remains verbatim without scoring or summary', async () => {
  const h = harness();
  // Scope-specific append UUIDs supply chronology; never read main to place a child delivery.
  await h.handlers['session.append'](h.$, { door: 'model', uuid: 'a', agentId: 'child',
    message: { type: 'assistant', content: [{ kind: 'text', text: '' }] } }, async e => e);
  const text = '<system-reminder>' + 'child result '.repeat(180) + '</system-reminder>';
  await h.append(text, 'child-delivery', 'child');
  const out = await h.cut({ agentId: 'child' }); expect(h.core).not.toHaveBeenCalled();
  expect(out.messages.some(row => row.text === text)).toBe(true);
  expect(h.fetch.mock.calls.every(([, init]) => !Object.values(JSON.parse(init.body).questions).some((q: any) => q.instructions.includes('system reminder')))).toBe(true);
});
it('041: request failure retries once and counts its reason without logging transport text', async () => {
  const h = harness({ logDecisions: true });
  h.fetch.mockImplementation(async () => { throw new Error('sensitive fixture echo'); });
  await h.cut(); await h.cut();
  expect(h.fetch).toHaveBeenCalledTimes(4); expect(h.core).toHaveBeenCalledTimes(2);
  expect(h.logs.some(s => s.includes('fallback counts:') && s.includes('request_failure=2'))).toBe(true);
  expect(h.logs.join('\n')).not.toContain('sensitive fixture echo');
});
it('041: invalid engine answer counts separately from transport failure', async () => {
  const h = harness({ logDecisions: true });
  h.fetch.mockImplementation(async () => ({ status: 200, ok: true, text: '{"answers":{"call_t1":{"noul":2},"result_t1":{"noul":0}}}' }));
  await h.cut();
  expect(h.logs.some(s => s.includes('fallback counts:') && s.includes('invalid_engine_result=1'))).toBe(true);
});

it('041: equal older text is not mistaken for a later hidden instruction across two cuts', async () => {
  const h = harness(); const text = '<system-reminder>' + 'same '.repeat(300) + '</system-reminder>';
  const input = history(); input[0].text = text;
  h.setRows(input.slice(0, 3)); await h.append(text); h.setRows(input);
  const one = await h.cut(); expect(one.messages.filter(m => m.text === text)).toHaveLength(2);
  expect(one.messages.findIndex(m => m.text === text)).toBe(0);
  h.setRows(one.messages); const two = await h.cut();
  expect(two.messages.filter(m => m.text === text)).toHaveLength(2);
  expect(two.messages.findIndex(m => m.text === 'later fact')).toBeGreaterThan(two.messages.findLastIndex(m => m.text === text));
});
it('041: a delayed canonical queued delivery upgrades the provisional attached prompt', async () => {
  const h = harness(); h.setRows(history().slice(0, 3));
  await h.handlers['prompt.submit'](h.$, { text: 'exact prompt', turnId: 'active', wait: false,
    attachments: [{ type: 'document', filename: 'fixture.txt' }] }, async () => ({ text: 'exact prompt', context: ['exact context'] }));
  await h.append('<system-reminder>exact prompt\nexact context</system-reminder>');
  h.setRows(history()); const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled();
  expect(out.messages.filter(m => m.text.includes('exact prompt'))).toHaveLength(1);
});
it('041: two equal queued deliveries remain two verbatim pinned rows', async () => {
  const h = harness(); h.setRows(history().slice(0, 3));
  const text = '<system-reminder>' + 'twice '.repeat(200) + '</system-reminder>';
  await h.append(text, 'd1'); await h.append(text, 'd2'); h.setRows(history());
  const one = await h.cut(); h.setRows(one.messages); const two = await h.cut();
  expect(two.messages.filter(m => m.text === text)).toHaveLength(2);
});
it('041: multiple arrivals during a Jev request neither duplicate old pins nor reorder them', async () => {
  const h = harness(); h.setRows(history().slice(0, 3)); await h.append('first', 'first'); h.setRows(history());
  const initial = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementationOnce(async (...args) => {
    h.setRows(history().slice(0, 3)); await h.append('second', 'second'); await h.append('third', 'third'); h.setRows(history());
    return initial(...args);
  });
  const out = await h.cut();
  expect(out.messages.filter(m => ['first', 'second', 'third'].includes(m.text)).map(m => m.text)).toEqual(['first', 'second', 'third']);
  expect(out.messages.findIndex(m => m.text === 'third')).toBeLessThan(out.messages.findIndex(m => m.text === 'later fact'));
});
it('042: an opaque delivery block is noted and dropped, its text kept, never a built-in summary', async () => {
  // 0.4.2 (User 2026-10-14 11:40 "fix this now"): Ryan's 11:08 cut fell to the built-in summary on
  // "delivery contains opaque blocks unsupported by handleless SessionMessage". The host projection
  // already carries such a delivery as its text blocks; Jev carries the same and logs the drop.
  const h = harness({ logDecisions: true });
  const appended = { door: 'delivery', uuid: 'opaque', message: { type: 'attachment',
    content: [{ kind: 'text', text: 'relayed order' }, { kind: 'block', index: 1, type: 'image' }] } };
  const next = vi.fn(async e => e); await h.handlers['session.append'](h.$, appended, next);
  expect(next).toHaveBeenCalledWith(appended);
  h.setRows([...history().slice(0, 4), m('user', 'relayed order', { handle: 'd' }), m('user', 'continue', { handle: 'last' })]);
  const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalled();
  expect(out.messages.filter(x => x.text === 'relayed order')).toHaveLength(1);
  expect(h.logs.some(s => s.startsWith('fidelity: delivery opaque') && s.includes('1 opaque block(s) not carried handleless (image)'))).toBe(true);
  expect(h.logs.some(s => s.startsWith('fallback '))).toBe(false);
});
it('042: a delivery of only opaque blocks pins nothing and still never summarizes', async () => {
  const h = harness();
  await h.handlers['session.append'](h.$, { door: 'delivery', uuid: 'opaque-only',
    message: { type: 'attachment', content: [{ kind: 'block', index: 0, type: 'image' }] } }, async e => e);
  const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled(); expect(out.messages.filter(x => x.text === '' && x.role === 'user' && !x.toolResults)).toHaveLength(0);
  expect(h.logs.some(s => s.startsWith('fidelity: delivery opaque-only'))).toBe(true);
});
it('042: toasts and log lines are appended to ~/.claude/fast-jev-compaction.log', async () => {
  const h = harness(); const files = new Map<string, string>();
  (h.$ as any).env = { get: async (n: string) => n === 'USERPROFILE' ? 'C:\\Users\\x\\' : undefined };
  (h.$ as any).fs = { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p) ?? '',
    write: async (p: string, t: string) => { files.set(p, t); } };
  await h.cut();
  const text = files.get('C:\\Users\\x/.claude/fast-jev-compaction.log') ?? '';
  expect(text).toMatch(/kept \d+\/\d+ messages/);
  expect(text.split('\n').filter(Boolean).every(l => /^\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true);
  h.fetch.mockImplementation(async () => ({ status: 500, ok: false, text: 'down' }));
  await h.cut();
  const after = files.get('C:\\Users\\x/.claude/fast-jev-compaction.log') ?? '';
  expect(after.startsWith(text)).toBe(true);
  expect(after).toContain('fallback to built-in summary');
});
it('042: a log write failure never changes the cut', async () => {
  const h = harness();
  (h.$ as any).env = { get: async () => 'C:/Users/x' };
  (h.$ as any).fs = { exists: async () => { throw new Error('EACCES'); }, read: async () => { throw new Error('EACCES'); },
    write: async () => { throw new Error('EACCES'); } };
  const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled(); expect(out.messages.length).toBeGreaterThan(0);
});
it('041: malformed answer primitives use the invalid-result fallback, never an unclassified skip', async () => {
  const h = harness({ logDecisions: true });
  h.fetch.mockImplementation(async () => ({ status: 200, ok: true, text: '{"answers":{"call_t1":1,"result_t1":{"noul":0}}}' }));
  await h.cut(); expect(h.core).toHaveBeenCalledTimes(1);
  expect(h.logs.some(s => s.includes('invalid_engine_result=1'))).toBe(true);
});
it('041: local state-budget refusal preserves history without requesting a summary', async () => {
  const h = harness({ maxRequestTokens: 1 }); const out = await h.cut();
  expect(out.skip).toBeDefined(); expect(h.core).not.toHaveBeenCalled();
});
it('041: missing compact event is counted and toasted at the plugin usage request', async () => {
  const handlers: Record<string, Function> = {};
  register(((name: string, ...args: any[]) => { if (name === 'session.compact') throw new Error('unsupported'); handlers[name] = args.at(-1); }) as any,
    { logDecisions: true });
  const logs: string[] = [];
  const $ = { ui: { log: (s: string) => logs.push(s), toast: vi.fn() }, session: {
    usage: async () => ({ context: { percent: 70 } }), compact: vi.fn(async () => ({ messages: [] })) } };
  await handlers['turn.complete']($, {}, async e => e);
  expect(logs.some(s => s.includes('host_without_compaction_event=1'))).toBe(true);
  expect($.ui.toast).toHaveBeenCalledWith(expect.stringContaining('host has no session.compact event'), expect.anything());
});

it('041: canonical delivery arriving during scoring removes the provisional prompt and contexts', async () => {
  const h = harness(); h.setRows(history().slice(0, 3));
  await h.handlers['prompt.submit'](h.$, { text: 'pending text', turnId: 'active', wait: false },
    async () => ({ text: 'pending text', context: ['pending context'] }));
  h.setRows(history()); const initial = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementationOnce(async (...args) => {
    h.setRows(history().slice(0, 3)); await h.append('<system-reminder>pending text\npending context</system-reminder>'); h.setRows(history());
    return initial(...args);
  });
  const out = await h.cut();
  expect(out.messages.filter(m => m.text.includes('pending text'))).toHaveLength(1);
  expect(out.messages.filter(m => m.text.includes('pending context'))).toHaveLength(1);
});
it('041: a projected joined prompt and two contexts remains one pinned exact row', async () => {
  const h = harness(); h.setRows(history().slice(0, 3));
  await h.handlers['prompt.submit'](h.$, { text: 'prompt', turnId: 'active', wait: false },
    async () => ({ text: 'prompt', context: ['ctx1', 'ctx2'] }));
  const rows = history(); rows.splice(3, 0, m('user', 'promptctx1ctx2', { handle: 'joined' })); h.setRows(rows);
  const out = await h.cut(); expect(out.messages.filter(m => m.text.includes('ctx'))).toHaveLength(1);
  expect(out.messages.find(m => m.text.includes('ctx')).text).toBe('promptctx1ctx2');
});
it('041: an unrelated simultaneous notification never suppresses a submitted prompt', async () => {
  const h = harness(); h.setRows(history().slice(0, 3));
  await h.handlers['prompt.submit'](h.$, { text: 'typed instruction', turnId: 'active', wait: false }, async () => {
    await h.handlers['session.append'](h.$, { door: 'delivery', uuid: 'notification', origin: { kind: 'engine' },
      message: { type: 'attachment', name: 'queued_command', content: [{ kind: 'text', text: 'unrelated notification quotes typed instruction' }] } }, async e => e);
    return { text: 'typed instruction' };
  });
  h.setRows(history()); const out = await h.cut();
  expect(out.messages.some(m => m.text === 'typed instruction')).toBe(true);
  expect(out.messages.some(m => m.text === 'unrelated notification quotes typed instruction')).toBe(true);
});
const apiHistory = (hidden: string) => [
  { role: 'user', content: [{ type: 'text', text: 'task' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'data '.repeat(1200) }, { type: 'text', text: hidden }] },
  { role: 'assistant', content: [{ type: 'text', text: 'later fact' }] },
  { role: 'user', content: [{ type: 'text', text: 'continue' }] },
];
it('041: first cut after resume recovers historic queued text from the actual API-tail contract', async () => {
  const h = harness(); const hidden = '<system-reminder>' + 'historic exact instruction '.repeat(100) + '</system-reminder>';
  h.$.session.messages = async (args?: any) => args?.as === 'api' ? apiHistory(hidden) as any : history();
  const one = await h.cut(); expect(h.core).not.toHaveBeenCalled();
  expect(one.messages.filter(m => m.text === hidden)).toHaveLength(1);
  expect(one.messages.findIndex(m => m.text === hidden)).toBeLessThan(one.messages.findIndex(m => m.text === 'later fact'));
  h.setRows(one.messages); h.$.session.messages = async () => one.messages;
  const two = await h.cut(); expect(two.messages.filter(m => m.text === hidden)).toHaveLength(1);
});
it('041: resumed child API snapshots select the child and preserve the main scope', async () => {
  const h = harness(); const reads: any[] = [];
  h.$.session.messages = async (args?: any) => { reads.push(args); return args?.agentId === 'child' ? apiHistory('child attachment exact') as any : history(); };
  const child = await h.cut({ agentId: 'child' });
  expect(child.messages.some(m => m.text === 'child attachment exact')).toBe(true);
  expect(reads).toContainEqual({ as: 'api', agentId: 'child' });
  const main = await h.cut(); expect(main.messages.some(m => m.text === 'child attachment exact')).toBe(false);
});
it('041: a bounded API tail never replaces or drops the older projected prefix', async () => {
  const h = harness(); const rows = [m('user', 'ancient constraint', { handle: 'ancient' }), ...history()]; h.setRows(rows);
  h.$.session.messages = async (args?: any) => args?.as === 'api' ? apiHistory('tail hidden') as any : rows;
  const out = await h.cut(); expect(out.messages[0].text).toBe('ancient constraint');
  expect(out.messages.some(m => m.text === 'tail hidden')).toBe(true); expect(h.core).not.toHaveBeenCalled();
});
it('041: API hidden text in the same user block as the prompt is kept verbatim', async () => {
  const h = harness(); const hidden = '<system-reminder>historic extension</system-reminder>';
  const api = apiHistory(''); api[0].content = [{ type: 'text', text: 'task' + hidden }] as any;
  h.$.session.messages = async (args?: any) => args?.as === 'api' ? api as any : history();
  const out = await h.cut(); expect(out.messages.filter(m => m.text === hidden)).toHaveLength(1);
  expect(out.messages.filter(m => m.text === 'task')).toHaveLength(1); expect(h.core).not.toHaveBeenCalled();
});
it('042: opaque legacy API content is noted, its text kept, never a fallback', async () => {
  const h = harness(); const api = apiHistory(''); api[0].content.push({ type: 'image', source: { type: 'base64', data: 'fixture' } } as any);
  h.$.session.messages = async (args?: any) => args?.as === 'api' ? api as any : history();
  await h.cut();
  expect(h.logs.some(s => s.startsWith('fidelity: API history row') && s.includes('opaque user block(s) not carried handleless (image)'))).toBe(true);
  expect(h.logs.some(s => s.startsWith('fallback '))).toBe(false);
  expect(h.core).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalled();
});

it('041: fully visible equal prompts merged by the API never trigger a hidden-text fallback', async () => {
  const h = harness(); const rows = [m('user', 'same'), m('user', 'same'), m('assistant', 'unique fact')]; h.setRows(rows);
  h.$.session.messages = async (args?: any) => args?.as === 'api' ? [
    { role: 'user', content: [{ type: 'text', text: 'samesame' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'unique fact' }] },
  ] as any : rows;
  const out = await h.cut(); expect(h.core).not.toHaveBeenCalled();
  expect(out.messages.filter(m => m.text === 'same')).toHaveLength(2);
});
it('041: bounded hidden tail quoting an older prompt stays whole immediately before its tail anchor', async () => {
  const h = harness(); const rows = [m('user', 'task'), m('assistant', 'old fact'), m('assistant', 'tail fact')]; h.setRows(rows);
  h.$.session.messages = async (args?: any) => args?.as === 'api' ? [
    { role: 'user', content: [{ type: 'text', text: 'hidden delivery quotes task' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'tail fact' }] },
  ] as any : rows;
  const out = await h.cut(); expect(h.core).not.toHaveBeenCalled();
  expect(out.messages[0].text).toBe('task'); expect(out.messages[1].text).toBe('old fact');
  expect(out.messages[2].text).toBe('hidden delivery quotes task'); expect(out.messages[3].text).toBe('tail fact');
});
it('041: recovered delivery stays pinned after a new registration and four resume rounds', async () => {
  const hidden = '<system-reminder>' + 'durable exact instruction '.repeat(120) + '</system-reminder>';
  const initial = harness(); initial.$.session.messages = async (args?: any) => args?.as === 'api' ? apiHistory(hidden) as any : history();
  let rows = (await initial.cut()).messages;
  for (let i = 0; i < 4; i++) {
    const resumed = harness(); resumed.setRows(rows);
    resumed.$.session.messages = async (args?: any) => args?.as === 'api' ? rows.map(m => ({ role: m.role, content: [{ type: 'text', text: m.text }] })) as any : rows;
    rows = (await resumed.cut()).messages;
    expect(resumed.core).not.toHaveBeenCalled(); expect(rows.filter(m => m.text === hidden)).toHaveLength(1);
    expect(rows.filter(m => m.text.startsWith('[fast-jev-compaction pinned delivery provenance'))).toHaveLength(1);
    expect(rows.every(m => !m.handle)).toBe(true);
  }
});
it('041: additional hidden API text without a chronology anchor uses a specific one-cut exception', async () => {
  const h = harness(); h.setRows([m('user', 'task')]);
  h.$.session.messages = async (args?: any) => args?.as === 'api' ? [{ role: 'user', content: [{ type: 'text', text: 'task hidden extra' }] }] as any : [m('user', 'task')];
  await h.cut(); expect(h.logs.some(s => s.includes('API hidden-text chronology has no observable anchor'))).toBe(true);
  h.$.session.messages = async () => [m('user', 'task')]; await h.cut(); expect(h.core).toHaveBeenCalledTimes(1);
});

it('041: actual API adjacent-user normalization never duplicates provenance on reload', async () => {
  const hidden = '<system-reminder>' + 'normalized exact instruction '.repeat(120) + '</system-reminder>';
  const initial = harness(); initial.$.session.messages = async (args?: any) => args?.as === 'api' ? apiHistory(hidden) as any : history();
  let rows = (await initial.cut()).messages;
  for (let round = 0; round < 4; round++) {
    const resumed = harness(); resumed.setRows(rows);
    const api: any[] = [];
    for (const row of rows) {
      const last = api.at(-1);
      if (row.role === 'user' && last?.role === 'user') last.content[0].text += row.text;
      else api.push({ role: row.role, content: [{ type: 'text', text: row.text }] });
    }
    resumed.$.session.messages = async (args?: any) => args?.as === 'api' ? api as any : rows;
    rows = (await resumed.cut()).messages;
    expect(resumed.core).not.toHaveBeenCalled(); expect(rows.filter(m => m.text === hidden)).toHaveLength(1);
    expect(rows.filter(m => m.text.startsWith('[fast-jev-compaction pinned delivery provenance'))).toHaveLength(1);
  }
});
