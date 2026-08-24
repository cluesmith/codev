/**
 * Unit tests for the pure pill model (descriptor → active / navigable / disabled).
 */

import { describe, it, expect } from 'vitest';
import { pillsFromDescriptor, pillIsInteractive, MODE_ORDER } from '../contextual-panel/pills.js';
import type { ModeDescriptor, ModeKind } from '../contextual-panel/types.js';

function descriptor(kind: ModeKind, applicability: Record<ModeKind, boolean>): ModeDescriptor {
  return { kind, level: 'detail', context: {}, applicability };
}

describe('pillsFromDescriptor', () => {
  it('marks the resolved kind active, applicable modes navigable, inapplicable modes disabled', () => {
    const d = descriptor('code-review', {
      'document-review': false,
      'code-review': true,
      'builder-inspector': true,
      'attention': true,
    });
    const byMode = Object.fromEntries(pillsFromDescriptor(d).map((p) => [p.mode, p.state]));
    expect(byMode['code-review']).toBe('active');
    expect(byMode['document-review']).toBe('disabled');
    expect(byMode['builder-inspector']).toBe('navigable');
    expect(byMode['attention']).toBe('navigable');
  });

  it('returns the four modes in canonical order, each with a non-empty label', () => {
    const d = descriptor('attention', {
      'document-review': true,
      'code-review': true,
      'builder-inspector': true,
      'attention': true,
    });
    const pills = pillsFromDescriptor(d);
    expect(pills.map((p) => p.mode)).toEqual([...MODE_ORDER]);
    expect(pills.every((p) => p.label.length > 0)).toBe(true);
  });

  it('shows the active mode as active even if its applicability flag were false', () => {
    const d = descriptor('document-review', {
      'document-review': false,
      'code-review': true,
      'builder-inspector': true,
      'attention': true,
    });
    expect(pillsFromDescriptor(d).find((p) => p.mode === 'document-review')?.state).toBe('active');
  });
});

describe('pillIsInteractive', () => {
  it('the active and navigable pills are clickable; only disabled is inert', () => {
    // The active pill must stay clickable so a drilled-in detail can navigate back to its summary.
    expect(pillIsInteractive('active')).toBe(true);
    expect(pillIsInteractive('navigable')).toBe(true);
    expect(pillIsInteractive('disabled')).toBe(false);
  });
});
