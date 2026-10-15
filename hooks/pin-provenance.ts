import type { SessionMessage } from 'claude-code';
import type { Message } from '../src/types.js';

// Legacy inline rows are read for migration and used only if durable storage fails.
const PREFIX = '[fast-jev-compaction pinned delivery provenance v1] ';
export type Pin = { key: string; occurrence: number; notificationText?: Message['notificationText'] };
export const pinStoreKey = (sessionId: string, agentId?: string): string =>
  `delivery-pins:v2:${JSON.stringify([sessionId, agentId ?? null])}`;
export type PinRecord = { version: 2; pins: Pin[] };

function validPins(value: unknown): value is Pin[] {
  return Array.isArray(value) && value.every(p => p && typeof p.key === 'string' &&
    /^\d+:[a-f0-9]+$/.test(p.key) && Number.isSafeInteger(p.occurrence) && p.occurrence >= 0 &&
    (p.notificationText === undefined || p.notificationText === 'verbatim' || p.notificationText === 'generated'));
}

/** Retain prior keys too: the host may reject a prepared replacement after our return.
 * Only fingerprints are stored, never prompt text. Session/child scopes never mix.
 */
export function mergePins(...groups: readonly Pin[][]): Pin[] {
  const merged = new Map<string, Pin>();
  for (const pin of groups.flat()) {
    const key = `${pin.key}/${pin.occurrence}`;
    const previous = merged.get(key);
    merged.set(key, previous?.notificationText === 'verbatim' ? previous : pin);
  }
  return [...merged.values()];
}

export function readPinRecord(value: unknown): Pin[] {
  if (value === undefined) return [];
  const record = value as Partial<PinRecord> | null;
  if (!record || record.version !== 2 || !validPins(record.pins)) throw new Error('Invalid pin record');
  return record.pins;
}
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
    if (!validPins(pins)) return undefined;
    return pins as Pin[];
  } catch { return undefined; }
}
export function isPinProvenance(text: string): boolean { return parse(text) !== undefined; }
export function pinProvenanceTexts(input: readonly SessionMessage[]): string[] {
  return input.filter(m => m.role === 'user' && isPinProvenance(m.text)).map(m => m.text);
}

export function readPinProvenance(input: readonly SessionMessage[], stored: readonly Pin[] = []): (SessionMessage & Message)[] {
  const entries = [...stored, ...input.flatMap(m => m.role === 'user' ? (parse(m.text) ?? []) : [])];
  const keys = new Map(mergePins(entries).map(p => [`${p.key}/${p.occurrence}`, p]));
  const messages = input.filter(m => m.role !== 'user' || !isPinProvenance(m.text));
  const occurrences = new Map<string, number>();
  return messages.map(m => {
    const key = fingerprint(m);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const pin = keys.get(`${key}/${occurrence}`);
    return pin ? { ...m, pinned: true, notificationText: pin.notificationText } : { ...m };
  });
}

export function collectPins(messages: readonly SessionMessage[], pinned: ReadonlySet<number>,
  policies?: ReadonlyMap<number, Message['notificationText']>): Pin[] {
  const occurrences = new Map<string, number>();
  const entries: Pin[] = [];
  messages.forEach((m, i) => {
    const key = fingerprint(m);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    if (pinned.has(i)) {
      const notificationText = policies?.get(i) ?? (m as Message).notificationText;
      entries.push({ key, occurrence, ...(notificationText ? { notificationText } : {}) });
    }
  });
  return entries;
}

export function appendPinProvenance(messages: SessionMessage[], entries: readonly Pin[]): SessionMessage[] {
  return entries.length ? [...messages, { role: 'user', text: PREFIX + JSON.stringify(entries), toolUses: [] }] : messages;
}

export function persistPinProvenance(messages: SessionMessage[], pinned: ReadonlySet<number>): SessionMessage[] {
  return appendPinProvenance(messages, collectPins(messages, pinned));
}
