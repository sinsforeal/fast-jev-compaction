// All imports exist on pinned 38b2b03. Run the same tests there.
import { expect, it, vi } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import { recoverApiHistory } from '../hooks/api-history.ts';
import { FidelityLedger } from '../hooks/fidelity.ts';

const m = (role: 'user' | 'assistant', text: string, extra = {}) => ({ role, text, toolUses: [], ...extra });
const history = () => [m('user', 'task', { handle: 'u' }),
  m('assistant', '', { handle: 'a', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: {} }] }),
  m('user', '', { handle: 'r', toolResults: [{ tool_use_id: 'r', text: 'data '.repeat(2000) }] }),
  m('assistant', 'fact'), m('user', 'continue')];
const api = (text: string) => ({ role: 'user', content: text });
function harness(options = {}, unsupported = false) {
  const handlers: Record<string, Function> = {};
  register(((name: string, ...args: any[]) => {
    if (unsupported && name === 'session.compact') throw new Error('unsupported');
    handlers[name] = args.at(-1);
  }) as any, { apiKey: 'fixture', preserveRecentMessages: 1, ...options });
  const files = new Map<string, string>(); const logs: string[] = [];
  const rows = history();
  const fetch = vi.fn(async (_url, init) => ({ status: 200, ok: true,
    text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(k => [k, { noul: 0 }])) }) }));
  const $ = { env: { get: async (k: string) => k === 'DISABLE_AUTO_COMPACT' ? '1' : 'F:/temp/jev-fixture' }, settings: { read: async () => ({}) },
    fs: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p) ?? '',
      write: async (p: string, text: string) => { files.set(p, text); } },
    http: { fetch }, clock: { sleep: async () => {} },
    ui: { log: (s: string) => logs.push(s), toast: vi.fn() }, session: {
      messages: async (_args?: any): Promise<any[]> => rows,
      usage: async () => ({ context: { percent: 70 } }), compact: vi.fn(async () => ({ messages: [] })) } };
  const core = vi.fn(async () => ({ messages: [m('user', 'core summary')] }));
  const cut = () => handlers['session.compact']($, { trigger: 'auto', messages: rows }, core);
  const disk = () => [...files.values()].join('');
  return { $, rows, handlers, core, fetch, cut, disk, logs };
}

it('044 repeated_one_word_three_times_maps_kth_occurrence', () => {
  const rows = [m('user', 'go', { handle: 'one' }), m('user', 'go', { handle: 'two' }), m('user', 'go', { handle: 'three' })];
  const ledger = new FidelityLedger();
  expect(() => recoverApiHistory([api('go first'), api('go second'), api('go third')], rows, ledger)).not.toThrow();
  expect(ledger.prepare(rows).map(m => m.text)).toEqual(['go', ' first', 'go', ' second', 'go', ' third']);
  expect(ledger.takeNotes().join(' ')).toContain('transcript order');
});
it('044 no_anchor_uses_transcript_order', () => {
  const rows = [m('user', 'task')]; const ledger = new FidelityLedger();
  expect(() => recoverApiHistory([api('task hidden')], rows, ledger)).not.toThrow();
  expect(ledger.prepare(rows).map(m => m.text)).toEqual(['task', ' hidden']);
  expect(ledger.takeNotes().join(' ')).toContain('no observable anchor');
});
it('044 repeated_prompts_between_anchors_resolve', () => {
  const rows = [m('assistant', 'left'), m('user', 'go'), m('user', 'go'), m('user', 'go'), m('assistant', 'right')];
  const ledger = new FidelityLedger();
  expect(() => recoverApiHistory([{ role: 'assistant', content: 'left' }, api('go firstgo secondgo third'),
    { role: 'assistant', content: 'right' }], rows, ledger)).not.toThrow();
  expect(ledger.prepare(rows).map(m => m.text)).toEqual(['left', 'go', ' first', 'go', ' second', 'go', ' third', 'right']);
});
it('044 conflicting_text_order_retains_transcript_and_hidden_text', () => {
  const rows = [m('assistant', 'left'), m('user', 'alpha'), m('user', 'beta'), m('assistant', 'right')];
  const ledger = new FidelityLedger();
  expect(() => recoverApiHistory([{ role: 'assistant', content: 'left' }, api('beta alpha extra'),
    { role: 'assistant', content: 'right' }], rows, ledger)).not.toThrow();
  expect(ledger.prepare(rows).filter(m => !m.pinned).map(m => m.text)).toEqual(['left', 'alpha', 'beta', 'right']);
  expect(ledger.prepare(rows).filter(m => m.pinned).map(m => m.text)).toEqual([' ', ' extra']);
  expect(ledger.prepare(rows).some(m => m.text === ' extra')).toBe(true);
  expect(ledger.takeNotes().join(' ')).toContain('text order conflict');
});
it('044 hidden_only_without_anchor_is_placed', () => {
  const rows = [m('assistant', 'older')]; const ledger = new FidelityLedger();
  expect(() => recoverApiHistory([api('hidden only')], rows, ledger)).not.toThrow();
  expect(ledger.prepare(rows).map(m => m.text)).toEqual(['hidden only', 'older']);
});
it('044 separate_api_row_conflict_never_duplicates_visible_prompts', () => {
  const rows = [m('user', 'alpha'), m('user', 'beta')]; const ledger = new FidelityLedger();
  expect(() => recoverApiHistory([api('beta first'), api('alpha second')], rows, ledger)).not.toThrow();
  expect(ledger.prepare(rows).map(m => m.text)).toEqual(['alpha', ' second', 'beta', ' first']);
  expect(ledger.takeNotes().join(' ')).toContain('text order conflict');
});
it('044 repeated_prompt_recovery_survives_four_normalized_reloads', async () => {
  let rows: any[] = [m('user', 'go'), m('user', 'go'), m('user', 'go'), m('assistant', 'end')];
  for (let round = 0; round < 4; round++) {
    const h = harness({ minReductionRatio: -100 }); h.rows.splice(0, h.rows.length, ...rows);
    const tail: any[] = round === 0 ? [api('go firstgo secondgo third'), { role: 'assistant', content: 'end' }] : [];
    if (round > 0) for (const row of rows) {
      if (row.role === 'user' && tail.at(-1)?.role === 'user') tail.at(-1).content += row.text;
      else tail.push({ role: row.role, content: row.text });
    }
    h.$.session.messages = async args => args?.as === 'api' ? tail : rows;
    rows = (await h.cut()).messages; expect(h.core).not.toHaveBeenCalled();
    expect(rows.filter(m => m.text === 'go')).toHaveLength(3);
    expect(rows.filter(m => [' first', ' second', ' third'].includes(m.text)).map(m => m.text)).toEqual([' first', ' second', ' third']);
    expect(rows.filter(m => m.text.startsWith('[fast-jev-compaction pinned delivery provenance'))).toHaveLength(1);
  }
});
for (const [name, fail] of [
  ['http_error', async () => ({ status: 500, ok: false, text: 'down' })],
  ['transport_error', async () => { throw new Error('network'); }],
  ['invalid_engine_result', async () => ({ status: 200, ok: true, text: '{"answers":{}}' })],
] as const) it(`044 ${name}_compacts_transcript_and_logs_reason`, async () => {
  const h = harness(); h.fetch.mockImplementation(fail as any);
  const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled(); expect(out.skip).toBeUndefined();
  expect(out.messages.some(m => m.toolUses.some(t => t.tool_use_id === 'r'))).toBe(true);
  expect(out.messages.find(m => m.toolResults?.length).toolResults[0].text.length).toBeLessThan(1000);
  expect(out.messages.filter(m => m.role === 'user' && m.text).map(m => m.text)).toEqual(['task', 'continue']);
  expect(h.disk()).toContain('Jev transcript recovery'); expect(h.disk()).not.toContain('fallback to built-in summary');
});
it('044 missing_key_compacts_transcript', async () => {
  const h = harness({ apiKey: '' }); h.$.env.get = async () => undefined as any;
  const out = await h.cut(); expect(h.core).not.toHaveBeenCalled(); expect(out.messages.length).toBeGreaterThan(0);
  expect(h.logs.join(' ')).toContain('TYPESAFE_API_KEY is not configured');
});
it('044 local_budget_failure_compacts_transcript', async () => {
  const h = harness({ maxRequestTokens: 1 }); const out = await h.cut();
  expect(out.skip).toBeUndefined(); expect(h.core).not.toHaveBeenCalled();
  expect(h.disk()).toContain('local transcript preparation or scoring failed');
});
it('044 recovery_ignores_scoring_threshold_and_keeps_late_delivery', async () => {
  const h = harness({ keepThreshold: 2 });
  h.fetch.mockImplementation(async () => {
    await h.handlers['session.append'](h.$, { door: 'delivery', uuid: 'late',
      message: { type: 'attachment', content: [{ kind: 'text', text: 'late instruction' }] } }, async e => e);
    return { status: 422, ok: false, text: 'rejected' };
  });
  const out = await h.cut(); expect(h.core).not.toHaveBeenCalled();
  expect(out.messages.some(m => m.toolUses.some(t => t.tool_use_id === 'r'))).toBe(true);
  expect(out.messages.filter(m => m.text === 'late instruction')).toHaveLength(1);
});
it('044 omitted_delivery_content_keeps_observable_transcript', async () => {
  const h = harness(); await h.handlers['session.append'](h.$,
    { door: 'delivery', uuid: 'missing', message: { type: 'attachment' } }, async e => e);
  const out = await h.cut(); expect(h.core).not.toHaveBeenCalled(); expect(out.messages[0].text).toBe('task');
  expect(h.disk()).toContain('observer omitted content blocks');
});
it('044 notify_failure_does_not_lose_replacement_or_disk_reason', async () => {
  const h = harness(); h.$.ui.toast.mockImplementation(() => { throw new Error('toast failed'); });
  h.$.ui.log = () => { throw new Error('ui failed'); };
  const out = await h.cut(); expect(h.core).not.toHaveBeenCalled(); expect(out.messages.length).toBeGreaterThan(0);
  expect(h.disk()).toContain('kept ');
});
it('044 host_without_event_never_calls_builtin_compactor', async () => {
  const h = harness({}, true); await h.handlers['turn.complete'](h.$, {}, async e => e);
  expect(h.$.session.compact).not.toHaveBeenCalled();
  expect(h.disk()).toContain('host has no session.compact event');
});
it('044 reduction_ratio_is_the_only_core_fallback', async () => {
  const h = harness({ minReductionRatio: 1 }); const out = await h.cut();
  expect(h.core).not.toHaveBeenCalled(); expect(out.skip).toBeDefined(); expect(h.disk()).toContain('below 100% minimum');
});
