/**
 * Reading-mode persistence at the VS Code host boundary (spec 1380 D4, plan phase 6).
 *
 * The seam has three parts: `sanitizeReadingMode` (the closed-vocabulary gate every untrusted
 * value crosses — persisted storage in, webview messages in), the bootstrap embedding in the
 * template HTML (the canvas mounts before the first host message, so the initial mode travels
 * as a `data-reading-mode` attribute), and the provider's persistence of `readingModeChange`.
 * The first two are pure and tested directly here; the provider path is covered through the
 * same sanitize gate it calls.
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdownPreviewHtml } from '../markdown-preview/preview-template.js';

// preview-provider imports 'vscode' at module top; go through the template + a re-exported
// sanitize copy would drift, so mock vscode minimally to import the real function.
import { vi } from 'vitest';
vi.mock('vscode', () => ({
  workspace: {}, window: {}, Position: class {}, Range: class {}, WorkspaceEdit: class {},
}));
const { sanitizeReadingMode, READING_MODE_STATE_KEY } = await import(
  '../markdown-preview/preview-provider.js'
);

describe('sanitizeReadingMode (untrusted-value gate)', () => {
  it('passes the two known modes through', () => {
    expect(sanitizeReadingMode('vertical')).toBe('vertical');
    expect(sanitizeReadingMode('horizontal')).toBe('horizontal');
  });

  it('rejects everything else — corrupt storage, hostile messages, non-strings', () => {
    for (const junk of ['sideways', '', 'HORIZONTAL', 42, null, undefined, {}, ['horizontal']]) {
      expect(sanitizeReadingMode(junk)).toBeUndefined();
    }
  });

  it('uses a stable storage key (a rename would orphan every user preference)', () => {
    expect(READING_MODE_STATE_KEY).toBe('codev.markdownPreview.readingMode');
  });
});

describe('bootstrap embedding in the webview template', () => {
  const base = {
    cspSource: 'vscode-resource:',
    scriptUri: 'https://x/main.js',
    styleUri: 'https://x/main.css',
  };

  it('embeds a validated mode as data-reading-mode on #root', () => {
    const html = renderMarkdownPreviewHtml({ ...base, initialReadingMode: 'horizontal' });
    expect(html).toContain('<div id="root" data-reading-mode="horizontal"></div>');
  });

  it('omits the attribute entirely when no mode (or an invalid one) is supplied', () => {
    expect(renderMarkdownPreviewHtml(base)).toContain('<div id="root"></div>');
    // Belt-and-braces: even if an unvalidated string reached the template, it contributes
    // nothing — the closed-vocabulary check lives in the template too.
    const html = renderMarkdownPreviewHtml({ ...base, initialReadingMode: '"><script>x</script>' });
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain('data-reading-mode');
  });

  it('provides the height context the horizontal mode requires (Constraint 3)', () => {
    const html = renderMarkdownPreviewHtml(base);
    expect(html).toMatch(/html, body \{ height: 100%/);
    expect(html).toMatch(/#root \{ height: 100%/);
  });
});
