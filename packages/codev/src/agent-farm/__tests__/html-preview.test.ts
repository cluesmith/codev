/**
 * Tests for HTML preview support in the annotation viewer (#536)
 *
 * When opening an HTML file with `af open`, the viewer should:
 * 1. Detect HTML files via IS_HTML template variable
 * 2. Show a sandboxed iframe preview by default
 * 3. Allow toggling between preview and annotated code view
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('HTML preview support (#536)', () => {
  const templatePath = resolve(
    import.meta.dirname,
    '../../../templates/open.html',
  );
  const routesPath = resolve(
    import.meta.dirname,
    '../servers/tower-routes.ts',
  );

  describe('template contains HTML preview elements', () => {
    it('should have IS_HTML template placeholder', () => {
      const html = readFileSync(templatePath, 'utf-8');
      expect(html).toContain('{{IS_HTML}}');
    });

    it('should declare isHtmlFile state variable', () => {
      const html = readFileSync(templatePath, 'utf-8');
      expect(html).toContain('const isHtmlFile = {{IS_HTML}}');
    });

    it('should have a sandboxed iframe for HTML preview', () => {
      const html = readFileSync(templatePath, 'utf-8');
      expect(html).toContain('id="html-preview-container"');
      expect(html).toContain('sandbox="allow-scripts"');
    });

    it('should have renderHtmlPreview function that sets srcdoc', () => {
      const html = readFileSync(templatePath, 'utf-8');
      expect(html).toContain('function renderHtmlPreview()');
      expect(html).toContain('iframe.srcdoc = currentContent');
    });

    it('should auto-show preview for HTML files on init', () => {
      const html = readFileSync(templatePath, 'utf-8');
      // After init() sets up the file, it should auto-toggle preview for HTML
      expect(html).toContain('if (isHtmlFile)');
      // The togglePreviewMode call must appear inside init()
      const initFn = html.slice(
        html.indexOf('function init(content)'),
        html.indexOf('function initPreviewToggle()'),
      );
      expect(initFn).toContain('togglePreviewMode()');
    });

    it('should enable preview toggle for HTML files', () => {
      const html = readFileSync(templatePath, 'utf-8');
      // initPreviewToggle should check for isHtmlFile
      const initToggleFn = html.slice(
        html.indexOf('function initPreviewToggle()'),
        html.indexOf('function initImage('),
      );
      expect(initToggleFn).toContain('isHtmlFile');
    });

    it('should support Cmd+Shift+P shortcut for HTML files', () => {
      const html = readFileSync(templatePath, 'utf-8');
      // The keyboard shortcut handler should include isHtmlFile
      expect(html).toContain('isMarkdownFile || isHtmlFile');
    });
  });

  describe('tower-routes detects HTML files', () => {
    it('should detect html and htm extensions', () => {
      const src = readFileSync(routesPath, 'utf-8');
      // Should have isHtml detection for both .html and .htm
      expect(src).toContain("const isHtml = ['html', 'htm'].includes(ext)");
    });

    it('should inject IS_HTML template variable', () => {
      const src = readFileSync(routesPath, 'utf-8');
      expect(src).toContain("html.replace(/\\{\\{IS_HTML\\}\\}/g, String(isHtml))");
    });
  });
});
