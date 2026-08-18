/**
 * The ONE place that spells out how to invoke `afx self-refresh` (Spec 1470).
 *
 * ## Why this module exists
 *
 * `--boundary` is not cosmetic: it binds the challenge to the boundary it was
 * issued at, so a challenge left behind by an aborted refresh cannot be used to
 * clear a builder at a LATER boundary, against a save describing work that has
 * since moved on. Any instruction that omits the flag silently disables that
 * guard for whoever follows it.
 *
 * That has already happened twice on this feature, in two different places, and
 * the second was fixed one commit after the first:
 *
 *   1. porch's refresh task text printed `afx self-refresh --begin` with no
 *      boundary — so the guard was inert in production from the moment it
 *      shipped.
 *   2. the CLI's own `--begin` output printed a bare `afx self-refresh` as the
 *      follow-up — so anyone following the command's own instruction dropped the
 *      guard.
 *
 * Two call sites, two identical omissions. A third was about to appear in the
 * builder-refresh skill. The generalisation is that **when a guard depends on a
 * flag, every place that tells a human or an agent how to invoke the command is
 * part of that guard** — so the emission belongs in one function rather than
 * being retyped wherever it is needed.
 *
 * ## What this does NOT solve, and how that is handled
 *
 * The skill is Markdown and cannot import anything. Rather than adding a third
 * hand-written copy, the skill **defers**: it tells the builder to run the exact
 * commands porch's refresh task supplied, instead of restating them.
 * `spec-1470-reentry-frame.test.ts` asserts the skill contains NO hand-written
 * invocation at all — stricter than checking each one carries the flag, and it
 * fails on the first line someone adds rather than on the first mistake.
 * Deferring beats duplicating-and-checking: a copy that is merely checked still
 * has to be kept correct in two places.
 *
 * Lives in `src/lib/` because both callers already depend on it and neither
 * depends on the other in this direction: the established import direction is
 * agent-farm → porch, so putting a shared helper in agent-farm and importing it
 * from porch would reverse it.
 */

/** Shell-quote a boundary id for safe inclusion in a printed command. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SelfRefreshInvocation {
  /** Step 1: mint the challenge and print what to save. */
  begin: string;
  /** Step 2: verify the save, then clear and re-orient. */
  execute: string;
}

/**
 * Build both halves of the handshake, carrying the boundary through.
 *
 * A missing `boundary` is a legitimate case — a builder refreshing outside a
 * porch task has no boundary to bind — and produces the flagless form. What must
 * never happen is a boundary being KNOWN and dropped from the instruction, which
 * is exactly what a hand-typed command in a second file does the moment someone
 * edits one and not the other.
 */
export function selfRefreshInvocation(boundary?: string): SelfRefreshInvocation {
  const suffix = boundary ? ` --boundary ${quote(boundary)}` : '';
  return {
    begin: `afx self-refresh --begin${suffix}`,
    execute: `afx self-refresh${suffix}`,
  };
}
