#!/usr/bin/env node

/**
 * Post-release install verification script.
 *
 * Installs the package from a tarball or npm registry, then verifies
 * all CLI binaries exist and respond to --help.
 *
 * Usage:
 *   node scripts/verify-install.mjs <tarball-or-package>
 *
 * Examples:
 *   node scripts/verify-install.mjs ./cluesmith-codev-2.0.0.tgz
 *   node scripts/verify-install.mjs @cluesmith/codev@2.0.0
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/verify-install.mjs <tarball-or-package>');
  process.exit(1);
}

const prefix = mkdtempSync(join(tmpdir(), 'codev-install-verify-'));
let failed = false;

try {
  console.log(`Installing ${target} into ${prefix}...`);
  execSync(`npm install -g --prefix "${prefix}" "${target}"`, { stdio: 'inherit' });

  const bins = ['codev', 'af', 'porch', 'consult'];
  for (const bin of bins) {
    try {
      execSync(`"${join(prefix, 'bin', bin)}" --help`, { stdio: 'pipe' });
      console.log(`  OK: ${bin} --help`);
    } catch (err) {
      console.error(`  FAIL: ${bin} --help (exit code ${err.status})`);
      failed = true;
    }
  }

  if (failed) {
    console.error('\nInstall verification FAILED.');
    process.exit(1);
  }

  console.log('\nInstall verification passed.');
} finally {
  rmSync(prefix, { recursive: true, force: true });
}
