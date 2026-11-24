/**
 * Spec 1963: the Decisions panel's webview bundle, built the way `esbuild.js` builds it (from the
 * same options in `esbuild.webview.cjs`) and booted in a jsdom window of its own with a fake
 * `acquireVsCodeApi`. (The test runs in node: esbuild refuses to run inside vitest's jsdom
 * environment, and a window of its own keeps the bundle's globals out of the test's.)
 * Unit tests import the sources; this is what proves the shipped bundle starts: it mounts, says
 * it is ready, reads only once the extension host says the panel is visible, and renders the reply.
 * It also holds the bundle to one copy of React and to emitting its stylesheet.
 *
 * Every check runs on both builds, development and production (minified, what the vsix ships), each
 * booted in the escaped form the panel inlines (`panel-template.ts`).
 *
 * Built into a temporary directory, never `dist`: CI runs the unit tests without a build.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Metafile } from 'esbuild';
import { inlineScriptText, inlineStyleText } from '../workspace-views/panel-template.js';
import type { DecisionsDocument } from '@cluesmith/codev-types';

const require = createRequire(import.meta.url);
const { decisionsWebviewConfig } = require('../../esbuild.webview.cjs') as {
  decisionsWebviewConfig: (options: { production: boolean }) => Parameters<typeof build>[0];
};

/** The part of a jsdom window this test uses (the package ships no types of its own). */
interface BundleWindow {
  eval(code: string): unknown;
  dispatchEvent(event: unknown): boolean;
  MessageEvent: new (type: string, init: { data: unknown }) => unknown;
  document: { querySelector(selector: string): { textContent: string | null } | null; visibilityState: string };
  acquireVsCodeApi?: () => { postMessage(message: unknown): void };
  close(): void;
}
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'outside-only'; pretendToBeVisual: boolean }) => { window: BundleWindow };
};

const DOC: DecisionsDocument = {
  path: 'codev/state/pending-decisions.md',
  version: 'v1',
  items: [{
    id: 'main-12',
    stamp: null,
    question: 'Merge the onboarding scan fix?',
    bodyMarkdown: 'It fixes the scan.',
    options: [{ word: 'accept', description: 'merge as is', recommended: true }],
    currentRuling: '',
    qa: [],
    fingerprint: 'fp-main-12',
    problems: [],
    writable: true,
  }],
  ruledMarkdown: '',
  problems: [],
};

/** Both builds: the development one, and the production (minified) one that ships in the vsix. */
const BUILDS = [
  { label: 'development', production: false },
  { label: 'production, as shipped', production: true },
];

describe.each(BUILDS)('built for $label', ({ production }) => {
  let outDir: string;
  let metafile: Metafile;
  let script: string;
  let win: BundleWindow;
  const posted: unknown[] = [];

  const fromHost = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data }));

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'codev-decisions-bundle-'));
    const result = await build({
      ...decisionsWebviewConfig({ production }),
      outfile: join(outDir, 'decisions.js'),
      sourcemap: false,
      metafile: true,
    });
    metafile = result.metafile!;
    script = readFileSync(join(outDir, 'decisions.js'), 'utf8');

    win = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
    // Copied out of the window's realm, as postMessage's structured clone would.
    win.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) });
    // Booted as the panel inlines it (panel-template.ts): the escaped text is what runs.
    win.eval(inlineScriptText(script));
  }, 60_000);

  afterAll(() => {
    if (win) {
      fromHost({ type: 'visibility', visible: false });
      win.close();
    }
    if (outDir) { rmSync(outDir, { recursive: true, force: true }); }
  });

  describe('the Decisions webview bundle', () => {
    it('mounts and tells the extension host it is ready, reading nothing yet', () => {
      expect(posted).toEqual([{ type: 'ready' }]);
    });

    it('reads once the extension host says the panel is visible, and renders the reply', async () => {
      fromHost({ type: 'visibility', visible: true });
      await vi.waitFor(() => expect(posted).toContainEqual({ type: 'decisions/read', requestId: 0 }));
      fromHost({ type: 'decisions/read-result', requestId: 0, result: { kind: 'document', document: DOC } });
      expect(win.document.visibilityState).toBe('visible');
      await vi.waitFor(() => {
        const card = win.document.querySelector('article.decisions-card');
        expect(card?.textContent).toContain('Merge the onboarding scan fix?');
        expect(card?.textContent).toContain('It fixes the scan.');
      });
    });

    it('bundles one copy of React and of React DOM', () => {
      const copies = (name: string) => new Set(Object.keys(metafile.inputs)
        .map(input => input.replace(/\\/g, '/').match(new RegExp(`^(.*(?:^|/)node_modules/${name}/)`))?.[1])
        .filter((root): root is string => root !== undefined));
      expect(copies('react').size).toBe(1);
      expect(copies('react-dom').size).toBe(1);
    });

    it("emits one stylesheet holding the shared views' styles and the VS Code theme mapping", () => {
      const outputs = Object.keys(metafile.outputs).map(output => output.replace(/\\/g, '/'));
      expect(outputs.filter(output => output.endsWith('.css'))).toHaveLength(1);
      const css = readFileSync(join(outDir, 'decisions.css'), 'utf8');
      expect(css).toContain('.decisions-card');
      expect(css).toContain('--codev-wv-accent: var(--vscode-');
      expect(css).toContain('.wv-fullsize');
    });

    it('loads nothing by URL, so it renders where a webview cannot fetch (cluesmith/codev-ide#67)', () => {
      const css = readFileSync(join(outDir, 'decisions.css'), 'utf8');
      expect(css).not.toMatch(/url\(|@import|@font-face/i);
      // No import of any kind is left in the output (a dynamic one would be fetched); React's dev
      // warnings quote `import('./MyComponent')` as text, so the metafile is the check, not the text.
      expect(Object.values(metafile.outputs).flatMap(output => output.imports)).toEqual([]);
      expect(script).not.toMatch(/\bWorker\s*\(|importScripts|sourceMappingURL=(?!data:)/);
      expect(decisionsWebviewConfig({ production: true }).sourcemap).toBe(false);
      expect(decisionsWebviewConfig({ production: false }).sourcemap).toBe('inline');
    });

    it('inlines without a sequence that would end its element, though the bundle holds them', () => {
      expect(script).toMatch(/<!--/);
      expect(inlineScriptText(script)).not.toMatch(/<\/script|<!--/i);
      expect(inlineStyleText(readFileSync(join(outDir, 'decisions.css'), 'utf8'))).not.toMatch(/<\/style/i);
    });
  });
});
