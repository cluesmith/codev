/**
 * Regression test for bugfix #693: forge scripts ship without executable bit.
 *
 * pnpm pack/publish strips executable bits from files outside the `bin` field.
 * The package.json postinstall hook restores them. This test guards:
 *
 *   1. package.json still wires postinstall → scripts/postinstall.mjs
 *      and ships the script in the `files` array.
 *   2. postinstall.mjs actually chmods every forge script it finds.
 *   3. Every forge script tracked in the repo lives where postinstall
 *      expects it (scripts/forge/<provider>/<name>.sh), so nothing is
 *      silently missed when a new script is added.
 */

import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const codevPkgRoot = resolve(__dirname, '..', '..');
const realPostinstall = join(codevPkgRoot, 'scripts', 'postinstall.mjs');

describe('bugfix #693: forge scripts retain +x after install', () => {
  it('package.json wires postinstall to scripts/postinstall.mjs and ships the file', () => {
    const pkg = JSON.parse(readFileSync(join(codevPkgRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.postinstall).toContain('scripts/postinstall.mjs');
    expect(pkg.files).toContain('scripts/postinstall.mjs');
    expect(pkg.files).toContain('scripts/forge');
  });

  it('postinstall.mjs makes every forge script executable', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codev-693-'));
    try {
      const providers = ['github', 'gitlab', 'gitea'];
      const scriptNames = ['issue-view.sh', 'pr-merge.sh', 'auth-status.sh'];
      const forgeRoot = join(fixture, 'scripts', 'forge');

      for (const provider of providers) {
        mkdirSync(join(forgeRoot, provider), { recursive: true });
        for (const name of scriptNames) {
          const path = join(forgeRoot, provider, name);
          writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
          chmodSync(path, 0o644);
          expect(statSync(path).mode & 0o111).toBe(0);
        }
      }

      copyFileSync(realPostinstall, join(fixture, 'scripts', 'postinstall.mjs'));
      execFileSync('node', ['./scripts/postinstall.mjs'], { cwd: fixture });

      for (const provider of providers) {
        for (const name of scriptNames) {
          const mode = statSync(join(forgeRoot, provider, name)).mode & 0o777;
          expect(mode).toBe(0o755);
        }
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('every committed forge script sits at scripts/forge/<provider>/<name>.sh', () => {
    const forgeRoot = join(codevPkgRoot, 'scripts', 'forge');
    const providers = readdirSync(forgeRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(providers.length).toBeGreaterThan(0);

    for (const provider of providers) {
      const providerDir = join(forgeRoot, provider);
      const entries = readdirSync(providerDir, { withFileTypes: true });
      for (const entry of entries) {
        expect(
          entry.isFile() && entry.name.endsWith('.sh'),
          `unexpected entry ${provider}/${entry.name} — postinstall only chmods *.sh files one level deep`
        ).toBe(true);
      }
    }
  });
});
