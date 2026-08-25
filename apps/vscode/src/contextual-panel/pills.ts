/**
 * Pure pill model for the contextual panel header — the mode order, labels, and the mapping from a
 * resolved `ModeDescriptor` to each pill's display state (active / navigable / disabled).
 *
 * React-free so it is unit-testable under the host tsconfig (no DOM); the React `Pill` / `HeaderStrip`
 * components in `webview/components.ts` consume it.
 */

import type { ModeDescriptor, ModeKind } from './types.js';

// Exhaustive by construction: a `Record<ModeKind, string>` forces every union member to appear, so a
// fifth `ModeKind` fails to compile until it is listed here. `MODE_ORDER` and `isModeKind` both derive
// from it, so neither can drift (matching resolver.ts's `Record`-keyed `MODE_KINDS`).
export const MODE_LABELS: Record<ModeKind, string> = {
  'document-review': 'Document Review',
  'code-review': 'Code Review',
  'builder-inspector': 'Builder Inspector',
  'attention': 'Attention',
};

export const MODE_ORDER: readonly ModeKind[] = Object.keys(MODE_LABELS) as ModeKind[];

export function isModeKind(value: unknown): value is ModeKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODE_LABELS, value);
}

/** A single mode pill's display state, derived from the resolved descriptor. */
export type PillState = 'active' | 'navigable' | 'disabled';

export interface ModePill {
  mode: ModeKind;
  label: string;
  state: PillState;
}

/**
 * Whether a pill accepts a navigation click. Every applicable pill does — including the ACTIVE one,
 * so that clicking the active builder-scoped mode navigates from a drilled-in detail back to its
 * summary. Only a disabled (inapplicable) pill is inert.
 */
export function pillIsInteractive(state: PillState): boolean {
  return state !== 'disabled';
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
