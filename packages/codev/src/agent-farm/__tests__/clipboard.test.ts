/**
 * Tests for clipboard functionality in dashboard terminals
 * Ensures iframes have clipboard permissions and ttyd has rightClickSelectsWord
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

describe('ttyd rightClickSelectsWord option', () => {
  const sourceFiles = [
    'packages/codev/src/agent-farm/commands/start.ts',
    'packages/codev/src/agent-farm/commands/util.ts',
    'packages/codev/src/agent-farm/commands/spawn.ts',
    'packages/codev/src/agent-farm/servers/dashboard-server.ts',
  ];

  sourceFiles.forEach((filePath) => {
    it(`${filePath} includes rightClickSelectsWord in ttyd args`, () => {
      const fullPath = resolve(projectRoot, filePath);

      if (!existsSync(fullPath)) {
        return;
      }

      const content = readFileSync(fullPath, 'utf-8');

      // Check if file spawns ttyd (has ttydArgs)
      if (content.includes('ttydArgs')) {
        expect(content).toMatch(/rightClickSelectsWord['"=]?.*true/);
      }
    });
  });

  it('spawn.ts has rightClickSelectsWord in all ttyd spawn locations', () => {
    const spawnPath = resolve(projectRoot, 'packages/codev/src/agent-farm/commands/spawn.ts');

    if (!existsSync(spawnPath)) {
      return;
    }

    const content = readFileSync(spawnPath, 'utf-8');

    // Count ttydArgs definitions
    const ttydArgsCount = (content.match(/const ttydArgs = \[/g) || []).length;

    // Count rightClickSelectsWord occurrences
    const rightClickCount = (content.match(/rightClickSelectsWord/g) || []).length;

    // Each ttydArgs should have rightClickSelectsWord
    expect(rightClickCount).toBeGreaterThanOrEqual(ttydArgsCount);
  });
});
