/**
 * Supplemental read-only observer contract verified in Claude Code 2.1.299.
 * The vendored generated declarations (2.1.274) predate session.append; do not
 * edit them by hand. Append identity is pinned; this observer forwards unchanged.
 */
export type DeliveryAppend = {
  door: 'delivery';
  message: { type: string; name?: string };
  uuid: string;
  agentId?: string;
};

export type DeliveryOn = (
  name: 'session.append',
  matcher: { door: 'delivery' },
  handler: ($: unknown, event: DeliveryAppend, next: (event: DeliveryAppend) => Promise<unknown>) => Promise<unknown>,
) => unknown;
