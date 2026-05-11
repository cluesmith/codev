/**
 * Agent naming utilities shared across packages.
 *
 * Lives in codev-core so the VS Code extension and the agent-farm server
 * can both resolve bare numeric IDs (e.g. '153') against canonical builder
 * IDs (e.g. 'builder-spir-153') with identical semantics.
 */

/**
 * Strip leading zeros from a numeric ID string.
 * Non-numeric IDs are returned unchanged.
 *
 *   '0109' → '109'
 *   '0001' → '1'
 *   '0'    → '0'
 *   'AbCd' → 'AbCd'
 */
export function stripLeadingZeros(id: string): string {
  if (/^\d+$/.test(id)) {
    return String(Number(id));
  }
  return id;
}

/**
 * Resolve an agent name against a list of builders using case-insensitive
 * matching with tail-match fallback.
 *
 * Resolution order:
 *   1. Exact match (case-insensitive): 'builder-spir-109' matches 'builder-spir-109'
 *   2. Tail match: bare ID matches the trailing segment of builder-{protocol}-{id}.
 *      E.g., '109' matches 'builder-spir-109' because the name ends with '-109'.
 *      Leading zeros are stripped before comparison: '0109' → '109'.
 *      Also handles partial names: 'bugfix-42' matches 'builder-bugfix-42'.
 *   3. Returns null if no match found or multiple ambiguous tail matches.
 *
 * Generic over the builder shape — anything with a string `id` works.
 */
export function resolveAgentName<T extends { id: string }>(
  target: string,
  builders: T[],
): { builder: T | null; ambiguous?: T[] } {
  const originalTarget = target.toLowerCase();
  const strippedTarget = stripLeadingZeros(target).toLowerCase();

  const exact = builders.find((b) => {
    const id = b.id.toLowerCase();
    return id === originalTarget || id === strippedTarget;
  });
  if (exact) { return { builder: exact }; }

  const tailMatches = builders.filter((b) => {
    const id = b.id.toLowerCase();
    return id.endsWith(`-${strippedTarget}`);
  });

  if (tailMatches.length === 1) { return { builder: tailMatches[0] }; }
  if (tailMatches.length > 1) { return { builder: null, ambiguous: tailMatches }; }

  return { builder: null };
}
