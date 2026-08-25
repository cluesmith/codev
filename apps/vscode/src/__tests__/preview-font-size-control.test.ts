/**
 * Pure stepping logic for the in-preview font-size zoom control (#1070). No `vscode` import here:
 * the arithmetic lives in `font-size-control.ts` precisely so it can be tested in isolation, with
 * the command handlers left as thin config-read/config-write shims.
 */
import { describe, it, expect } from 'vitest';
import {
  BASELINE_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  effectiveFontSize,
  steppedFontSize,
  resolveWriteScope,
} from '../markdown-preview/font-size-control.js';

describe('effectiveFontSize', () => {
  it('resolves the 0 sentinel to the github baseline', () => {
    expect(effectiveFontSize(0)).toBe(BASELINE_FONT_SIZE);
  });
  it('passes a positive override through unchanged', () => {
    expect(effectiveFontSize(22)).toBe(22);
  });
  it('collapses negative / non-finite stored garbage to the baseline', () => {
    expect(effectiveFontSize(-5)).toBe(BASELINE_FONT_SIZE);
    expect(effectiveFontSize(Number.NaN)).toBe(BASELINE_FONT_SIZE);
  });
});

describe('steppedFontSize', () => {
  it('steps up from the baseline when the setting is the 0 sentinel', () => {
    expect(steppedFontSize(0, 'increase')).toBe(BASELINE_FONT_SIZE + 1);
  });
  it('steps down from the baseline when the setting is the 0 sentinel', () => {
    expect(steppedFontSize(0, 'decrease')).toBe(BASELINE_FONT_SIZE - 1);
  });
  it('steps relative to an existing override', () => {
    expect(steppedFontSize(20, 'increase')).toBe(21);
    expect(steppedFontSize(20, 'decrease')).toBe(19);
  });
  it('clamps at the maximum', () => {
    expect(steppedFontSize(MAX_FONT_SIZE, 'increase')).toBe(MAX_FONT_SIZE);
  });
  it('clamps at the minimum', () => {
    expect(steppedFontSize(MIN_FONT_SIZE, 'decrease')).toBe(MIN_FONT_SIZE);
  });
  it('pulls an out-of-range stored value the way the button implies (clamp before step)', () => {
    // A settings.json value above MAX (e.g. 48): increase must not shrink, decrease must not grow.
    expect(steppedFontSize(48, 'increase')).toBe(MAX_FONT_SIZE);
    expect(steppedFontSize(48, 'decrease')).toBe(MAX_FONT_SIZE - 1);
    // And a positive value below MIN (e.g. 4): decrease holds at MIN, increase steps up.
    expect(steppedFontSize(4, 'decrease')).toBe(MIN_FONT_SIZE);
    expect(steppedFontSize(4, 'increase')).toBe(MIN_FONT_SIZE + 1);
  });
  it('never returns the 0 sentinel (the control always writes an explicit px value)', () => {
    // Decreasing from the baseline repeatedly lands on MIN, not 0.
    let v = 0;
    for (let i = 0; i < 40; i++) {
      v = steppedFontSize(v, 'decrease');
    }
    expect(v).toBe(MIN_FONT_SIZE);
  });
});

describe('resolveWriteScope', () => {
  it('defaults to global when the setting has no narrower override', () => {
    expect(resolveWriteScope({})).toBe('global');
    expect(resolveWriteScope({ workspaceValue: undefined, workspaceFolderValue: undefined })).toBe('global');
  });
  it('targets workspace when a workspace override exists', () => {
    expect(resolveWriteScope({ workspaceValue: 18 })).toBe('workspace');
  });
  it('prefers the workspace-folder scope over the workspace scope', () => {
    expect(resolveWriteScope({ workspaceValue: 18, workspaceFolderValue: 20 })).toBe('workspaceFolder');
  });
  it('treats a 0 override as present (not absent)', () => {
    // 0 is a real, user-set value at that scope — writing elsewhere would leave it shadowing.
    expect(resolveWriteScope({ workspaceValue: 0 })).toBe('workspace');
  });
});
