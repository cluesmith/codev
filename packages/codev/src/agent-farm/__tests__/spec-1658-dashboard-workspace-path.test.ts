/**
 * Spec 1658, finding M8: the Tower dashboard's workspace buttons (Start, Stop,
 * Restart, + Create, copy path) embedded the workspace path in a single-quoted
 * JS string inside an inline onclick. escapeHtml leaves backslashes alone, so
 * JS read a Windows path's `\r`, `\t`, ... as escape sequences: Start got a
 * drive-relative path and Stop a path matching no workspace. The path now
 * rides a data-workspace-path attribute, read back through this.dataset.
 *
 * The test renders the real renderInstance / renderRecentItem from tower.html
 * (the M7 test's approach) and checks the markup, without a DOM.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const towerHtmlPath = path.resolve(import.meta.dirname, '../../../templates/tower.html');

interface Renderers {
  renderInstance: (instance: Record<string, unknown>) => string;
  renderRecentItem: (instance: Record<string, unknown>) => string;
}

function loadRenderers(): Renderers {
  const html = fs.readFileSync(towerHtmlPath, 'utf-8');
  const sources = ['escapeHtml', 'relUrl', 'formatDate', 'renderInstance', 'renderRecentItem'].map((name) => {
    const match = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`));
    expect(match, name).not.toBeNull();
    return match![0];
  });
  // The page-level flag renderInstance reads; true so the Open IDE link renders too.
  const pageState = 'let ideAvailable = true;';
  return new Function(`${pageState}\n${sources.join('\n')}\nreturn { renderInstance, renderRecentItem };`)() as Renderers;
}

/** The value a browser's dataset returns for an attribute escapeHtml wrote. */
function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const WINDOWS_PATH = "C:\\src\\tools\\it's\\project";

function instance(running: boolean): Record<string, unknown> {
  return {
    workspacePath: WINDOWS_PATH,
    workspaceName: 'project',
    running,
    proxyUrl: '/workspace/abc/',
    terminals: [],
    lastUsed: new Date().toISOString(),
  };
}

function renderAll(): string {
  const { renderInstance, renderRecentItem } = loadRenderers();
  return [renderInstance(instance(true)), renderInstance(instance(false)), renderRecentItem(instance(false))].join('\n');
}

describe('Spec 1658 M8: dashboard workspace buttons carry the path in a data attribute', () => {
  it('no onclick embeds the workspace path in a JS string literal', () => {
    const markup = renderAll();
    const handlers = [...markup.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(handler).not.toMatch(/\('[^']*tools/);
      expect(handler).not.toContain('tools');
    }
  });

  it('each workspace handler reads this.dataset.workspacePath', () => {
    const markup = renderAll();
    for (const name of ['createShell', 'restartInstance', 'stopInstance', 'launchPath', 'copyPath']) {
      expect(markup).toContain(`${name}(this.dataset.workspacePath)`);
    }
  });

  it('a backslash path written as data-workspace-path reads back unchanged', () => {
    const markup = renderAll();
    const values = [...markup.matchAll(/data-workspace-path="([^"]*)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(7);
    for (const value of values) {
      expect(decodeAttribute(value)).toBe(WINDOWS_PATH);
    }
  });
});
