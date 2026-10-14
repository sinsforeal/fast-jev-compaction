import type { SessionMessage } from 'claude-code';
import type { Message } from '../src/types.js';

// A separate metadata row preserves pin provenance across plugin reload/resume.
// Original instruction rows stay byte-for-byte unchanged. No shared store.
const PREFIX = '[fast-jev-compaction pinned delivery provenance v1] ';
type Pin = { key: string; occurrence: number };
function fingerprint(m: SessionMessage | Message): string {
  const value = JSON.stringify({ role: m.role, text: m.text,
    uses: m.toolUses.map(t => [t.tool_use_id, t.tool, t.input]),
    results: (m.toolResults ?? []).map(t => [t.tool_use_id, t.text, !!t.isError]) });
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n);
  return `${value.length}:${hash.toString(16)}`;
}
function parse(text: string): Pin[] | undefined {
  if (!text.startsWith(PREFIX)) return undefined;
  try {
    const pins: unknown = JSON.parse(text.slice(PREFIX.length));
    if (!Array.isArray(pins) || !pins.every(p => p && typeof p.key === 'string' &&
      /^\d+:[a-f0-9]+$/.test(p.key) && Number.isSafeInteger(p.occurrence) && p.occurrence >= 0)) return undefined;
    return pins as Pin[];
  } catch { return undefined; }
}
export function isPinProvenance(text: string): boolean { return parse(text) !== undefined; }
export function pinProvenanceTexts(input: readonly SessionMessage[]): string[] {
  return input.filter(m => m.role === 'user' && isPinProvenance(m.text)).map(m => m.text);
}

export function readPinProvenance(input: readonly SessionMessage[]): (SessionMessage & Message)[] {
  const entries = input.flatMap(m => m.role === 'user' ? (parse(m.text) ?? []) : []);
  const messages = input.filter(m => m.role !== 'user' || !isPinProvenance(m.text));
  const occurrences = new Map<string, number>();
  return messages.map(m => {
    const key = fingerprint(m);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return entries.some(p => p.key === key && p.occurrence === occurrence) ? { ...m, pinned: true } : { ...m };
  });
}

export function persistPinProvenance(messages: SessionMessage[], pinned: ReadonlySet<number>): SessionMessage[] {
  const occurrences = new Map<string, number>();
  const entries: Pin[] = [];
  messages.forEach((m, i) => {
    const key = fingerprint(m);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    if (pinned.has(i)) entries.push({ key, occurrence });
  });
  return entries.length ? [...messages, { role: 'user', text: PREFIX + JSON.stringify(entries), toolUses: [] }] : messages;
}
