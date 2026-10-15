import { describe, expect, it } from 'vitest';
import { applyDecisions, decideCall } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { normalizeRemovalNotices, REMOVAL_NOTICE } from '../src/removal-notices.js';
import type { Message } from '../src/types.js';

const legacy = '[fast-jev-compaction removed 1 tool call(s) and their results; earlier answers may rely on that evidence]';
const assistant = (text: string, extra: Partial<Message> = {}): Message =>
  ({ role: 'assistant', text, toolUses: [], ...extra });

describe('history removal notice', () => {
  it('replaces hundreds of historical markers with one warning without editing substantive text', () => {
    const input = [assistant('Before\r\n' + legacy + '\r\nAfter'), ...Array.from({ length: 346 }, () => assistant(legacy))];
    const output = normalizeRemovalNotices(input);
    expect(output).toEqual([assistant('Before\r\n' + REMOVAL_NOTICE + '\r\nAfter')]);
    expect(input[0]!.text).toContain(legacy);
    expect(normalizeRemovalNotices(output)).toEqual(output);
    expect(normalizeRemovalNotices(output)[0]).toBe(output[0]);
  });

  it('preserves user text, pinned deliveries, quoted and fenced examples, and tool payloads', () => {
    const quoted = assistant([
      '> ' + legacy, '    ' + legacy, '"' + legacy + '"', '`' + legacy + '`',
      '```text', legacy, '```', '~~~~', legacy, '~~~', legacy, '~~~~',
      'Here is ' + legacy,
    ].join('\n'));
    const user: Message = { role: 'user', text: legacy, toolUses: [] };
    const pinned = assistant(legacy, { pinned: true });
    const payload = assistant(legacy, {
      toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { sample: legacy }, text: legacy }],
      toolResults: [{ tool_use_id: 'a', text: legacy }],
    });
    const output = normalizeRemovalNotices([quoted, user, pinned, assistant(legacy), payload]);
    expect(output.slice(0, 3)).toEqual([quoted, user, pinned]);
    expect(output[0]).toBe(quoted);
    expect(output[3]!.text).toBe(REMOVAL_NOTICE);
    expect(output[4]!.text).toBe('');
    expect(output[4]!.toolUses).toBe(payload.toolUses);
    expect(output[4]!.toolResults).toBe(payload.toolResults);
  });

  it('does not alter ordinary history or marker-like prose', () => {
    const input = [assistant('Nothing removed'), assistant(legacy + ' extra'), assistant('```\n' + legacy)];
    const output = normalizeRemovalNotices(input);
    expect(output).toEqual(input);
    output.forEach((message, index) => expect(message).toBe(input[index]));
  });

  it('adds only one notice for new dropped calls and remains idempotent on later compactions', () => {
    const input: Message[] = [{ role: 'user', text: 'Work', toolUses: [] }, assistant(legacy)];
    for (let index = 0; index < 5; index++) {
      input.push(assistant(index === 0 ? '```unfinished' : 'step ' + index, {
        toolUses: [{ tool_use_id: String(index), tool: 'Read', input: {} }],
      }));
      input.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: String(index), text: 'output' }] });
    }
    const calls = collectToolCalls(input, 0);
    const decisions = calls.map(call => decideCall(call, { keepCall: 0, keepResult: 0 }, { keepThreshold: 0.5 }));
    const output = applyDecisions(input, decisions, calls, 300);
    expect(output.filter(message => message.text.includes(REMOVAL_NOTICE))).toHaveLength(1);
    expect(output.map(message => message.text)).toEqual(['Work', REMOVAL_NOTICE, '```unfinished', 'step 1', 'step 2', 'step 3', 'step 4']);
    expect(output.flatMap(message => message.toolUses)).toEqual([]);
    expect(output.flatMap(message => message.toolResults ?? [])).toEqual([]);
    expect(applyDecisions(output, [], [], 300)).toEqual(output);
    expect(decisions.filter(decision => decision.reason === 'call_dropped')).toHaveLength(5);
  });

  it('creates a notice outside an unfinished fence when there was no previous warning', () => {
    const input: Message[] = [{ role: 'user', text: 'Work', toolUses: [] }, assistant('```unfinished', {
      toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }],
    }), { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'output' }] }];
    const calls = collectToolCalls(input, 0);
    const decisions = calls.map(call => decideCall(call, { keepCall: 0, keepResult: 0 }, { keepThreshold: 0.5 }));
    const output = applyDecisions(input, decisions, calls, 300);
    expect(output[1]!.text).toBe(REMOVAL_NOTICE + '\n```unfinished');
    expect(normalizeRemovalNotices(output)).toEqual(output);
  });
});
