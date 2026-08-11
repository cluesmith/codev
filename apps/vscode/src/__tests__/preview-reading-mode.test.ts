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
  workspace: {
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d: unknown) => d) })),
    applyEdit: vi.fn(async () => true),
  },
  window: { showInformationMessage: vi.fn(async () => undefined) },
  Uri: { joinPath: vi.fn((...parts: unknown[]) => ({ toString: () => parts.join('/') })) },
  Position: class {}, Range: class {}, WorkspaceEdit: class {},
}));
const { sanitizeReadingMode, READING_MODE_STATE_KEY, MarkdownPreviewProvider } = await import(
  '../markdown-preview/preview-provider.js'
);

/** Fake Memento + webview panel, enough to drive `resolveCustomTextEditor` end to end. */
function makeHostFixture(stored?: unknown) {
  const memento = {
    get: vi.fn(() => stored),
    update: vi.fn(async () => undefined),
  };
  let messageHandler: ((msg: unknown) => void) | undefined;
  const panel = {
    webview: {
      options: undefined as unknown,
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: { toString(): string }) => u,
      onDidReceiveMessage: vi.fn((h: (msg: unknown) => void) => { messageHandler = h; }),
      postMessage: vi.fn(),
    },
    onDidDispose: vi.fn(),
  };
  const document = {
    uri: { toString: () => 'file:///codev/specs/1.md' },
    getText: () => '# Doc',
  };
  const provider = new MarkdownPreviewProvider(
    { toString: () => 'ext:' } as never,
    { getData: () => undefined } as never,
    memento as never,
  );
  provider.resolveCustomTextEditor(document as never, panel as never, undefined as never);
  return { memento, panel, sendMessage: (msg: unknown) => messageHandler?.(msg) };
}

describe('persistence round-trip through the provider (iter-1 consult)', () => {
  it('readingModeChange persists a valid mode to globalState under the stable key', () => {
    const { memento, sendMessage } = makeHostFixture();
    sendMessage({ type: 'readingModeChange', mode: 'horizontal' });
    expect(memento.update).toHaveBeenCalledWith(READING_MODE_STATE_KEY, 'horizontal');
    sendMessage({ type: 'readingModeChange', mode: 'vertical' });
    expect(memento.update).toHaveBeenLastCalledWith(READING_MODE_STATE_KEY, 'vertical');
  });

  it('a garbage mode from the webview is dropped, never stored', () => {
    const { memento, sendMessage } = makeHostFixture();
    for (const junk of ['sideways', 42, null, undefined]) {
      sendMessage({ type: 'readingModeChange', mode: junk });
    }
    expect(memento.update).not.toHaveBeenCalled();
  });

  it('the initial HTML seeds from the persisted globalState value', () => {
    const { panel } = makeHostFixture('horizontal');
    expect(panel.webview.html).toContain('data-reading-mode="horizontal"');
  });

  it('a corrupt persisted value seeds nothing (canvas defaults to vertical)', () => {
    const { panel } = makeHostFixture('diagonal');
    expect(panel.webview.html).not.toContain('data-reading-mode');
  });
});

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
