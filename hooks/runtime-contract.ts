/**
 * Supplemental read-only observer contract verified in Claude Code 2.1.299.
 * The vendored generated declarations (2.1.274) predate session.append; do not
 * edit them by hand. Append identity is pinned; this observer forwards unchanged.
 */
export type DeliveryAppend = {
  door: string;
  message: { type: string; name?: string; role?: string;
    content?: readonly ({ kind: string; text?: string; [key: string]: unknown })[] };
  uuid: string;
  agentId?: string;
  origin?: unknown;
};

export type DeliveryOn = (
  name: 'session.append',
  handler: ($: { session: { id: () => Promise<string>; messages: () => Promise<import('claude-code').SessionMessage[]> } },
    event: DeliveryAppend, next: (event: DeliveryAppend) => Promise<DeliveryAppend | { deny: string }>) => Promise<DeliveryAppend | { deny: string }>,
) => unknown;
