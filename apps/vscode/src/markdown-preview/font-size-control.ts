/**
 * Pure stepping logic for the in-preview font-size zoom control (#1070).
 *
 * The command handlers in `extension.ts` are thin VS Code shims: they read
 * `codev.markdownPreview.fontSize`, ask this module for the next value, and write it back.
 * Keeping the arithmetic here (no `vscode` import) makes it unit-testable in isolation and keeps
 * the handlers to config-read + config-write.
 *
 * The setting stores a pixel value where 0 is the sentinel "use the built-in default" (16px, the
 * github-markdown-css baseline #1053). The +/- control operates on the EFFECTIVE size: a step up
 * from the 0 sentinel means "16 -> 17", not "0 -> 1".
 */

/** The github-markdown-css baseline the `fontSize: 0` sentinel resolves to (#1053). */
export const BASELINE_FONT_SIZE = 16;
/** One click of the +/- control. */
export const FONT_SIZE_STEP = 1;
/** Reading bounds: below/above these, prose stops being a useful review surface. */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 40;

/** The direction a step moves the size. */
export type FontSizeDirection = 'increase' | 'decrease';

/**
 * The size the control acts on: the stored value if it is a positive override, otherwise the
 * baseline the `0` sentinel stands for. A non-finite or non-positive stored value (corrupt
 * settings, the `0` default) collapses to the baseline.
 */
export function effectiveFontSize(raw: number): number {
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return BASELINE_FONT_SIZE;
}

/** Clamp a size into the reading bounds. */
function clampFontSize(value: number): number {
  if (value < MIN_FONT_SIZE) {
    return MIN_FONT_SIZE;
  }
  if (value > MAX_FONT_SIZE) {
    return MAX_FONT_SIZE;
  }
  return value;
}

/**
 * The next font-size value for a +/- click. The effective size is clamped into the reading bounds
 * *before* stepping, so a stored value outside the range (e.g. a settings.json `fontSize: 48`, above
 * MAX) is pulled in the direction the button implies rather than snapping the wrong way — from 48,
 * "increase" holds at MAX and "decrease" steps to MAX-1, never growing on decrease or shrinking on
 * increase. Returns a concrete px value (never the `0` sentinel): the control always writes an
 * explicit override. `resetFontSize` is the only path back to the sentinel, handled by the command.
 */
export function steppedFontSize(raw: number, direction: FontSizeDirection): number {
  const current = clampFontSize(effectiveFontSize(raw));
  let next = current + FONT_SIZE_STEP;
  if (direction === 'decrease') {
    next = current - FONT_SIZE_STEP;
  }
  return clampFontSize(next);
}

/** Which config scope a write-back should target, so the button is never silently shadowed. */
export type ConfigScope = 'global' | 'workspace' | 'workspaceFolder';

/**
 * Pick the scope to write the new value to. A `config.update` at Global is silently shadowed if
 * the same setting is already defined at a narrower scope, so mirror where the value currently
 * lives: a workspace-folder override wins, then a workspace override, else the personal (Global)
 * scope that a reading preference belongs in by default. Takes the shape `inspect()` returns
 * (only the two narrower `*Value` fields matter) so it stays free of a `vscode` import.
 */
export function resolveWriteScope(inspected: {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
}): ConfigScope {
  if (inspected.workspaceFolderValue !== undefined) {
    return 'workspaceFolder';
  }
  if (inspected.workspaceValue !== undefined) {
    return 'workspace';
  }
  return 'global';
}
