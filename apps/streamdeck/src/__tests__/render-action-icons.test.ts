import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM build script, no type declarations.
import { ICONS, extractGlyph } from '../../scripts/render-action-icons.mjs';

/**
 * #1440: the action icons are rendered FROM face.ts's GLYPHS map, not re-drawn — the render
 * script parses the vector out of face.ts so the picker icon and the runtime key face share one
 * source. These guards protect that contract: if GLYPHS's declaration shape drifts, the extractor
 * must throw (a loud build failure) rather than silently ship a stale icon.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const faceSrc = readFileSync(join(root, 'src', 'face.ts'), 'utf-8');

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
});
