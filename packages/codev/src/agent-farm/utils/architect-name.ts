/**
 * Architect-name utilities (Spec 755).
 *
 * - validateArchitectName: enforces the [a-z][a-z0-9-]* rule with a 64-char cap.
 * - autoNumberArchitectName: returns the next available `architect-<N>` name
 *   (smallest unused integer ≥ 2) given the set of already-registered names.
 *
 * Both functions are pure — they don't read process state or Tower; the caller
 * is responsible for sourcing the existing-names set. Keeping them pure makes
 * them trivially unit-testable.
 */

export const ARCHITECT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
export const MAX_ARCHITECT_NAME_LENGTH = 64;

/** Reserved default for the singleton case. */
export const DEFAULT_ARCHITECT_NAME = 'main';

/**
 * Validate an architect name. Returns `null` if valid, or a human-readable
 * error message otherwise. Callers should treat a non-null return as "reject
 * with this message" — the text is intentionally operator-facing.
 *
 * Spec 786: the name `main` is reserved for the workspace's default architect
 * and is rejected here. Pre-#786, `main` was rejected only by collision check
 * at the add-architect call site (which depended on a race-free in-memory map);
 * rejecting in the pure validator is more robust.
 */
export function validateArchitectName(name: string): string | null {
  if (!name) {
    return 'Architect name cannot be empty.';
  }
  if (name === DEFAULT_ARCHITECT_NAME) {
    return `Architect name '${DEFAULT_ARCHITECT_NAME}' is reserved for the workspace's default architect.`;
  }
  if (name.length > MAX_ARCHITECT_NAME_LENGTH) {
    return `Architect name must be at most ${MAX_ARCHITECT_NAME_LENGTH} characters (got ${name.length}).`;
  }
  if (!ARCHITECT_NAME_PATTERN.test(name)) {
    return `Architect name '${name}' is invalid. Names must match [a-z][a-z0-9-]* (lowercase letter, then lowercase letters / digits / dashes).`;
  }
  return null;
}

/**
 * Compute the next auto-numbered architect name, given the set of names
 * already in use. Uses "smallest unused integer ≥ 2" semantics:
 *
 *   - {} → 'architect-2'
 *   - {'main'} → 'architect-2'
 *   - {'main', 'architect-2'} → 'architect-3'
 *   - {'main', 'architect-3'} → 'architect-2' (fills the gap)
 *   - {'main', 'architect-2', 'architect-3'} → 'architect-4'
 *   - {'main', 'sibling'} → 'architect-2' (custom names don't shift numbering)
 *
 * Custom names (anything not matching `architect-<N>` exactly) are ignored
 * by the numbering loop — they're not part of the auto-numbered sequence.
 */
export function autoNumberArchitectName(existingNames: Iterable<string>): string {
  const usedNumbers = new Set<number>();
  for (const name of existingNames) {
    const match = /^architect-(\d+)$/.exec(name);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n >= 2) {
        usedNumbers.add(n);
      }
    }
  }
  let n = 2;
  while (usedNumbers.has(n)) n++;
  return `architect-${n}`;
}

/**
 * Resolve the *current* terminal session's architect name (Spec 1057).
 *
 * Tower injects `CODEV_ARCHITECT_NAME` into every architect terminal it starts
 * (see `commands/spawn.ts` and `servers/tower-instances.ts`). When present, it
 * names the architect whose terminal this command is running in — exactly what
 * `afx status --mine` needs to scope builders to "my own". When absent (a plain
 * shell, or a pre-#786 single-architect workspace) we fall back to the reserved
 * default `main`.
 *
 * Pure apart from the default `env` binding; pass an explicit `env` in tests.
 */
export function currentArchitectName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.CODEV_ARCHITECT_NAME?.trim();
  return value || DEFAULT_ARCHITECT_NAME;
}
