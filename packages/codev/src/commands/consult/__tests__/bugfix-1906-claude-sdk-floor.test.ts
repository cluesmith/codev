/**
 * #1906 — the claude lane got API 400 on claude-opus-5 in builds from this repo's lockfile.
 *
 * `@anthropic-ai/claude-agent-sdk` was declared `^0.2.41` and `pnpm-lock.yaml` resolved 0.2.105.
 * The Claude Code CLI bundled with 0.2.105 decides whether a model takes adaptive thinking from a
 * name allowlist (`opus-4-6`, `sonnet-4-6`); any other Opus is sent `thinking: {type: "enabled"}`,
 * which claude-opus-5 rejects ("thinking.type.enabled is not supported for this model"). A fresh
 * `npm i -g` resolved 0.2.141 and worked, so the released consult and the repo build disagreed.
 * Consult sets no thinking option itself, and could not fix this by setting one: the old CLI
 * rewrites adaptive to enabled for a model it does not recognise.
 *
 * Pinned here, CI-safe (no network, no API calls):
 *  - the SDK consult actually imports is at least the oldest version observed serving
 *    claude-opus-5 — this is what the lockfile installs;
 *  - the range `packages/codev/package.json` declares cannot resolve anything older — this is
 *    what a published install, or an adopter's own lockfile, resolves.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLAUDE_MODEL } from '../index.js';

const SDK = '@anthropic-ai/claude-agent-sdk';

/**
 * Live-probed on an API key (#1906): 0.2.105 got the 400, 0.2.141 served claude-opus-5. 0.2.141 is
 * the newest 0.2.x and what a fresh install of codev already resolved, so it is the floor; the
 * versions in between were not probed.
 */
const OLDEST_SDK_SERVING_CLAUDE_OPUS_5 = '0.2.141';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Version of the SDK that `import ... from '@anthropic-ai/claude-agent-sdk'` resolves to here. */
function installedSdkVersion(): string {
  // Walk the lookup paths rather than `require.resolve(`${SDK}/package.json`)`: the SDK's
  // `exports` map does not expose package.json, so that throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  for (const dir of createRequire(import.meta.url).resolve.paths(SDK) ?? []) {
    const packageJson = join(dir, SDK, 'package.json');
    if (existsSync(packageJson)) return JSON.parse(readFileSync(packageJson, 'utf-8')).version;
  }
  throw new Error(`Cannot locate ${SDK} from ${fileURLToPath(import.meta.url)}`);
}

/** The lowest version the declared range admits; only plain `^x.y.z` / `~x.y.z` are accepted. */
function declaredFloor(): string {
  const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'package.json');
  const spec: string = JSON.parse(readFileSync(manifest, 'utf-8')).dependencies[SDK];
  const match = /^[\^~](\d+\.\d+\.\d+)$/.exec(spec);
  if (!match) throw new Error(`Unexpected ${SDK} range "${spec}" in ${manifest}; update this test`);
  return match[1];
}

describe('claude lane Agent SDK floor (#1906)', () => {
  it('guards the shipped claude lane default', () => {
    // The floor below was probed against this model. A new default needs a fresh probe.
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5');
  });

  it('installs an Agent SDK new enough to serve claude-opus-5', () => {
    expect(compareVersions(installedSdkVersion(), OLDEST_SDK_SERVING_CLAUDE_OPUS_5)).toBeGreaterThanOrEqual(0);
  });

  it('declares a range that cannot resolve an older Agent SDK', () => {
    expect(compareVersions(declaredFloor(), OLDEST_SDK_SERVING_CLAUDE_OPUS_5)).toBeGreaterThanOrEqual(0);
  });
});
