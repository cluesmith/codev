/**
 * Reading aids at the VS Code host boundary (#1802, #1850): the picker model (`reading-aids.ts`) and the
 * bootstrap attributes the template embeds on `#root` for the canvas to read at mount.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  READING_AIDS_PLACEHOLDER,
  initialActiveRow,
  knownAnnotationEntry,
  knownCursor,
  knownHighlight,
  knownHighlightLine,
  readingAidItems,
} from '../markdown-preview/reading-aids.js';
import { renderMarkdownPreviewHtml } from '../markdown-preview/preview-template.js';
import {
  parseAnnotationEntry,
  parseHighlightLine,
  parseHighlightStyle,
  parseReadingCursor,
} from '@cluesmith/codev-artifact-canvas';
import {
  DEFAULT_ANNOTATION_ENTRY,
  DEFAULT_HIGHLIGHT_LINE,
  DEFAULT_HOVER_HIGHLIGHT,
  DEFAULT_READING_CURSOR,
} from '../markdown-preview/reading-aids.js';

const base = { cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css' };
const rootTag = (html: string): string => html.match(/<div id="root"[^>]*>/)![0];

describe('reading aids picker model', () => {
  it('lists None first, then the five styles, the three cursors, the two band lines, the two entries', () => {
    const rows = readingAidItems(undefined, undefined);
    expect(rows.map((r) => `${r.section}:${r.label}`)).toEqual([
      'Highlight:None',
      'Highlight:Word',
      'Highlight:Word and line',
      'Highlight:Word, line and paragraph',
      'Highlight:Line',
      'Highlight:Line and paragraph',
      'Cursor:Arrow',
      'Cursor:I-beam',
      'Cursor:Hand',
      'Highlight line:Line under the pointer',
      'Highlight line:Line above the pointer',
      'Annotation entry:Gutter + button',
      'Annotation entry:Click the paragraph',
    ]);
  });

  it('marks the defaults current when nothing is stored', () => {
    const current = readingAidItems(undefined, undefined).filter((r) => r.current).map((r) => r.value);
    expect(current).toEqual(['lineParagraph', 'arrow', 'underPointer', 'gutterButton']);
  });

  it('marks the stored values current, matching case-insensitively', () => {
    const current = readingAidItems('none', 'ibeam', 'ABOVEPOINTER', 'clickparagraph')
      .filter((r) => r.current)
      .map((r) => r.value);
    expect(current).toEqual(['none', 'iBeam', 'abovePointer', 'clickParagraph']);
  });

  it('falls back to the defaults for unknown band-line and entry values', () => {
    const current = readingAidItems(undefined, undefined, 'sideways', 7).filter((r) => r.current).map((r) => r.value);
    expect(current).toEqual(['lineParagraph', 'arrow', 'underPointer', 'gutterButton']);
  });

  it('names the setting and value each row writes', () => {
    const rows = readingAidItems(undefined, undefined);
    const hand = rows.find((r) => r.label === 'Hand')!;
    expect([hand.setting, hand.value]).toEqual(['readingCursor', 'hand']);
    const none = rows.find((r) => r.label === 'None')!;
    expect([none.setting, none.value]).toEqual(['hoverHighlight', 'none']);
    const above = rows.find((r) => r.label === 'Line above the pointer')!;
    expect([above.setting, above.value]).toEqual(['highlightLine', 'abovePointer']);
    const click = rows.find((r) => r.label === 'Click the paragraph')!;
    expect([click.setting, click.value]).toEqual(['annotationEntry', 'clickParagraph']);
  });

  it('opens on the current highlight style, not on None', () => {
    expect(initialActiveRow(readingAidItems(undefined, undefined))?.value).toBe('lineParagraph');
    expect(initialActiveRow(readingAidItems('word', 'hand'))?.value).toBe('word');
    expect(initialActiveRow(readingAidItems('word', 'hand', 'abovePointer', 'clickParagraph'))?.value).toBe('word');
  });

  it('labels the filter box', () => {
    expect(READING_AIDS_PLACEHOLDER).toMatch(/type to filter/);
  });

  it('rejects unknown values', () => {
    expect(knownHighlight('sparkle')).toBeUndefined();
    expect(knownHighlight(42)).toBeUndefined();
    expect(knownCursor('finger')).toBeUndefined();
    expect(knownHighlightLine('sideways')).toBeUndefined();
    expect(knownAnnotationEntry('doubleClick')).toBeUndefined();
  });
});

describe('reading aids bootstrap attributes', () => {
  it('emits both attributes for known values, in canonical spelling', () => {
    const tag = rootTag(renderMarkdownPreviewHtml({ ...base, hoverHighlight: 'WORD', readingCursor: 'ibeam' }));
    expect(tag).toContain('data-hover-highlight="word"');
    expect(tag).toContain('data-reading-cursor="iBeam"');
  });

  it('emits the band-line and entry attributes for known values, in canonical spelling', () => {
    const tag = rootTag(
      renderMarkdownPreviewHtml({ ...base, highlightLine: 'abovepointer', annotationEntry: 'CLICKPARAGRAPH' }),
    );
    expect(tag).toContain('data-highlight-line="abovePointer"');
    expect(tag).toContain('data-annotation-entry="clickParagraph"');
  });

  it('omits them for missing or unknown values', () => {
    expect(rootTag(renderMarkdownPreviewHtml(base))).toBe('<div id="root">');
    const tag = rootTag(
      renderMarkdownPreviewHtml({
        ...base,
        hoverHighlight: '"><script>',
        readingCursor: 'finger',
        highlightLine: '"><img>',
        annotationEntry: 'doubleClick',
      }),
    );
    expect(tag).toBe('<div id="root">');
  });

  it('strengthens the line band and paragraph tint in dark themes only', () => {
    const html = renderMarkdownPreviewHtml(base);
    const dark = html.slice(html.indexOf('body.vscode-dark'));
    expect(dark).toContain('--codev-canvas-hover-line-background: color-mix(in srgb, var(--codev-canvas-foreground) 12%');
    expect(dark).toContain('--codev-canvas-hover-paragraph-background: color-mix(in srgb, var(--codev-canvas-foreground) 6%');
    expect(html).not.toContain('vscode-light .codev-artifact-canvas');
  });

  it('maps the word pill token to the theme hover color', () => {
    expect(renderMarkdownPreviewHtml(base)).toContain(
      '--codev-canvas-hover-word-background: var(--vscode-toolbar-hoverBackground);',
    );
  });
});

describe('reading aids contributions', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties ?? pkg.contributes.configuration[0]?.properties;

  it('declares both settings with the picker vocabulary and defaults', () => {
    expect(props['codev.markdownPreview.hoverHighlight'].enum).toEqual([
      'none',
      'word',
      'wordLine',
      'wordLineParagraph',
      'line',
      'lineParagraph',
    ]);
    expect(props['codev.markdownPreview.hoverHighlight'].default).toBe('lineParagraph');
    expect(props['codev.markdownPreview.readingCursor'].enum).toEqual(['arrow', 'iBeam', 'hand']);
    expect(props['codev.markdownPreview.readingCursor'].default).toBe('arrow');
    expect(props['codev.markdownPreview.highlightLine'].enum).toEqual(['underPointer', 'abovePointer']);
    expect(props['codev.markdownPreview.highlightLine'].default).toBe('underPointer');
    expect(props['codev.markdownPreview.annotationEntry'].enum).toEqual(['gutterButton', 'clickParagraph']);
    expect(props['codev.markdownPreview.annotationEntry'].default).toBe('gutterButton');
  });

  it('keeps the default in one agreement: canvas, host picker and settings schema', () => {
    // The vocabulary twin is compile-checked; the default is pinned here (three places).
    expect(DEFAULT_HOVER_HIGHLIGHT).toBe(parseHighlightStyle(undefined));
    expect(props['codev.markdownPreview.hoverHighlight'].default).toBe(DEFAULT_HOVER_HIGHLIGHT);
    expect(DEFAULT_READING_CURSOR).toBe(parseReadingCursor(undefined));
    expect(props['codev.markdownPreview.readingCursor'].default).toBe(DEFAULT_READING_CURSOR);
    expect(DEFAULT_HIGHLIGHT_LINE).toBe(parseHighlightLine(undefined));
    expect(props['codev.markdownPreview.highlightLine'].default).toBe(DEFAULT_HIGHLIGHT_LINE);
    expect(DEFAULT_ANNOTATION_ENTRY).toBe(parseAnnotationEntry(undefined));
    expect(props['codev.markdownPreview.annotationEntry'].default).toBe(DEFAULT_ANNOTATION_ENTRY);
  });

  it('puts Reading Aids… in the preview title-bar overflow beside Reset Font Size', () => {
    const entry = pkg.contributes.menus['editor/title'].find(
      (m: { command: string }) => m.command === 'codev.markdownPreview.readingAids',
    );
    const reset = pkg.contributes.menus['editor/title'].find(
      (m: { command: string }) => m.command === 'codev.markdownPreview.resetFontSize',
    );
    expect(entry.group).toBe(reset.group);
    expect(entry.when).toBe(reset.when);
  });
});
