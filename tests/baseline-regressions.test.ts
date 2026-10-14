// These tests use only APIs exported at b442e6c, so they also run on the pinned
// before revision and demonstrate real regressions instead of import failures.
import { expect, it, vi } from 'vitest';
import { register, toSessionMessages } from '../hooks/fast-jev.ts';
import { compact, truncate, buildJevRequest, applyDecisions, collectToolCalls, decideCall } from '../src/index.js';
const m = (role: 'user' | 'assistant', text: string, extra = {}) => ({ role, text, toolUses: [], ...extra });
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

it('does not report a speculative precompute as a cut', async () => {
  const handlers: Record<string, Function> = {};
  register(((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any, { apiKey: 'fixture', preserveRecentMessages: 0 });
  const fetch = vi.fn(async () => ({ ok: true, status: 200, text: JSON.stringify({ answers: { call_t1: { noul: 0 }, result_t1: { noul: 0 } } }) }));
  const log = vi.fn(), next = vi.fn(async () => ({ messages: [] }));
  const messages = [m('user', 'task'), m('assistant', '', { toolUses: [{ tool_use_id: 't', tool: 'Read', input: {} }] }),
    m('user', '', { toolResults: [{ tool_use_id: 't', text: 'x'.repeat(1000) }] })];
  await handlers['session.compact']({ http: { fetch }, ui: { log, toast: vi.fn() }, clock: { sleep: async () => {} } }, { trigger: 'precompute', messages }, next);
  expect(fetch).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it('drops stale handles even when retained user and assistant text is unchanged', () => {
  const input = [m('user', 'constraint', { handle: 'old-u' }), m('assistant', 'fact', { handle: 'old-a' })];
  expect(toSessionMessages(input as any, input).every(row => row.handle === undefined)).toBe(true);
});

it('keeps a parallel assistant response together when one sibling changes', () => {
  const a = m('assistant', '', { handle: 'a', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }] });
  const b = m('assistant', '', { handle: 'b', toolUses: [{ tool_use_id: 'b', tool: 'Read', input: {} }] });
  expect(toSessionMessages([a, b] as any, [{ ...a, text: 'edited' }, b])).toHaveLength(1);
});

it('never cuts an emoji in half while fitting Jev state', () => {
  expect(lone.test(truncate('a\uD83D\uDD25b'.repeat(5), 3))).toBe(false);
});

it('repairs malformed input before JSON escaping obscures it', () => {
  const body = buildJevRequest({ apiKey: 'fixture' }, { text: '\uD800' }, {}).body;
  expect(lone.test(JSON.parse(body).state.text)).toBe(false);
});

it('marks removed supporting tool evidence', () => {
  const messages = [m('user', 'task'), m('assistant', '', { toolUses: [{ tool_use_id: 't', tool: 'Read', input: {} }] }),
    m('user', '', { toolResults: [{ tool_use_id: 't', text: 'evidence' }] }), m('assistant', 'grounded answer')];
  const calls = collectToolCalls(messages, 0);
  const decisions = calls.map(call => decideCall(call, { keepCall: 0, keepResult: 0 }, { keepThreshold: 0.5 }));
  expect(applyDecisions(messages, decisions, calls, 300).some(row => row.text.includes('earlier answers may rely'))).toBe(true);
});

it('can reduce old assistant text while keeping the user constraint', async () => {
  const messages = [m('user', 'never edit generated files'), m('assistant', 'obsolete explanation '.repeat(300)), m('user', 'next')];
  const out = await compact(messages, { async ask(_state, questions) { return { answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0 }])) }; } }, { preserveRecentMessages: 1 });
  expect(out.messages[1].text.length).toBeLessThan(messages[1].text.length);
  expect(out.messages[0].text).toBe('never edit generated files');
});
