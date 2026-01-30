/**
 * Tests for clipboard functionality in dashboard terminals
 * Ensures iframes have clipboard permissions
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
