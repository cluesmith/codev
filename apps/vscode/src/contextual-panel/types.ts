/**
 * Contract types for the contextual bottom panel's mode resolver.
 *
 * EXTENSION-LOCAL by design: these describe the in-memory decision + host<->webview flow only. The
 * single boundary they cross is this extension's own `postMessage`, which is not a published contract,
 * so they deliberately do NOT live in `@cluesmith/codev-types` (wire contracts only — a permanent
 * public surface).
 *
 * The panel is purely contextual: it resolves one mode from the active surface, with no manual
 * selection, no summary/detail levels, and no pill navigation.
 */

export type ModeKind =
  | 'document-review'
  | 'code-review'
  | 'builder-inspector'
  | 'attention';

/**
 * Independent predicate signals derived from the active surface (by the host adapter).
 *
 * Not pre-collapsed into a single discriminator: the resolver applies the locked precedence itself,
 * which keeps genuine overlaps representable (e.g. a builder's artifact opened *inside* a diff
 * satisfies both `artifact` and `builderDiff`). All three absent means the "other"/"none" surface,
 * which resolves to the Attention fallback.
 */
export interface SurfaceContext {
  /** Active surface is a `codev/{specs,plans,reviews}` artifact. `builderId` is set when the file is
   *  housed under a `.builders/<id>/` worktree. */
  artifact?: { resourcePath: string; builderId?: string };
  /** Active surface is a builder's unified diff (builder id from the diff-inject registry). */
  builderDiff?: { builderId: string };
  /** Active surface is a builder terminal — present only while the terminal is the last-focused
   *  surface (the host adapter gates this to fix the terminal-exit path). */
  builderTerminal?: { builderId: string };
}

export interface ModeDescriptor {
  kind: ModeKind;
  /** The builder / file the contextual view is about (derived from the active surface). */
  context: { builderId?: string; resourcePath?: string };
}
