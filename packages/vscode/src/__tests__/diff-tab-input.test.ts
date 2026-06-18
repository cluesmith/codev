/**
 * #1066 — the Builders active-file reveal must fire only when a builder file is
 * shown in a DIFF tab, not when the same worktree file is opened as a normal
 * editor tab. The registry is keyed by the worktree file path, which a plain
 * open shares, so the gate is what prevents a standalone open from hijacking the
 * sidebar selection (consultation finding). This pins the predicate.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
  class TabInputText {}
  class TabInputTextDiff {}
  class TabInputCustom {}
  return { TabInputText, TabInputTextDiff, TabInputCustom };
});

const vscode = await import('vscode');
const { isStandaloneTextTab } = await import('../diff-tab-input.js');

// The mock classes accept no args; alias through `unknown` so the test isn't
// bound to the real (Uri-typed) constructor signatures.
const { TabInputText, TabInputTextDiff, TabInputCustom } =
  vscode as unknown as Record<string, new () => object>;

describe('isStandaloneTextTab (#1066)', () => {
  it('is true for a plain text tab — the standalone-open hijack case we skip', () => {
    expect(isStandaloneTextTab(new TabInputText())).toBe(true);
  });

  it('is false for a 2-way diff tab (per-file builder diff via vscode.diff)', () => {
    expect(isStandaloneTextTab(new TabInputTextDiff())).toBe(false);
  });

  it('is false for a non-text tab kind (e.g. a custom editor) and the multi-file diff, which is never TabInputText', () => {
    expect(isStandaloneTextTab(new TabInputCustom())).toBe(false);
  });

  it('is false for undefined (no active tab)', () => {
    expect(isStandaloneTextTab(undefined)).toBe(false);
  });
});
