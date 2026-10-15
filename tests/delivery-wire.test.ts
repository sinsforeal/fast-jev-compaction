import { expect, it, vi } from 'vitest';
import { FidelityLedger } from '../hooks/fidelity.js';
import { register } from '../hooks/fast-jev.js';
import { isPinProvenance, pinStoreKey, readPinProvenance, readPinRecord } from '../hooks/pin-provenance.js';
import type { DeliveryContentBlock } from '../hooks/runtime-contract.js';
import type { Message } from '../src/types.js';

const m = (role: Message['role'], text: string, extra = {}): Message => ({ role, text, toolUses: [], ...extra });
const exact = '<system-reminder>' + 'Keep the user instruction exactly. '.repeat(100) + '</system-reminder>';

it.each([
  [{ type: 'text', text: exact }, true],
  [{ kind: 'text', text: exact }, true],
  [{ kind: 'block', type: 'text', text: exact }, false],
  [{ type: 'image', text: exact }, false],
  [{ type: 'text' }, false],
  [{ type: 'text', text: 7 }, false],
  [{ kind: 'text', text: { value: exact } }, false],
] as [DeliveryContentBlock, boolean][])('recognizes only reconstructable text in delivery block %j', (block, accepted) => {
  const ledger = new FidelityLedger();
  ledger.append({ door: 'delivery', uuid: 'wire', message: { type: 'attachment', content: [block] } }, []);
  const prepared = ledger.prepare([]);
  expect(prepared.map(row => row.text)).toEqual(accepted ? [exact] : []);
  expect(prepared.every(row => row.pinned)).toBe(true);
  expect(ledger.takeNotes()).toHaveLength(accepted ? 0 : 1);
});

function harness(store = new Map<string, unknown>()) {
  const handlers: Record<string, Function> = {};
  register(((name: string, ...args: any[]) => { handlers[name] = args.at(-1); }) as any,
    { apiKey: 'fixture', preserveRecentMessages: 1, minReductionRatio: 0, targetVisibleTokens: 0 });
  let rows: Message[] = [m('user', 'task', { handle: 'start' }),
    m('assistant', '', { handle: 'call', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: {} }] }),
    m('user', '', { handle: 'result', toolResults: [{ tool_use_id: 'r', text: 'data '.repeat(6000) }] })];
  const files = new Map<string, string>(); const logs: string[] = [];
  const $ = {
    session: { id: async () => 'wire-session', messages: async (args?: any) => args?.as === 'api' ? [] : rows },
    store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } },
    fs: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p) ?? '',
      write: async (p: string, value: string) => { files.set(p, value); } },
    env: { get: async (key: string) => key === 'DISABLE_AUTO_COMPACT' ? '1' : key === 'USERPROFILE' ? 'F:/fixture' : undefined },
    settings: { read: async () => ({}) }, clock: { sleep: async () => {} },
    http: { fetch: vi.fn(async (_url: string, init: any) => ({ ok: true, status: 200,
      text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(key => [key, { noul: 0 }])) }) })) },
    ui: { log: (line: string) => logs.push(line), toast: vi.fn() },
  };
  const core = vi.fn();
  const append = async (content: DeliveryContentBlock[], uuid: string, agentId?: string, door = 'delivery') => {
    const event = { door, uuid, agentId, origin: { kind: 'human' }, message: { type: 'attachment', content } };
    const next = vi.fn(async e => e);
    expect(await handlers['session.append']($, event, next)).toBe(event);
    expect(next).toHaveBeenCalledWith(event);
  };
  return { $, core, store, logs, files, append, setRows: (next: Message[]) => { rows = next; }, getRows: () => rows,
    cut: (agentId?: string) => handlers['session.compact']($, { trigger: 'manual', messages: rows, agentId }, core) };
}

it('replays 2.1.300 delivery through observer, Jev cut, durable pins and cold restart without UI diagnostics', async () => {
  const h = harness();
  // The live cut supplied type:text with no kind. Omit the delivery from both
  // projected and API histories so only the observer can protect this text.
  await h.append([{ type: 'text', text: exact.slice(0, 50) }, { type: 'text', text: exact.slice(50) }], 'main-delivery');
  await h.append([{ kind: 'text', text: 'legacy exact' }, { type: 'image', source: { type: 'base64' } }], 'mixed');
  h.setRows([...h.getRows(), m('assistant', 'later fact', { handle: 'later' }), m('user', 'continue')]);
  const first = await h.cut();
  expect(h.core).not.toHaveBeenCalled();
  expect(first.messages.filter((row: Message) => row.text === exact)).toHaveLength(1);
  expect(first.messages.findIndex((row: Message) => row.text === exact)).toBeLessThan(first.messages.findIndex((row: Message) => row.text === 'later fact'));
  expect(first.messages.some((row: Message) => isPinProvenance(row.text))).toBe(false);
  expect(first.messages.every((row: Message) => !row.handle)).toBe(true);
  const pins = readPinRecord(h.store.get(pinStoreKey('wire-session')));
  expect(readPinProvenance(first.messages, pins).find(row => row.text === exact)?.pinned).toBe(true);
  expect(h.logs.some(line => line.includes('fidelity:'))).toBe(false);
  expect(h.logs.some(line => line.includes('kept ') && line.includes('no summary'))).toBe(true);
  const disk = [...h.files.values()].join('\n');
  expect(disk).toContain('delivery mixed: 1 opaque block(s) not carried handleless (image)');
  expect(disk).not.toContain('delivery main-delivery');
  expect(disk).not.toContain('Keep the user instruction');
  const resumed = harness(h.store); resumed.setRows(first.messages);
  const second = await resumed.cut();
  expect(second.messages.filter((row: Message) => row.text === exact)).toHaveLength(1);
  expect(second.messages.filter((row: Message) => row.text === 'legacy exact')).toHaveLength(1);
  expect(second.messages.some((row: Message) => isPinProvenance(row.text))).toBe(false);
});

it('pins current wire deliveries arriving during scoring only in the matching child', async () => {
  const h = harness();
  await h.append([], 'call', 'child-a', 'model');
  h.setRows([...h.getRows(), m('assistant', 'later fact', { handle: 'later' }), m('user', 'continue')]);
  const fetch = h.$.http.fetch.getMockImplementation()!;
  h.$.http.fetch.mockImplementationOnce(async (...args) => {
    await h.append([{ type: 'text', text: exact }], 'late-child', 'child-a');
    return fetch(...args);
  });
  const child = await h.cut('child-a');
  expect(child.messages.filter((row: Message) => row.text === exact)).toHaveLength(1);
  expect(child.messages.findIndex((row: Message) => row.text === exact)).toBeLessThan(child.messages.findIndex((row: Message) => row.text === 'later fact'));
  const pins = readPinRecord(h.store.get(pinStoreKey('wire-session', 'child-a')));
  expect(readPinProvenance(child.messages, pins).find(row => row.text === exact)?.pinned).toBe(true);
  expect((await h.cut('child-b')).messages.some((row: Message) => row.text === exact)).toBe(false);
  expect((await h.cut()).messages.some((row: Message) => row.text === exact)).toBe(false);
});
