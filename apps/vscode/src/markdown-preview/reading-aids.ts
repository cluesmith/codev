/**
 * Reading aids for the Codev Markdown Preview: the hover highlight style and the prose cursor
 * (#1802), and the band line and annotation entry (#1850), stored as
 * `codev.markdownPreview.hoverHighlight` / `readingCursor` / `highlightLine` / `annotationEntry`
 * and chosen from the "Reading Aids…" picker in the preview's title-bar `…` menu.
 *
 * Pure (no `vscode` import), like `font-size-control.ts`: the command in `extension.ts` shows
 * the picker built here and writes the pair an item names. The vocabularies are typed against the
 * canvas package's own types, and the compile-time checks below fail if the two ever drift.
 */

import type {
  AnnotationEntry,
  HighlightLine,
  HoverHighlightStyle,
  ReadingCursor,
} from '@cluesmith/codev-artifact-canvas';

export const HOVER_HIGHLIGHT_SETTING = 'hoverHighlight';
export const READING_CURSOR_SETTING = 'readingCursor';
export const HIGHLIGHT_LINE_SETTING = 'highlightLine';
export const ANNOTATION_ENTRY_SETTING = 'annotationEntry';

export const DEFAULT_HOVER_HIGHLIGHT: HoverHighlightStyle = 'lineParagraph';
export const DEFAULT_READING_CURSOR: ReadingCursor = 'arrow';
export const DEFAULT_HIGHLIGHT_LINE: HighlightLine = 'underPointer';
export const DEFAULT_ANNOTATION_ENTRY: AnnotationEntry = 'gutterButton';

/** Picker order is display order: None first (owner ruling). */
export const HIGHLIGHT_CHOICES = [
  { value: 'none', label: 'None' },
  { value: 'word', label: 'Word' },
  { value: 'wordLine', label: 'Word and line' },
  { value: 'wordLineParagraph', label: 'Word, line and paragraph' },
  { value: 'line', label: 'Line' },
  { value: 'lineParagraph', label: 'Line and paragraph' },
] as const satisfies readonly { value: HoverHighlightStyle; label: string }[];

export const CURSOR_CHOICES = [
  { value: 'arrow', label: 'Arrow' },
  { value: 'iBeam', label: 'I-beam' },
  { value: 'hand', label: 'Hand' },
] as const satisfies readonly { value: ReadingCursor; label: string }[];

export const HIGHLIGHT_LINE_CHOICES = [
  { value: 'underPointer', label: 'Line under the pointer' },
  { value: 'abovePointer', label: 'Line above the pointer' },
] as const satisfies readonly { value: HighlightLine; label: string }[];

export const ANNOTATION_ENTRY_CHOICES = [
  { value: 'gutterButton', label: 'Gutter + button' },
  { value: 'clickParagraph', label: 'Click the paragraph' },
] as const satisfies readonly { value: AnnotationEntry; label: string }[];

// Exhaustiveness: a canvas value missing from a list above is a compile error here.
type MissingHighlight = Exclude<HoverHighlightStyle, (typeof HIGHLIGHT_CHOICES)[number]['value']>;
type MissingCursor = Exclude<ReadingCursor, (typeof CURSOR_CHOICES)[number]['value']>;
type MissingHighlightLine = Exclude<HighlightLine, (typeof HIGHLIGHT_LINE_CHOICES)[number]['value']>;
type MissingAnnotationEntry = Exclude<AnnotationEntry, (typeof ANNOTATION_ENTRY_CHOICES)[number]['value']>;
function assertNoneMissing<T extends never>(): void {}
assertNoneMissing<MissingHighlight>();
assertNoneMissing<MissingCursor>();
assertNoneMissing<MissingHighlightLine>();
assertNoneMissing<MissingAnnotationEntry>();

function match<T extends string>(value: unknown, choices: readonly { value: T }[]): T | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const wanted = value.trim().toLowerCase();
  for (const c of choices) {
    if (c.value.toLowerCase() === wanted) {
      return c.value;
    }
  }
  return undefined;
}

/** A known highlight style (case-insensitive), or undefined for anything else. */
export function knownHighlight(value: unknown): HoverHighlightStyle | undefined {
  return match(value, HIGHLIGHT_CHOICES);
}

/** A known cursor (case-insensitive, so a hand-typed `ibeam` is `iBeam`), or undefined. */
export function knownCursor(value: unknown): ReadingCursor | undefined {
  return match(value, CURSOR_CHOICES);
}

/** A known band line (case-insensitive), or undefined. */
export function knownHighlightLine(value: unknown): HighlightLine | undefined {
  return match(value, HIGHLIGHT_LINE_CHOICES);
}

/** A known annotation entry (case-insensitive), or undefined. */
export function knownAnnotationEntry(value: unknown): AnnotationEntry | undefined {
  return match(value, ANNOTATION_ENTRY_CHOICES);
}

export type ReadingAidSection = 'Highlight' | 'Cursor' | 'Highlight line' | 'Annotation entry';

/** Placeholder for the picker's filter box, so the always-present VS Code input reads as intended. */
export const READING_AIDS_PLACEHOLDER = 'Pick a reading aid (type to filter)';

/** One selectable row of the picker: the setting it writes and whether it is the current value. */
export interface ReadingAidItem {
  section: ReadingAidSection;
  label: string;
  setting:
    | typeof HOVER_HIGHLIGHT_SETTING
    | typeof READING_CURSOR_SETTING
    | typeof HIGHLIGHT_LINE_SETTING
    | typeof ANNOTATION_ENTRY_SETTING;
  value: string;
  current: boolean;
}

/**
 * The picker rows, in section order Highlight, Cursor, Highlight line, Annotation entry, with the
 * effective current value of each marked.
 */
export function readingAidItems(
  storedHighlight: unknown,
  storedCursor: unknown,
  storedHighlightLine?: unknown,
  storedAnnotationEntry?: unknown,
): ReadingAidItem[] {
  const sections: {
    section: ReadingAidSection;
    setting: ReadingAidItem['setting'];
    choices: readonly { value: string; label: string }[];
    current: string;
  }[] = [
    {
      section: 'Highlight',
      setting: HOVER_HIGHLIGHT_SETTING,
      choices: HIGHLIGHT_CHOICES,
      current: knownHighlight(storedHighlight) ?? DEFAULT_HOVER_HIGHLIGHT,
    },
    {
      section: 'Cursor',
      setting: READING_CURSOR_SETTING,
      choices: CURSOR_CHOICES,
      current: knownCursor(storedCursor) ?? DEFAULT_READING_CURSOR,
    },
    {
      section: 'Highlight line',
      setting: HIGHLIGHT_LINE_SETTING,
      choices: HIGHLIGHT_LINE_CHOICES,
      current: knownHighlightLine(storedHighlightLine) ?? DEFAULT_HIGHLIGHT_LINE,
    },
    {
      section: 'Annotation entry',
      setting: ANNOTATION_ENTRY_SETTING,
      choices: ANNOTATION_ENTRY_CHOICES,
      current: knownAnnotationEntry(storedAnnotationEntry) ?? DEFAULT_ANNOTATION_ENTRY,
    },
  ];
  const items: ReadingAidItem[] = [];
  for (const s of sections) {
    for (const c of s.choices) {
      items.push({
        section: s.section,
        label: c.label,
        setting: s.setting,
        value: c.value,
        current: c.value === s.current,
      });
    }
  }
  return items;
}

/**
 * The row the picker opens on: the current highlight style. VS Code otherwise starts on the first
 * row (None), where an immediate Enter would switch the highlight off.
 */
export function initialActiveRow(rows: readonly ReadingAidItem[]): ReadingAidItem | undefined {
  return rows.find((r) => r.section === 'Highlight' && r.current);
}
