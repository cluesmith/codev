/**
 * Pure pill model for the contextual panel header — the mode order, labels, and the mapping from a
 * resolved `ModeDescriptor` to each pill's display state (active / navigable / disabled).
 *
 * React-free so it is unit-testable under the host tsconfig (no DOM); the React `Pill` / `HeaderStrip`
 * components in `webview/components.ts` consume it.
 */

import type { ModeDescriptor, ModeKind } from './types.js';

export const MODE_ORDER: readonly ModeKind[] = [
  'document-review',
  'code-review',
  'builder-inspector',
  'attention',
];

export function isModeKind(value: unknown): value is ModeKind {
  return typeof value === 'string' && (MODE_ORDER as readonly string[]).includes(value);
}

export const MODE_LABELS: Record<ModeKind, string> = {
  'document-review': 'Document Review',
  'code-review': 'Code Review',
  'builder-inspector': 'Builder Inspector',
  'attention': 'Attention',
};

/** A single mode pill's display state, derived from the resolved descriptor. */
export type PillState = 'active' | 'navigable' | 'disabled';

export interface ModePill {
  mode: ModeKind;
  label: string;
  state: PillState;
}

/** Map a resolved descriptor to the four pills' display states. */
export function pillsFromDescriptor(descriptor: ModeDescriptor): ModePill[] {
  return MODE_ORDER.map((mode) => {
    let state: PillState = 'navigable';
    if (!descriptor.applicability[mode]) {
      state = 'disabled';
    }
    if (mode === descriptor.kind) {
      state = 'active';
    }
    return { mode, label: MODE_LABELS[mode], state };
  });
}
