import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The property inspectors must load sdpi-components from the vendored copy in
 * the .sdPlugin bundle, never from the remote CDN (issue #1388): Elgato's
 * guidance for distributed plugins is to bundle the library, a CDN load breaks
 * action configuration offline, and it executes remotely mutable code in the
 * configuration UI. These pins fail loudly if a new PI page reintroduces a
 * remote script or the vendored file goes missing.
 */
describe('vendored sdpi-components in property inspectors', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const uiDir = join(root, 'com.cluesmith.codev.sdPlugin', 'ui');
  const vendored = join(uiDir, 'lib', 'sdpi-components.js');
  const htmlFiles = readdirSync(uiDir).filter((f) => f.endsWith('.html'));

  it('ships the vendored library in the bundle', () => {
    expect(existsSync(vendored)).toBe(true);
  });

  it('covers every property-inspector page', () => {
    expect(htmlFiles.length).toBeGreaterThan(0);
  });

  for (const file of htmlFiles) {
    describe(file, () => {
      const html = readFileSync(join(uiDir, file), 'utf-8');

      it('loads sdpi-components via the relative vendored path', () => {
        expect(html).toContain('<script src="lib/sdpi-components.js"></script>');
      });

      it('loads nothing from a remote origin', () => {
        expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
      });
    });
  }

  it('README documents the vendored version, matching the license header', () => {
    const header = readFileSync(vendored, 'utf-8').slice(0, 500);
    const versionMatch = header.match(/sdpi-components v(\d+\.\d+\.\d+)/);
    expect(versionMatch).not.toBeNull();
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    expect(readme).toContain(`v${versionMatch![1]}`);
  });
});
