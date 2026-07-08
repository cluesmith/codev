/**
 * Regression for issue #1154: `vscode:prepublish` must build every
 * `workspace:*` dependency before type-checking and bundling. The script
 * once listed `--filter` targets by hand and missed
 * `@cluesmith/codev-artifact-canvas`, so a fresh clone failed check-types
 * with TS2307 on the markdown-preview webview's imports.
 *
 * The topological form (`--filter 'codev-vscode^...'`) selects all
 * workspace deps transitively and passes trivially. If the script ever
 * reverts to an explicit `--filter` list, this asserts the list covers
 * every `workspace:*` dep so a newly added dep cannot silently regress.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);

const workspaceDeps = Object.entries({
  ...(PKG.dependencies ?? {}),
  ...(PKG.devDependencies ?? {}),
})
  .filter(([, version]) => String(version).startsWith('workspace:'))
  .map(([name]) => name);

describe('vscode:prepublish workspace dep coverage (issue #1154)', () => {
  const script: string = PKG.scripts['vscode:prepublish'];

  it('has workspace:* deps to guard (sanity)', () => {
    expect(workspaceDeps.length).toBeGreaterThan(0);
  });

  it('builds every workspace:* dependency before packaging', () => {
    if (/--filter\s+['"]?codev-vscode\^\.\.\.['"]?/.test(script)) {
      // Topological form: pnpm builds all workspace deps transitively.
      return;
    }
    const filters = [...script.matchAll(/--filter\s+['"]?([^\s'"]+)['"]?/g)].map(
      (m) => m[1],
    );
    for (const dep of workspaceDeps) {
      expect(filters, `prepublish must build ${dep}`).toContain(dep);
    }
  });
});
