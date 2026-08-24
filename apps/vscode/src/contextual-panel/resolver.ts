/**
 * Pure, synchronous mode resolution for the contextual bottom panel.
 *
 * No VSCode / `node:` imports, no I/O — safe to unit-test without a host. This is the
 * load-bearing decision surface; keeping it pure is what makes every branch testable and
 * keeps the O(1) budget honest (all data access lives in the host/render paths).
 */

import type {
  ManualSelection,
  ModeDescriptor,
  ModeKind,
  SurfaceContext,
} from './types.js';

// Exhaustive by construction: a `Record<ModeKind, true>` forces every union member to appear,
// so adding a fifth `ModeKind` fails to compile until it is listed here (no silent drift).
const MODE_KINDS: Record<ModeKind, true> = {
  'document-review': true,
  'code-review': true,
  'builder-inspector': true,
  'attention': true,
};

function isModeKind(value: unknown): value is ModeKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODE_KINDS, value);
}

/** A non-empty string, else undefined — defends the resolver against malformed input. */
function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface ArtifactSignal {
  resourcePath: string;
  builderId?: string;
}

function readArtifact(surface: SurfaceContext | null | undefined): ArtifactSignal | undefined {
  const resourcePath = cleanString(surface?.artifact?.resourcePath);
  if (resourcePath === undefined) {
    return undefined;
  }
  return { resourcePath, builderId: cleanString(surface?.artifact?.builderId) };
}

function readBuilderId(signal: { builderId?: unknown } | null | undefined): string | undefined {
  return cleanString(signal?.builderId);
}

/** Drop undefined fields so `context` compares cleanly in tests and over the wire. */
function context(fields: { builderId?: string; resourcePath?: string }): ModeDescriptor['context'] {
  const out: ModeDescriptor['context'] = {};
  if (fields.builderId !== undefined) {
    out.builderId = fields.builderId;
  }
  if (fields.resourcePath !== undefined) {
    out.resourcePath = fields.resourcePath;
  }
  return out;
}

/**
 * Resolve the mode to render.
 *
 * Precedence (locked by the spec): `builderTerminal -> builderDiff -> artifact -> attention`.
 * A valid `ManualSelection` overrides contextual resolution, but only to a mode that is
 * actually applicable for the current surface. Never throws: malformed or empty input
 * degrades to the Attention summary.
 */
export function resolveMode(
  surface: SurfaceContext | null | undefined,
  selection: ManualSelection | null | undefined,
): ModeDescriptor {
  const artifact = readArtifact(surface);
  const diffBuilderId = readBuilderId(surface?.builderDiff);
  const terminalBuilderId = readBuilderId(surface?.builderTerminal);

  // Applicability describes the SURFACE (it drives which pills are greyed), independent of
  // the current manual selection. Code Review / Builder Inspector / Attention always have a
  // view (a cross-builder summary, or the roll-up), so they are always navigable. Document
  // Review is file-scoped and needs an artifact. A worktree artifact additionally puts a
  // builder in scope for the builder-scoped modes — they stay applicable (already true) and
  // the builder rides along in `context.builderId`.
  const applicability: Record<ModeKind, boolean> = {
    'document-review': artifact !== undefined,
    'code-review': true,
    'builder-inspector': true,
    'attention': true,
  };

  if (selection && isModeKind(selection.mode) && applicability[selection.mode]) {
    return resolveSelection(selection, artifact, applicability);
  }

  if (terminalBuilderId !== undefined) {
    return {
      kind: 'builder-inspector',
      level: 'detail',
      context: context({ builderId: terminalBuilderId }),
      applicability,
    };
  }
  if (diffBuilderId !== undefined) {
    return {
      kind: 'code-review',
      level: 'detail',
      context: context({ builderId: diffBuilderId }),
      applicability,
    };
  }
  if (artifact !== undefined) {
    return {
      kind: 'document-review',
      // Document Review has no summary level — it is inherently file-scoped.
      level: 'detail',
      context: context({ resourcePath: artifact.resourcePath, builderId: artifact.builderId }),
      applicability,
    };
  }
  return { kind: 'attention', level: 'summary', context: {}, applicability };
}

function resolveSelection(
  selection: ManualSelection,
  artifact: ArtifactSignal | undefined,
  applicability: Record<ModeKind, boolean>,
): ModeDescriptor {
  const drilledBuilderId = cleanString(selection.builderId);

  if (selection.mode === 'attention') {
    return { kind: 'attention', level: 'summary', context: {}, applicability };
  }
  if (selection.mode === 'document-review') {
    // File-scoped: always detail, keyed by the artifact's path (never a summary).
    return {
      kind: 'document-review',
      level: 'detail',
      context: context({ resourcePath: artifact?.resourcePath, builderId: artifact?.builderId }),
      applicability,
    };
  }
  // code-review / builder-inspector: a builder in the selection yields that builder's detail;
  // otherwise the cross-builder summary. Whether a navigation scopes to a worktree artifact's builder
  // (architect note A2) is a host navigation policy decided by the provider, so it sets the builderId
  // — the pure resolver has no artifact fallback here (that also keeps a zoom-out to summary reachable).
  if (drilledBuilderId !== undefined) {
    return { kind: selection.mode, level: 'detail', context: context({ builderId: drilledBuilderId }), applicability };
  }
  return { kind: selection.mode, level: 'summary', context: {}, applicability };
}
