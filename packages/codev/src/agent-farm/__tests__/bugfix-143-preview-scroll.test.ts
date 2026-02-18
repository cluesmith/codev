/**
 * Regression test for bugfix #143: Can't scroll to bottom with markdown preview
 *
 * The bug: open.html's preview container used `height: calc(100vh - 80px)` which
 * hardcoded the header height. When the actual header was taller than 80px, the
 * container extended beyond the viewport, creating a confusing double-scroll
 * (page scroll + container scroll) that prevented reaching the bottom content.
 *
 * The fix: Replace the hardcoded height with a flex layout. body.preview-active
 * uses `display: flex; flex-direction: column; overflow: hidden` to constrain to
 * viewport. The preview container uses `flex: 1; min-height: 0` to fill remaining
 * space, with `overflow: auto` for scrolling. This creates a single scroll context.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Bugfix #143: Preview scroll-to-bottom', () => {
  const templatePath = resolve(
    import.meta.dirname,
    '../../../templates/open.html',
  );
  const html = readFileSync(templatePath, 'utf-8');

  describe('CSS layout prevents double-scroll', () => {
    it('body.preview-active should use flex column layout with overflow hidden', () => {
      // body.preview-active must be a flex column to distribute height correctly
      expect(html).toMatch(/body\.preview-active\s*\{[^}]*display:\s*flex/);
      expect(html).toMatch(/body\.preview-active\s*\{[^}]*flex-direction:\s*column/);
      // overflow: hidden prevents page-level scroll (only container scrolls)
      expect(html).toMatch(/body\.preview-active\s*\{[^}]*overflow:\s*hidden/);
    });

    it('header should not shrink in flex layout', () => {
      // Header must have flex-shrink: 0 so it keeps its natural height
      expect(html).toMatch(/\.header\s*\{[^}]*flex-shrink:\s*0/);
    });

    it('preview container should use flex: 1 with min-height: 0', () => {
      // flex: 1 fills remaining space after header
      expect(html).toMatch(/#preview-container\s*\{[^}]*flex:\s*1/);
      // min-height: 0 allows shrinking below content size (required for overflow to work)
      expect(html).toMatch(/#preview-container\s*\{[^}]*min-height:\s*0/);
    });

    it('preview container inline style should NOT use hardcoded height: calc(...)', () => {
      // The old broken approach: height: calc(100vh - 80px) assumed header = 80px
      // Extract the inline style of the preview-container element
      const match = html.match(/id="preview-container"\s+style="([^"]*)"/);
      expect(match).toBeTruthy();
      const inlineStyle = match![1];
      expect(inlineStyle).not.toMatch(/height:\s*calc\(/);
    });

    it('preview container inline style should have overflow: auto', () => {
      // The inline style on the preview container element must include overflow: auto
      expect(html).toMatch(/id="preview-container"[^>]*overflow:\s*auto/);
    });
  });

  describe('toggle function preserves scroll context', () => {
    it('should add preview-active class to body when entering preview mode', () => {
      // The toggle function must add the class that activates the flex layout
      expect(html).toContain("document.body.classList.add('preview-active')");
    });

    it('should remove preview-active class when leaving preview mode', () => {
      expect(html).toContain("document.body.classList.remove('preview-active')");
    });
  });
});
