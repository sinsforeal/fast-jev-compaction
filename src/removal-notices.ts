import type { Message } from './types.js';

/** One warning for the retained history; per-call counts live in decisions/logs. */
export const REMOVAL_NOTICE = '[fast-jev-compaction removed tool calls and results; earlier answers may rely on missing evidence]';

const LEGACY_NOTICE = /^\[fast-jev-compaction removed [1-9]\d* tool call\(s\) and their results; earlier answers may rely on that evidence\]$/;

/**
 * Collapse our standalone assistant bookkeeping without touching user deliveries,
 * pinned messages, tool payloads, quoted examples, or fenced code. No inference
 * is made from similar prose: only the exact generated notice formats qualify.
 */
export function normalizeRemovalNotices(messages: readonly Message[]): Message[] {
  let retained = false;
  const normalized: Message[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || message.pinned) {
      normalized.push(message);
      continue;
    }
    let fence: { character: string; length: number } | undefined;
    const lines = message.text.split(/(?<=\n)/);
    const kept: string[] = [];
    for (const line of lines) {
      const text = line.replace(/\r?\n$/, '');
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      if (fence) {
        if (delimiter && delimiter[1]![0] === fence.character &&
            delimiter[1]!.length >= fence.length && delimiter[2]!.trim() === '') fence = undefined;
        kept.push(line);
        continue;
      }
      if (delimiter && (delimiter[1]![0] !== '`' || !delimiter[2]!.includes('`'))) {
        fence = { character: delimiter[1]![0]!, length: delimiter[1]!.length };
        kept.push(line);
        continue;
      }
      if (text !== REMOVAL_NOTICE && !LEGACY_NOTICE.test(text)) {
        kept.push(line);
        continue;
      }
      if (!retained) {
        kept.push(REMOVAL_NOTICE + line.slice(text.length));
        retained = true;
      }
    }
    const text = kept.join('');
    if (text === message.text) normalized.push(message);
    else if (text.trim() || message.toolUses.length || message.toolResults?.length) {
      normalized.push({ ...message, text });
    }
  }
  return normalized;
}
