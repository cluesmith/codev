import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The plugin's design rationale must live in-tree, not depend on the
 * pre-migration repository's planning document (issue #1390). That repository is
 * slated for retirement after the sdk's first npm publish, so a README that
 * defers "why the plugin is shaped this way" to a `PLAN.md` over there is a live
 * documentation dependency on a soon-archived source. These pins fail loudly if
 * the Design section is dropped or the external design-doc pointer creeps back.
 */
describe('streamdeck README carries its own design rationale', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const readme = readFileSync(join(root, 'README.md'), 'utf-8');

  it('has an in-tree Design section', () => {
    expect(readme).toMatch(/^## Design$/m);
  });

  it('does not defer design to the pre-migration planning document', () => {
    expect(readme).not.toContain('PLAN.md');
  });

  it('does not name the pre-migration repository in committed prose', () => {
    expect(readme).not.toContain('codev-integrations');
  });

  it('keeps provenance in the History section', () => {
    expect(readme).toMatch(/^## History$/m);
    expect(readme).toContain('pre-migration repository');
  });
});
