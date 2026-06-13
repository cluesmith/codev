/**
 * Build-smoke check (spec test scenario 7): after `pnpm build`, verify the dual-format output
 * actually loads — the CJS entry via require() and the ESM entry via import(). Run with:
 *   node scripts/smoke.mjs
 * (intended to run after `pnpm build`, e.g. as a CI step).
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const fail = (msg) => { console.error('build-smoke FAIL:', msg); process.exit(1); };

for (const f of ['dist/index.cjs', 'dist/index.js', 'dist/index.d.ts', 'dist/default-theme.css']) {
  if (!existsSync(f)) fail(`missing build artifact: ${f}`);
}

// CJS require()
const cjs = require('../dist/index.cjs');
if (typeof cjs.ArtifactCanvas !== 'function') fail('CJS entry missing ArtifactCanvas export');

// ESM import()
const esm = await import('../dist/index.js');
if (typeof esm.ArtifactCanvas !== 'function') fail('ESM entry missing ArtifactCanvas export');

console.log('build-smoke OK: CJS + ESM entries load; ArtifactCanvas exported; dist assets present.');
