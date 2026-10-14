import type { SessionMessage } from 'claude-code';
import { FidelityError, type FidelityLedger } from './fidelity.js';
import { isPinProvenance } from './pin-provenance.js';

/** Supplemental 2.1.299 contract: W2o/IXt expose a bounded API tail for the
 * requested loop, including rendered attachments omitted by kpe/bpe.rowsOf.
 * Generated 2.1.274 declarations predate these arguments; leave them untouched.
 */
export type ApiHistoryMessage = { role: 'user' | 'assistant'; content: string | readonly {
  type: string; text?: string; id?: string; tool_use_id?: string; [key: string]: unknown;
}[] };
export type RuntimeMessages = (args: { agentId?: string; as: 'api' }) => Promise<readonly ApiHistoryMessage[]>;

/** Recover only observable extra user text, aligning it to actual projected
 * text/tool IDs. Never replace the whole history with the bounded API tail.
 */
export function recoverApiHistory(value: unknown, projected: readonly SessionMessage[], ledger: FidelityLedger,
  scope?: string): void {
  if (!Array.isArray(value) || !value.every(m => m && 'content' in m)) return; // older host/projection fixture
  const api = value as ApiHistoryMessage[];
  const uses = new Map(projected.flatMap((m, i) => m.toolUses.map(t => [t.tool_use_id, i] as const)));
  const results = new Map(projected.flatMap((m, i) => (m.toolResults ?? []).map(t => [t.tool_use_id, i] as const)));
  const text = api.map(m => typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text ?? '').join(''));
  const anchors = api.map((m, j) => {
    const blocks = typeof m.content === 'string' ? [] : m.content;
    const ids = blocks.flatMap(b => {
      const index = b.type === 'tool_use' ? uses.get(b.id!) : b.type === 'tool_result' ? results.get(b.tool_use_id!) : undefined;
      return index === undefined ? [] : [index];
    });
    if (ids.length) return [...new Set(ids)].sort((a, b) => a - b);
    // Assistant exact text is a reliable anchor. User text quoted inside an
    // attachment is not evidence that the older prompt belongs to this API tail.
    const candidates = projected.flatMap((p, i) => m.role === 'assistant' && p.role === m.role && p.text !== '' && text[j] === p.text ? [i] : []);
    return candidates.length === 1 ? candidates : [];
  });
  const claimed = new Set<number>();
  for (let j = 0; j < api.length; j++) {
    const m = api[j]!;
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [] : m.content;
    if (blocks.some(b => b.type !== 'text' && b.type !== 'tool_result')) {
      throw new FidelityError('API history contains opaque user blocks unsupported by handleless SessionMessage');
    }
    if (!text[j]) continue;
    if (isPinProvenance(text[j]!)) continue;
    const prior = anchors.slice(0, j).flat().at(-1);
    const following = anchors.slice(j + 1).flat()[0];
    let low = prior === undefined ? 0 : prior + 1;
    const high = following === undefined ? projected.length : following;
    if (prior === undefined && following !== undefined && !anchors[j]!.length) {
      // Only the contiguous user group immediately preceding the first known
      // tail anchor can share its API row. Retain any earlier prefix unchanged.
      low = following;
      while (low > 0 && projected[low - 1]!.role === 'user') low--;
    }
    const matches = projected.flatMap((p, i) => i >= low && i < high && p.role === 'user' && p.text && text[j]!.includes(p.text) ? [i] : []);
    if (prior === undefined && following === undefined && !anchors[j]!.length &&
      matches.map(i => projected[i]!.text).join('') !== text[j]) {
      throw new FidelityError('API hidden-text chronology has no observable anchor');
    }
    // Multiple occurrences of the same short prompt cannot establish position
    // unless the API's neighbouring tool/text anchors disambiguate them.
    if (matches.some((i, k) => matches.slice(0, k).some(n => projected[n]!.text === projected[i]!.text))) {
      if (matches.map(i => projected[i]!.text).join('') === text[j]) continue;
      if (matches.every(i => projected[i]!.text === text[j])) continue; // no observable extra content
      throw new FidelityError('API hidden-text chronology ambiguous between repeated projected prompts');
    }
    let cursor = 0;
    let last = anchors[j]!.at(-1) ?? prior;
    for (const index of matches) {
      const p = projected[index]!;
      const start = text[j]!.indexOf(p.text, cursor);
      if (start < 0) throw new FidelityError('API text order conflicts with compaction projection');
      if (start > cursor) ledger.recover(text[j]!.slice(cursor, start), index, projected, scope, claimed);
      cursor = start + p.text.length;
      last = index;
    }
    if (cursor < text[j]!.length) {
      const position = last === undefined ? following : last + 1;
      if (position === undefined && projected.length) throw new FidelityError('API hidden-text chronology has no observable anchor');
      ledger.recover(text[j]!.slice(cursor), position ?? 0, projected, scope, claimed);
    }
  }
}
