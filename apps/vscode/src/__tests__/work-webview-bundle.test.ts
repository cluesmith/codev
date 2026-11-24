/**
 * Spec 1963: the Work panel's webview bundle, built the way `esbuild.js` builds it (from the same
 * options in `esbuild.webview.cjs`) and booted in a jsdom window of its own with a fake
 * `acquireVsCodeApi`, as `decisions-webview-bundle.test.ts` boots the Decisions bundle.
 * Unit tests import the sources; this is what proves the shipped bundle starts: it mounts, says it
 * is ready, renders the overview the extension host pushes, and posts its actions. It also holds the
 * bundle to one copy of React and to emitting its stylesheet.
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

const require = createRequire(import.meta.url);
const { workWebviewConfig } = require('../../esbuild.webview.cjs') as {
  workWebviewConfig: (options: { production: boolean }) => Parameters<typeof build>[0];
};

/** The part of a jsdom window this test uses (the package ships no types of its own). */
interface BundleElement {
  textContent: string | null;
  click(): void;
}
interface BundleWindow {
  eval(code: string): unknown;
  dispatchEvent(event: unknown): boolean;
  MessageEvent: new (type: string, init: { data: unknown }) => unknown;
  document: {
    querySelector(selector: string): BundleElement | null;
    querySelectorAll(selector: string): ArrayLike<BundleElement>;
  };
  acquireVsCodeApi?: () => { postMessage(message: unknown): void };
  close(): void;
}
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'outside-only'; pretendToBeVisual: boolean }) => { window: BundleWindow };
};

const OVERVIEW = {
  builders: [{
    id: 'spir-1963', issueId: '1963', issueTitle: 'Cockpit layout', phase: 'implement', protocolPhase: 'implement', mode: 'strict',
    gates: {}, worktreePath: '/ws/.builders/spir-1963', roleId: 'builder-spir-1963', protocol: 'spir', planPhases: [], progress: 40,
    blocked: null, blockedGate: null, blockedSince: null, startedAt: null, idleMs: 0, lastDataAt: null, spawnedByArchitect: 'main',
    prReady: false, area: '',
  }],
  pendingPRs: [],
  backlog: [],
  recentlyClosed: [],
  architects: [{ name: 'main' }],
};

let outDir: string;
let metafile: Metafile;
let script: string;
let win: BundleWindow;
const posted: unknown[] = [];

const fromHost = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data }));

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'codev-work-bundle-'));
  const result = await build({
    ...workWebviewConfig({ production: false }),
    outfile: join(outDir, 'work.js'),
    sourcemap: false,
    metafile: true,
  });
  metafile = result.metafile!;
  script = readFileSync(join(outDir, 'work.js'), 'utf8');

  win = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  // Copied out of the window's realm, as postMessage's structured clone would.
  win.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) });
  // Booted as the panel inlines it (panel-template.ts): the escaped text is what runs.
  win.eval(inlineScriptText(script));
}, 60_000);

afterAll(() => {
  win?.close();
  if (outDir) { rmSync(outDir, { recursive: true, force: true }); }
});

describe('the Work webview bundle', () => {
  it('mounts in its loading state and tells the extension host it is ready', async () => {
    expect(posted).toEqual([{ type: 'ready' }]);
    await vi.waitFor(() => expect(win.document.querySelector('.work-loading')?.textContent).toBe('Loading...'));
  });

  it('renders the overview the extension host pushes, and posts Open', async () => {
    fromHost({ type: 'work/overview', overview: { data: OVERVIEW, error: null } });
    await vi.waitFor(() => expect(win.document.querySelector('.builder-table')?.textContent).toContain('Cockpit layout'));
    win.document.querySelector('.builder-row-open')!.click();
    expect(posted).toContainEqual({ type: 'work/open-builder', builderId: 'spir-1963' });
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
    const css = readFileSync(join(outDir, 'work.css'), 'utf8');
    expect(css).toContain('.builder-table');
    expect(css).toContain('--codev-wv-accent: var(--vscode-');
  });

  it('loads nothing by URL, so it renders where a webview cannot fetch (cluesmith/codev-ide#67)', () => {
    const css = readFileSync(join(outDir, 'work.css'), 'utf8');
    expect(css).not.toMatch(/url\(|@import|@font-face/i);
    // No import of any kind is left in the output (a dynamic one would be fetched); React's dev
    // warnings quote `import('./MyComponent')` as text, so the metafile is the check, not the text.
    expect(Object.values(metafile.outputs).flatMap(output => output.imports)).toEqual([]);
    expect(script).not.toMatch(/\bWorker\s*\(|importScripts|sourceMappingURL=(?!data:)/);
    expect(workWebviewConfig({ production: true }).sourcemap).toBe(false);
    expect(workWebviewConfig({ production: false }).sourcemap).toBe('inline');
  });

  it('inlines without a sequence that would end its element, though the bundle holds them', () => {
    expect(script).toMatch(/<!--/);
    expect(inlineScriptText(script)).not.toMatch(/<\/script|<!--/i);
    expect(inlineStyleText(readFileSync(join(outDir, 'work.css'), 'utf8'))).not.toMatch(/<\/style/i);
  });
});
