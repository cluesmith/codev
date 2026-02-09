/**
 * Tests for clipboard functionality in dashboard terminals
 * Ensures iframes have clipboard permissions and React dashboard
 * handles copy/paste via navigator.clipboard API.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Find project root by looking for codev directory
function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(resolve(dir, 'codev'))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

const projectRoot = findProjectRoot();

describe('Dashboard clipboard permissions', () => {
  // Note: Legacy dashboard.html was removed in favor of modular dashboard/index.html
  // The only iframe testing needed is for the modular dashboard's dynamic iframes (see below)

  // Modular dashboard (Spec 0060) creates iframes dynamically in JS
  it('modular dashboard tabs.js includes clipboard permissions on dynamic iframes', () => {
    const tabsJsPath = resolve(projectRoot, 'packages/codev/templates/dashboard/js/tabs.js');

    if (!existsSync(tabsJsPath)) {
      return;
    }

    const content = readFileSync(tabsJsPath, 'utf-8');

    // Find all iframe string templates (in JS)
    const iframeRegex = /<iframe[^>]*>/g;
    const iframes = content.match(iframeRegex) || [];

    expect(iframes.length).toBeGreaterThan(0);

    // Each iframe should have clipboard permissions
    iframes.forEach((iframe) => {
      expect(iframe).toMatch(/allow="[^"]*clipboard-read[^"]*"/);
      expect(iframe).toMatch(/allow="[^"]*clipboard-write[^"]*"/);
    });
  });
});

describe('React dashboard Terminal clipboard handling (Bugfix #203)', () => {
  // Resolve Terminal.tsx relative to the test file location to avoid
  // findProjectRoot path ambiguity (packages/codev/ dir matches 'codev').
  const terminalPath = resolve(__dirname, '../../../dashboard/src/components/Terminal.tsx');

  it('Terminal.tsx uses attachCustomKeyEventHandler for explicit clipboard handling', () => {
    const content = readFileSync(terminalPath, 'utf-8');

    // Must use attachCustomKeyEventHandler for clipboard operations
    expect(content).toContain('attachCustomKeyEventHandler');

    // Must use navigator.clipboard API for reading (paste)
    expect(content).toContain('navigator.clipboard.readText');

    // Must use navigator.clipboard API for writing (copy)
    expect(content).toContain('navigator.clipboard.writeText');

    // Must call term.paste() to write pasted text to terminal
    expect(content).toContain('term.paste(');

    // Must call term.getSelection() to read selected text for copy
    expect(content).toContain('term.getSelection()');

    // Must handle both Mac (metaKey) and non-Mac (ctrlKey+shiftKey) platforms
    expect(content).toContain('ev.metaKey');
    expect(content).toContain('ev.ctrlKey');
    expect(content).toContain('ev.shiftKey');
  });

  it('Terminal.tsx handles paste with Cmd+V (Mac) and Ctrl+Shift+V (other)', () => {
    const content = readFileSync(terminalPath, 'utf-8');

    // Paste detection for Mac: Cmd+V (metaKey + 'v')
    expect(content).toMatch(/ev\.metaKey && ev\.key === 'v'/);

    // Paste detection for non-Mac: Ctrl+Shift+V
    expect(content).toMatch(/ev\.ctrlKey && ev\.shiftKey && ev\.key === 'V'/);

    // Must prevent default to avoid double-paste from native handler
    expect(content).toContain('ev.preventDefault()');
  });

  it('Terminal.tsx handles copy with Cmd+C (Mac) and Ctrl+Shift+C (other)', () => {
    const content = readFileSync(terminalPath, 'utf-8');

    // Copy detection for Mac: Cmd+C (metaKey + 'c')
    expect(content).toMatch(/ev\.metaKey && ev\.key === 'c'/);

    // Copy detection for non-Mac: Ctrl+Shift+C
    expect(content).toMatch(/ev\.ctrlKey && ev\.shiftKey && ev\.key === 'C'/);

    // Must check for selection before copying
    expect(content).toContain('term.hasSelection()');
  });
});
