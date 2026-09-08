/**
 * Pure, synchronous mode resolution for the contextual bottom panel.
 *
 * No VSCode / `node:` imports, no I/O, no navigation state — the panel is purely contextual, so the
 * resolver is just `SurfaceContext → ModeDescriptor` by a fixed precedence. Safe to unit-test without
 * a host; keeping it pure is what makes every branch testable and keeps the O(1) budget honest.
 */

import type { ModeDescriptor, SurfaceContext } from './types.js';

/** A non-empty string, else undefined — defends the resolver against malformed input. */
function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
 * Resolve the mode to render from the active surface.
 *
 * Precedence (locked): `builderTerminal → builderDiff → artifact → attention`. Attention is the
 * fallback when no artifact / builder diff / builder terminal is active — it is not selectable, just
 * what fills the panel with no context. Never throws: malformed or empty input degrades to Attention.
 */
export function resolveMode(surface: SurfaceContext | null | undefined): ModeDescriptor {
  const terminalBuilderId = readBuilderId(surface?.builderTerminal);
  if (terminalBuilderId !== undefined) {
    return { kind: 'builder-inspector', context: context({ builderId: terminalBuilderId }) };
  }

  const diffBuilderId = readBuilderId(surface?.builderDiff);
  if (diffBuilderId !== undefined) {
    return { kind: 'code-review', context: context({ builderId: diffBuilderId }) };
  }

  const resourcePath = cleanString(surface?.artifact?.resourcePath);
  if (resourcePath !== undefined) {
    return {
      kind: 'document-review',
      context: context({ resourcePath, builderId: cleanString(surface?.artifact?.builderId) }),
    };
  }

  return { kind: 'attention', context: {} };
}
