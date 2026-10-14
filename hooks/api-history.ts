import type { SessionMessage } from 'claude-code';
import { type FidelityLedger } from './fidelity.js';
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
  scope?: string, provenance: readonly string[] = []): void {
  if (!Array.isArray(value) || !value.every(m => m && 'content' in m)) return; // older host/projection fixture
  const api = value as ApiHistoryMessage[];
  const uses = new Map(projected.flatMap((m, i) => m.toolUses.map(t => [t.tool_use_id, i] as const)));
  const results = new Map(projected.flatMap((m, i) => (m.toolResults ?? []).map(t => [t.tool_use_id, i] as const)));
  const text = api.map(m => {
    let value = typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    // Actual API normalization can merge a provenance row with an adjacent
    // user prompt. Remove only exact metadata already verified in the projection.
    for (const marker of provenance) value = value.replace(marker, '');
    return value;
  });
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
  const consumed = new Set<number>();
  let transcriptCursor = 0;
  for (let j = 0; j < api.length; j++) {
    const m = api[j]!;
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [] : m.content;
    const opaque = blocks.filter(b => b.type !== 'text' && b.type !== 'tool_result').map(b => b.type);
    if (opaque.length) {
      // 0.4.2: the text of the row is already what the projection carries; an
      // opaque user block (an image) is noted and dropped, never a built-in summary.
      ledger.note(`API history row ${j}: ${opaque.length} opaque user block(s) not carried handleless (${[...new Set(opaque)].join(', ')}); text kept`);
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
    low = Math.max(low, transcriptCursor);
    const candidates = projected.flatMap((p, i) => i >= low && i < high && !consumed.has(i) && p.role === 'user' && p.text && text[j]!.includes(p.text) ? [i] : []);
    if (prior === undefined && following === undefined && !anchors[j]!.length &&
      candidates.map(i => projected[i]!.text).join('') !== text[j]) {
      ledger.note(`API history row ${j}: no observable anchor; transcript order used at ${low}`);
    }
    if (candidates.some((i, k) => candidates.slice(0, k).some(n => projected[n]!.text === projected[i]!.text))) {
      ledger.note(`API history row ${j}: repeated prompts mapped by occurrence in transcript order`);
    }
    const spans: { start: number; end: number; index: number }[] = [];
    let previousStart = -1;
    for (const index of candidates) {
      const p = projected[index]!;
      let start = text[j]!.indexOf(p.text);
      while (start >= 0 && spans.some(s => start < s.end && start + p.text.length > s.start)) {
        start = text[j]!.indexOf(p.text, start + 1);
      }
      if (start < 0) continue; // API contains fewer occurrences than the projection
      if (start < previousStart) {
        ledger.note(`API history row ${j}: text order conflict at projected row ${index}; transcript order retained`);
      }
      previousStart = start;
      spans.push({ start, end: start + p.text.length, index });
      consumed.add(index);
      transcriptCursor = Math.max(transcriptCursor, index + 1);
    }
    let cursor = 0;
    let last = anchors[j]!.at(-1) ?? prior ?? (low > 0 ? low - 1 : undefined);
    // Cover visible text even when API order conflicts. It stays in transcript
    // order; recover only uncovered spans, so no visible prompt is duplicated.
    for (const span of spans.sort((a, b) => a.start - b.start)) {
      if (span.start > cursor) ledger.recover(text[j]!.slice(cursor, span.start), span.index, projected, scope, claimed);
      cursor = span.end;
      last = span.index;
    }
    if (cursor < text[j]!.length) {
      const position = last === undefined ? following ?? transcriptCursor : last + 1;
      if (last === undefined && following === undefined) ledger.note(`API history row ${j}: hidden text placed by transcript order at ${position}`);
      ledger.recover(text[j]!.slice(cursor), position ?? 0, projected, scope, claimed);
    }
  }
}
