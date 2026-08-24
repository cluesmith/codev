/**
 * Contract types for the contextual bottom panel's mode resolver.
 *
 * EXTENSION-LOCAL by design: these describe the in-memory decision + host<->webview flow
 * only. The single boundary they cross is this extension's own `postMessage`, which is not a
 * published contract, so they deliberately do NOT live in `@cluesmith/codev-types` (wire
 * contracts only — a permanent public surface). If #1549 later extracts the panel primitives,
 * presentation-level types may move into artifact-canvas; they still never enter codev-types
 * unless an out-of-extension consumer appears.
 */

export type ModeKind =
  | 'document-review'
  | 'code-review'
  | 'builder-inspector'
  | 'attention';

export type ModeLevel = 'summary' | 'detail';

/**
 * Independent predicate signals derived from the active surface (by the Phase 3 adapter).
 *
 * They are intentionally NOT pre-collapsed into a single `surface` discriminator: the
 * resolver applies the locked precedence itself, which keeps genuine overlaps testable
 * (e.g. a builder's artifact opened *inside* a diff satisfies both `artifact` and
 * `builderDiff`). All three absent means the "other"/"none" surface.
 */
export interface SurfaceContext {
  /**
   * Active surface is a `codev/{specs,plans,reviews}` artifact. `builderId` is set when the
   * file is housed under a `.builders/<id>/` worktree (the common review case), which puts
   * that builder in scope for the builder-scoped modes.
   */
  artifact?: { resourcePath: string; builderId?: string };
  /** Active surface is a builder's unified diff (builder id from the diff-inject registry). */
  builderDiff?: { builderId: string };
  /**
   * Active surface is a builder terminal — present only while the terminal is the
   * last-focused surface (the Phase 3 adapter gates this to fix the terminal-exit path).
   */
  builderTerminal?: { builderId: string };
}

/**
 * A transient pill-navigation / summary drill-in selection. NEVER persisted — the host holds
 * it in memory and clears it on any real active-surface transition.
 */
export interface ManualSelection {
  mode: ModeKind;
  /** Present when the user drilled into a specific builder from a summary list. */
  builderId?: string;
}

export interface ModeDescriptor {
  kind: ModeKind;
  level: ModeLevel;
  context: { builderId?: string; resourcePath?: string };
  /** Which mode pills are navigable (true) vs greyed/disabled (false) for this surface. */
  applicability: Record<ModeKind, boolean>;
}
