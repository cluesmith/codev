import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM build script, no type declarations.
import { ICONS, BRAND_ICONS, extractGlyph, extractBrandMark } from '../../scripts/render-action-icons.mjs';

/**
 * #1440: the action icons are rendered FROM face.ts's GLYPHS map, not re-drawn — the render
 * script parses the vector out of face.ts so the picker icon and the runtime key face share one
 * source. These guards protect that contract: if GLYPHS's declaration shape drifts, the extractor
 * must throw (a loud build failure) rather than silently ship a stale icon.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const faceSrc = readFileSync(join(root, 'src', 'face.ts'), 'utf-8');
const pluginSvg = readFileSync(
  join(root, 'com.cluesmith.codev.sdPlugin', 'icons', 'plugin.svg'),
  'utf-8',
);

describe('extractGlyph pulls the glyph vector out of face.ts', () => {
  for (const { name, glyph } of ICONS) {
    it(`${name} extracts the '${glyph}' glyph as a colored SVG group`, () => {
      const svg = extractGlyph(faceSrc, glyph, '#ffffff');
      expect(svg).toContain('#ffffff');
      // comment/terminal are line glyphs: rendered through the stroked() wrapper.
      expect(svg).toMatch(/stroke="#ffffff"/);
      expect(svg).not.toContain('${c}'); // the color placeholder must be substituted
    });
  }

  it('throws on an unknown glyph key rather than emitting nothing', () => {
    expect(() => extractGlyph(faceSrc, 'no-such-glyph', '#ffffff')).toThrow(/not found/);
  });

  it('terminal glyph carries the terminal shape (rect + prompt path)', () => {
    const svg = extractGlyph(faceSrc, 'terminal', '#ffffff');
    expect(svg).toContain('<rect');
    expect(svg).toContain('<path');
  });

  it('architect glyph carries the person shape (head circle + shoulders path) (#1463)', () => {
    const svg = extractGlyph(faceSrc, 'architect', '#ffffff');
    expect(svg).toContain('<circle');
    expect(svg).toContain('<path');
  });
});

/**
 * #1444: the catch-all `action` icon renders from the Codev brand mark in icons/plugin.svg, NOT a
 * face.ts glyph — a terminal glyph both mislabeled a configurable verb runner and collided with
 * #1440's dedicated open-terminal icon. These guards keep the brand-mark extractor honest: it must
 * pull the mark's group and viewBox, and throw loudly if plugin.svg's shape drifts.
 */
describe('extractBrandMark pulls the Codev mark out of plugin.svg', () => {
  it('routes the catch-all action through the brand source, not a glyph', () => {
    expect(BRAND_ICONS).toEqual([{ name: 'action' }]);
    // The re-glyph must not reintroduce a glyph source for `action`.
    expect(ICONS.some((i: { name: string }) => i.name === 'action')).toBe(false);
  });

  it('returns the mark group and the svg viewBox', () => {
    const mark = extractBrandMark(pluginSvg);
    expect(mark.viewBox).toMatch(/^[\d.\s]+$/);
    expect(mark.inner).toMatch(/^<g\b/);
    expect(mark.inner).toContain('<path');
    // The mark is already white; it carries no ${c} recolor placeholder like the glyphs.
    expect(mark.inner).not.toContain('${c}');
  });

  it('leaves the opaque background rect behind so the mark renders transparent', () => {
    const mark = extractBrandMark(pluginSvg);
    expect(mark.inner).not.toContain('<rect');
  });

  it('throws when the mark group is absent rather than emitting nothing', () => {
    expect(() => extractBrandMark('<svg viewBox="0 0 24 24"></svg>')).toThrow(/brand mark/);
  });
});
