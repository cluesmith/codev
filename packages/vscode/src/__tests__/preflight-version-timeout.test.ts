/**
 * Unit tests for the #1024 probe-timeout behavior. `runCodevVersion` lives in
 * `preflight-core.ts` (vscode-free), so this runs under vitest with no vscode
 * mock. It spawns a real process; we drive it with tiny temp scripts (a fast one
 * that prints a version, a slow one that hangs) so the timeout path is exercised
 * deterministically without depending on `codev`.
 *
 * The setting → timeout plumbing in `preflight.ts` is just an idiomatic
 * `getConfiguration('codev').get<number>(key, DEFAULT_VERSION_TIMEOUT_MS)` read
 * (VSCode supplies the package.json default when unset, and enforces the
 * contributed min/max in its settings UI), so it isn't unit-tested here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VERSION_TIMEOUT_MS,
  runCodevVersion,
} from '../preflight/preflight-core.js';

describe('runCodevVersion', () => {
  let dir: string;
  let fastBin: string;
  let slowBin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codev-preflight-'));
    // Ignores its args (so the hardcoded `--version` is irrelevant) and prints
    // a version immediately.
    fastBin = join(dir, 'fast.sh');
    writeFileSync(fastBin, '#!/bin/sh\necho 3.1.9\n');
    chmodSync(fastBin, 0o755);
    // Hangs well past any test timeout so the probe's own timer is what settles it.
    slowBin = join(dir, 'slow.sh');
    writeFileSync(slowBin, '#!/bin/sh\nsleep 30\n');
    chmodSync(slowBin, 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the default budget at 5000ms (regression guard against the old 400ms)', () => {
    expect(DEFAULT_VERSION_TIMEOUT_MS).toBe(5000);
  });

  it('resolves ok with stdout when the probe completes within budget', async () => {
    const result = await runCodevVersion(fastBin, null, 5000);
    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('3.1.9');
  });

  it('falls back to the default budget when no timeoutMs is passed', async () => {
    // Negative case (#1024 acceptance): with the setting unset, the glue passes
    // the default through; the probe must still succeed under it, not hang.
    const result = await runCodevVersion(fastBin, null);
    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('honours an explicit timeoutMs: kills a hung probe and reports timedOut', async () => {
    // Positive case (#1024 acceptance): a binary that never returns is killed at
    // the supplied budget, not left to hang. A generous budget would let `sleep
    // 30` outlast the test, so the small explicit value is what makes this pass.
    const start = Date.now();
    const result = await runCodevVersion(slowBin, null, 150);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it('reports ok=false (not timedOut) when the binary cannot be spawned', async () => {
    const result = await runCodevVersion(join(dir, 'does-not-exist'), null, 1000);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
  });
});
