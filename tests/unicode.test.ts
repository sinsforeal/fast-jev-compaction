import { describe, expect, it } from 'vitest';
import { safeSlice } from '../src/unicode.js';
import { buildJevRequest, truncate, fitState, resolveOptions, compact } from '../src/index.js';

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const msg = (role: 'user' | 'assistant', text: string) => ({ role, text, toolUses: [] });

describe('valid Unicode at every cut and transport boundary (#128)', () => {
  it('does not split either edge of a surrogate pair', () => {
    const source = 'a\uD83D\uDD25b';
    expect(lone.test(source.slice(0, 2))).toBe(true); // negative twin
    expect(safeSlice(source, 0, 2)).toBe('a');
    expect(safeSlice(source, 2)).toBe('b');
    expect(safeSlice(source, -2)).toBe('b');
    expect(safeSlice(source, 0, 3)).toBe('a\uD83D\uDD25');
    expect(lone.test(truncate(source.repeat(50), 3))).toBe(false);
  });

  it('repairs source lone surrogates before stringify escapes them', () => {
    const body = buildJevRequest({ apiKey: 'fixture' }, { text: 'bad\uD800', nested: ['\uDC00'] }, {
      a: { type: 'noul', instructions: 'bad\uD800' },
    }).body;
    const parsed = JSON.parse(body);
    expect(parsed.state).toEqual({ text: 'bad\uFFFD', nested: ['\uFFFD'] });
    expect(parsed.questions.a.instructions).toBe('bad\uFFFD');
    expect(body).not.toMatch(/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/);
  });

  it('keeps fitted head and tail text valid with emoji exactly on their edges', () => {
    const text = 'a'.repeat(399) + '\uD83D\uDD25' + 'z'.repeat(3500) + '\uD83D\uDD25' + 'b'.repeat(149);
    const options = { ...resolveOptions(), maxStateTokens: 800, preserveRecentMessages: 0 };
    const state = fitState([msg('user', 'task'), msg('assistant', text)], [], options);
    expect(lone.test(JSON.stringify(state.state))).toBe(false);
    for (const entry of state.state.history) expect(lone.test(entry.text)).toBe(false);
  });

  it('keeps truncated tool results and abridged replies valid', async () => {
    const text = 'a'.repeat(299) + '\uD83D\uDD25' + 'z'.repeat(3000);
    const reply = 'a'.repeat(599) + '\uD83D\uDD25' + 'z'.repeat(3000) + '\uD83D\uDD25' + 'b'.repeat(299);
    const transcript = [msg('user', 'task'),
      { ...msg('assistant', reply), toolUses: [{ tool_use_id: 't', tool: 'Read', input: {}, text }] },
      { ...msg('user', ''), toolResults: [{ tool_use_id: 't', text }] }, msg('user', 'next')];
    const out = await compact(transcript, { async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: k.startsWith('call') ? 1 : 0 }])) };
    } }, { preserveRecentMessages: 1 });
    for (const m of out.messages) {
      expect(lone.test(m.text)).toBe(false);
      for (const r of m.toolResults ?? []) expect(lone.test(r.text)).toBe(false);
    }
    expect(out.stats.repliesAbridged).toBe(1);
  });
});
