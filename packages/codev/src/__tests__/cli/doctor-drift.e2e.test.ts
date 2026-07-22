/**
 * CLI Integration: `codev doctor` Framework Drift section (#1210).
 *
 * Runs the built CLI against a fixture project whose `codev/` shadows the installed
 * skeleton, asserting the drift report surfaces (or stays silent) as designed.
 * Runs against dist/ (built artifact) — the skeleton is read from the built package.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setupCliEnv, teardownCliEnv, CliEnv, runCodev } from './helpers.js';
import { getSkeletonDir, listSkeletonFiles } from '../../lib/skeleton.js';

/** A real skeleton `.md` framework file to base fixtures on. */
function pickSkeletonMd(): string {
  for (const sub of ['protocols', 'consult-types', 'roles']) {
    const files = listSkeletonFiles(sub).filter((f) => f.endsWith('.md'));
    if (files.length) return files[0];
  }
  throw new Error('no skeleton framework .md files found — build the skeleton first');
}

/** Copy a skeleton file into the fixture's tier-2 `codev/`, optionally mutated. */
function seedLocalCopy(root: string, rel: string, mutate: boolean): void {
  const src = path.join(getSkeletonDir(), rel);
  const dest = path.join(root, 'codev', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const bytes = fs.readFileSync(src);
  fs.writeFileSync(dest, mutate ? Buffer.concat([bytes, Buffer.from('\nLOCAL DRIFT\n')]) : bytes);
}

describe('codev doctor — Framework Drift (CLI)', () => {
  let env: CliEnv;
  let rel: string;

  beforeEach(() => {
    env = setupCliEnv();
    // Point npm at an unreachable registry so the staleness check deterministically
    // resolves to "could not check" (latest=null → not behind), instead of hitting the
    // live registry. This keeps the "no overrides → no section" assertion stable (a real
    // `latest` newer than the built version would otherwise open the section on staleness
    // alone) and removes network flakiness. Drift detection itself is offline (local vs
    // installed skeleton), so the shadow assertions are unaffected.
    env.env = {
      ...env.env,
      npm_config_registry: 'http://127.0.0.1:1',
      npm_config_fetch_retries: '0',
    };
    rel = pickSkeletonMd();
    // Make the fixture a recognizable codev project so doctor runs its project checks.
    fs.mkdirSync(path.join(env.dir, 'codev'), { recursive: true });
  });

  afterEach(() => {
    teardownCliEnv(env);
  });

  it('flags a differing local shadow for adjudication, naming the skeleton version', () => {
    seedLocalCopy(env.dir, rel, /* mutate */ true);
    const result = runCodev(['doctor'], env.dir, env.env);
    expect(result.stdout).toContain('Framework Drift');
    expect(result.stdout).toContain('customized or stale? — adjudicate');
    // The differ line names the skeleton package version (vN.N.N).
    expect(result.stdout).toMatch(/differs from installed skeleton v\d+\.\d+\.\d+/);
  });

  it('reports a byte-identical local shadow as a safe-to-remove redundant copy', () => {
    seedLocalCopy(env.dir, rel, /* mutate */ false);
    const result = runCodev(['doctor'], env.dir, env.env);
    expect(result.stdout).toContain('Framework Drift');
    expect(result.stdout).toContain('safe to remove');
  });

  it('prints no Framework Drift section when there are no local overrides', () => {
    // codev/ exists but holds no framework files → no shadows. Skeleton is the installed
    // package (not behind itself), so the section must be a true no-op.
    const result = runCodev(['doctor'], env.dir, env.env);
    expect(result.stdout).not.toContain('Framework Drift');
  });
});
