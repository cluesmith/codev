export const DEFAULT_TOWER_PORT = 4100;

/**
 * Fallback `area` value emitted by the server when an issue or builder has
 * no `area/*` label (or, for builders, no associated issue). The single
 * source of truth so the parser default, the server-side initializer for
 * builders pending issue-cache enrichment, and any downstream UI filter or
 * matcher all agree on the literal.
 */
export const UNCATEGORIZED_AREA = 'Uncategorized';
