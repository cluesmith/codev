/**
 * Manifest guard for the Tower container's placement (#1566, pairs with #1763).
 *
 * `contributes.viewsContainers.secondarySidebar` is only a stable contribution point from VS Code
 * 1.106 onward. The container lives there, so the extension must never ship with an engine floor
 * below 1.106 — otherwise the container silently vanishes (or, worse, shifts other extensions' views)
 * on an older VS Code. And `@types/vscode` must not claim a version above the engine floor, or we'd
 * type-check against APIs we don't actually require at runtime (the npm registry also has gaps — not
 * every VS Code minor has a matching `@types/vscode`, so the two track loosely but the floor bounds it).
 *
 * package.json reads only; pattern mirrors prepublish-workspace-deps.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));

/** Parse a semver range's floor ("^1.128.0", "~1.125.0", ">=1.106.0") to [major, minor, patch]. */
function floor(range: string): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) { throw new Error(`unparseable version range: ${range}`); }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1 comparing two [major, minor, patch] tuples. */
function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) { return a[i] < b[i] ? -1 : 1; }
  }
  return 0;
}

describe('Tower container engine/types guard (#1566, #1763)', () => {
  const engineFloor = floor(PKG.engines.vscode);
  const typesVersion = floor((PKG.devDependencies ?? {})['@types/vscode']);
  const usesSecondarySidebar = Boolean(PKG.contributes?.viewsContainers?.secondarySidebar);

  it('declares the Tower container in the secondary side bar (precondition for this guard)', () => {
    // If this ever flips to false the guard below no-ops by design; assert it here so a silent move
    // back to the activity bar is visible rather than quietly disarming the floor check.
    expect(usesSecondarySidebar).toBe(true);
  });

  it('keeps engines.vscode >= 1.106.0 whenever secondarySidebar is contributed', () => {
    if (!usesSecondarySidebar) { return; }
    expect(cmp(engineFloor, [1, 106, 0]), `engines.vscode ${PKG.engines.vscode} is below 1.106.0`).toBeGreaterThanOrEqual(0);
  });

  it('keeps @types/vscode at or below the engine floor', () => {
    expect(cmp(typesVersion, engineFloor), `@types/vscode ${PKG.devDependencies['@types/vscode']} exceeds engines.vscode ${PKG.engines.vscode}`).toBeLessThanOrEqual(0);
  });
});
