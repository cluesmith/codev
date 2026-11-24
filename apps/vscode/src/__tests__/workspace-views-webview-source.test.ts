/**
 * Spec 1963 scenario 22 (source): the panels' webview code does no I/O of its own. Every Tower call
 * is a message to the extension host; the webview has no `fetch`, XHR, WebSocket, EventSource or
 * beacon, and opens no window. The shared package holds the same rule for its own sources
 * (`packages/workspace-views/src/__tests__/import-boundary.test.ts`). ESLint flags the same globals
 * here while editing (`eslint.config.mjs`); this test is what CI runs.
 *
 * The webview's tests are excluded: they are not shipped.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WEBVIEW = resolve(__dirname, '../workspace-views/webview');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__') { out.push(...sources(full)); }
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: 'fetch()', pattern: /\bfetch\s*\(/ },
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: 'WebSocket', pattern: /\bWebSocket\b/ },
  { label: 'EventSource', pattern: /\bEventSource\b/ },
  { label: 'sendBeacon', pattern: /\bsendBeacon\b/ },
  { label: 'window.open', pattern: /\bwindow\.open\s*\(/ },
  { label: 'vscode', pattern: /from\s+['"]vscode['"]/ },
];

describe('the workspace-views webview sources', () => {
  const files = sources(WEBVIEW);

  it('finds the sources', () => {
    expect(files.map(f => f.slice(WEBVIEW.length + 1))).toEqual(
      expect.arrayContaining(['DecisionsApp.tsx', 'decisions-host.ts', 'decisions-main.tsx']),
    );
  });

  it('do no network I/O and open no window', () => {
    const violations = files.flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ label }) => `${file}: ${label}`);
    });
    expect(violations).toEqual([]);
  });
});
