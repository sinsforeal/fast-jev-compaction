import type { SessionMessage } from 'claude-code';
import type { Message } from '../src/types.js';
import type { DeliveryAppend } from './runtime-contract.js';

// These are safe fixed reasons. Never include arbitrary message/error content.
export class FidelityError extends Error {}
type RecordRow = {
  serial: number; scope?: string; uuid?: string; text?: string; problem?: string;
  anchor: string[]; sequence: number; prompt?: boolean;
  occurrence: number;
  promptGroup?: number; origin?: string;
  queued?: boolean; beforeUuid?: string;
};
const key = (m: SessionMessage | Message): string => JSON.stringify({ role: m.role, text: m.text,
  uses: m.toolUses.map(t => [t.tool_use_id, t.tool, t.input]),
  results: m.toolResults?.map(t => [t.tool_use_id, t.text, t.isError]) });

/** Session-local observer ledger. UUIDs order deliveries; snapshots anchor prompts.
 * Nothing is persisted and a reconstruction refusal applies only to this cut.
 */
export class FidelityLedger {
  private serial = 0;
  private sequence = 0;
  private rows: RecordRow[] = [];
  private timeline: { uuid: string; scope?: string; sequence: number }[] = [];
  private notes: string[] = [];

  /** Add a fidelity note for the next log flush (0.4.2). Fixed wording only, never message content. */
  note(text: string): void { this.notes.push(text); }
  /** Drain the fidelity notes accumulated since the last flush. */
  takeNotes(): string[] { const out = this.notes; this.notes = []; return out; }

  checkpoint(): number { return this.serial; }
  position(): number { return this.sequence; }

  append(event: DeliveryAppend, snapshot: readonly SessionMessage[]): void {
    const sequence = ++this.sequence;
    this.timeline.push({ uuid: event.uuid, scope: event.agentId, sequence });
    if (event.door !== 'delivery') return;
    const content = event.message.content;
    const problem = !content ? 'delivery observer omitted content blocks' : undefined;
    // 0.4.2: an opaque block (an image, a non-text attachment block) cannot ride a
    // handleless SessionMessage. The host's own projection already carries such a
    // delivery as its text blocks joined; carry exactly that, note the dropped kinds
    // for the log, and never spend the whole cut on a built-in summary for it.
    const opaque = content ? content.filter(b => b.kind !== 'text' || typeof b.text !== 'string')
      .map(b => { const t = (b as { type?: unknown }).type; return typeof t === 'string' ? t : String(b.kind ?? 'unknown'); }) : [];
    const text = problem ? undefined : content!.map(b => (b.kind === 'text' && typeof b.text === 'string') ? b.text : '').join('');
    if (opaque.length) {
      this.notes.push(`delivery ${event.uuid}${event.agentId ? ` (agent ${event.agentId})` : ''}: ${opaque.length} opaque block(s) not carried handleless (${[...new Set(opaque)].join(', ')}); text blocks kept verbatim`);
      if (text === '') return; // nothing reconstructable here; the host projection holds the same
    }
    // prompt.submit can settle before the queue is delivered. Upgrade exactly
    // one pending submission group when the canonical queued-command arrives.
    // Scope, provenance, whole prompt and every context block must all agree.
    if (event.message.name === 'queued_command' && text !== undefined) {
      const origin = JSON.stringify(event.origin ?? { kind: 'human' });
      const groups = new Set(this.rows.filter(r => r.prompt && r.scope === event.agentId && r.origin === origin).map(r => r.promptGroup));
      for (const group of groups) {
        const candidates = this.rows.filter(r => r.promptGroup === group);
        if (candidates.every(r => text.includes(r.text!))) {
          this.rows = this.rows.filter(r => r.promptGroup !== group);
          break; // equal submissions are distinct deliveries, oldest pending first
        }
      }
    }
    this.rows.push({ serial: ++this.serial, scope: event.agentId, uuid: event.uuid,
      sequence, anchor: snapshot.map(key), problem,
      queued: event.message.name === 'queued_command', origin: JSON.stringify(event.origin ?? { kind: 'human' }),
      occurrence: snapshot.filter(m => m.role === 'user' && m.text === content?.map(b => b.text ?? '').join('')).length,
      text });
  }

  prompt(text: string, context: readonly string[], attachments: boolean,
    snapshot: readonly SessionMessage[], since: number, origin?: unknown): void {
    // A queued prompt may be rendered as a delivery during next(). That canonical
    // observer row already holds its exact wrappers and position: do not duplicate it.
    const delivered = this.rows.some(r => r.scope === undefined && r.sequence > since && r.queued &&
      r.origin === JSON.stringify(origin ?? { kind: 'human' }) &&
      r.text !== undefined && r.text.includes(text) && context.every(c => r.text!.includes(c)));
    if (delivered) return;
    const group = this.serial + 1;
    for (const value of [text, ...context]) this.rows.push({ serial: ++this.serial,
      sequence: this.sequence + 0.5, anchor: snapshot.map(key), prompt: true, text: value,
      promptGroup: group, origin: JSON.stringify(origin ?? { kind: 'human' }),
      occurrence: snapshot.filter(m => m.role === 'user' && m.text.includes(value)).length,
      problem: attachments ? 'prompt attachments expose metadata only; no reconstructable delivery observed' : undefined });
  }

  prepare(messages: readonly SessionMessage[], scope?: string): Message[] {
    const result: Message[] = messages.map((m, i) => ({ ...m, fidelityOrder: 2 * i }));
    const handles = new Map(messages.map((m, i) => [m.handle, i]));
    const claimed = new Set<number>();
    const inserts = new Map<number, Message[]>();
    for (const row of this.rows.filter(r => r.scope === scope)) {
      if (row.problem) throw new FidelityError(row.problem);
      let at = row.uuid ? handles.get(row.uuid) : undefined;
      if (at === undefined) {
        // Rebuilt rows receive fresh host UUIDs. Match each retained pinned row
        // once, preserving repeated equal instructions rather than deduplicating them.
        let occurrence = 0;
        at = messages.findIndex((m, i) => {
          if (m.role !== 'user' || !(row.prompt ? m.text.includes(row.text!) : m.text === row.text)) return false;
          const sharedGroup = row.promptGroup !== undefined && result[i]?.fidelityPins?.some(id =>
            this.rows.some(r => r.serial === id && r.promptGroup === row.promptGroup));
          return occurrence++ >= row.occurrence && (!claimed.has(i) || sharedGroup);
        });
        if (at < 0) at = undefined;
      }
      if (at !== undefined) {
        claimed.add(at);
        // A projected row may omit context that the observer rendered. Restore
        // the canonical whole text; do not pin the host's incomplete projection.
        result[at] = { ...result[at]!, text: row.prompt ? result[at]!.text : row.text!, pinned: true,
          fidelityPins: [...(result[at]!.fidelityPins ?? []), row.serial] };
        continue;
      }
      let before: number | undefined;
      let after: number | undefined;
      for (const t of this.timeline) {
        if (t.scope !== scope) continue;
        const index = handles.get(t.uuid);
        if (index === undefined) continue;
        if (t.sequence < row.sequence) after = index + 1;
        else if (t.sequence > row.sequence) { before = index; break; }
      }
      let position = (row.beforeUuid ? handles.get(row.beforeUuid) : undefined) ?? before ?? after;
      if (position === undefined && row.anchor.length) {
        // Search backwards through the actual pre-delivery snapshot. A tool
        // result can be the anchor even when a later projected row follows it.
        for (let i = row.anchor.length - 1; i >= 0; i--) {
          const index = messages.findIndex(m => key(m) === row.anchor[i]);
          if (index >= 0) { position = index + 1; break; }
        }
      }
      if (position === undefined) {
        if (!messages.length || !row.anchor.length && !this.timeline.some(t => t.scope === scope && t.sequence < row.sequence)) position = 0;
        else throw new FidelityError('delivery chronology unavailable: no surviving UUID or snapshot anchor');
      }
      const list = inserts.get(position) ?? [];
      list.push({ role: 'user', text: row.text!, toolUses: [], pinned: true,
        fidelityPins: [row.serial],
        fidelityOrder: 2 * position - 1 + (1 - 1 / (row.serial + 1)) });
      inserts.set(position, list);
    }
    return result.flatMap((m, i) => [...(inserts.get(i) ?? []), m]).concat(inserts.get(messages.length) ?? []);
  }

  restore(prepared: readonly Message[], scored: readonly Message[]): Message[] {
    // Include arrivals accepted during the request without scoring them or
    // re-running Jev. Every old row still carries its input order through edits.
    const pinned = prepared.filter(m => m.pinned);
    const orders = new Set(pinned.map(m => m.fidelityOrder));
    const active = new Set(this.rows.map(r => r.serial));
    return [...scored.filter(m => !orders.has(m.fidelityOrder) &&
      (!m.fidelityPins?.length || m.fidelityPins.some(id => active.has(id)))), ...pinned]
      .sort((a, b) => (a.fidelityOrder ?? 0) - (b.fidelityOrder ?? 0));
  }

  rebase(messages: readonly Message[], scope?: string): void {
    for (const row of this.rows.filter(r => r.scope === scope)) {
      const index = messages.findIndex(m => m.fidelityPins?.includes(row.serial));
      if (index < 0) continue;
      row.occurrence = messages.slice(0, index).filter(m => m.role === 'user' &&
        (row.prompt ? m.text.includes(row.text!) : m.text === row.text)).length;
      row.anchor = index > 0 ? [key(messages[index - 1]!)] : [];
      row.beforeUuid = undefined;
    }
    // UUID chronology is only needed for arrivals since this accepted cut.
    this.timeline = this.timeline.filter(t => t.scope !== scope);
  }

  recover(text: string, position: number, messages: readonly SessionMessage[], scope: string | undefined,
    claimed: Set<number>): void {
    const anchor = messages.slice(0, position).map(key);
    const existing = this.rows.find(r => r.scope === scope && r.text === text && !claimed.has(r.serial) &&
      r.anchor.at(-1) === anchor.at(-1));
    if (existing) { claimed.add(existing.serial); return; }
    const serial = ++this.serial;
    claimed.add(serial);
    this.rows.push({ serial, scope, text, anchor, beforeUuid: messages[position]?.handle,
      sequence: this.sequence + 0.5,
      occurrence: messages.slice(0, position).filter(m => m.role === 'user' && m.text === text).length });
  }

  coreApplied(scope: string | undefined, checkpoint: number): void {
    this.rows = this.rows.filter(r => r.scope !== scope || r.serial > checkpoint);
    const first = this.rows.filter(r => r.scope === scope).reduce((n, r) => Math.min(n, r.sequence), Infinity);
    this.timeline = this.timeline.filter(t => t.scope !== scope || t.sequence >= first);
  }
}
