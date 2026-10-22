#!/usr/bin/env node

/**
 * Post-release install verification script.
 *
 * Installs the package from a tarball or npm registry, then verifies
 * all CLI binaries exist and respond to --help, and that the embedded
 * sidebar vsix ships with its manifest (Spec 1789).
 *
 * Usage:
 *   node scripts/verify-install.mjs <tarball-or-package> [...extra-tarballs]
 *
 * Examples:
 *   node scripts/verify-install.mjs ./cluesmith-codev-2.0.0.tgz ../core/cluesmith-codev-core-0.0.1.tgz
 *   node scripts/verify-install.mjs @cluesmith/codev@2.0.0
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDE_EXTENSION_DIR, IDE_EXTENSION_MANIFEST, IDE_EXTENSION_VSIX } from './ide-extension-manifest.mjs';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: node scripts/verify-install.mjs <tarball-or-package> [...extra-tarballs]');
  process.exit(1);
}
const prefix = mkdtempSync(join(tmpdir(), 'codev-install-verify-'));
let failed = false;

try {
  const quoted = targets.map(t => `"${t}"`).join(' ');
  console.log(`Installing ${targets.join(', ')} into ${prefix}...`);
  execSync(`npm install -g --prefix "${prefix}" ${quoted}`, { stdio: 'inherit' });

  const bins = ['codev', 'afx', 'porch', 'consult'];
  for (const bin of bins) {
    try {
      execSync(`"${join(prefix, 'bin', bin)}" --help`, { stdio: 'pipe' });
      console.log(`  OK: ${bin} --help`);
    } catch (err) {
      console.error(`  FAIL: ${bin} --help (exit code ${err.status})`);
      failed = true;
    }
  }

  const globalRoot = execSync(`npm root -g --prefix "${prefix}"`, { encoding: 'utf8' }).trim();
  const ideExtensionDir = join(globalRoot, '@cluesmith', 'codev', IDE_EXTENSION_DIR);
  const vsixPath = join(ideExtensionDir, IDE_EXTENSION_VSIX);
  if (existsSync(vsixPath)) {
    console.log(`  OK: ${IDE_EXTENSION_DIR}/${IDE_EXTENSION_VSIX} present`);
  } else {
    console.error(`  FAIL: embedded sidebar vsix missing at ${vsixPath}`);
    failed = true;
  }
  try {
    const manifest = JSON.parse(readFileSync(join(ideExtensionDir, IDE_EXTENSION_MANIFEST), 'utf8'));
    if (manifest.id === 'cluesmith.codev-vscode' && typeof manifest.version === 'string') {
      console.log(`  OK: ide-extension/manifest.json ${manifest.id}@${manifest.version}`);
    } else {
      console.error(`  FAIL: ide-extension/manifest.json is malformed (${JSON.stringify(manifest)})`);
      failed = true;
    }
  } catch (err) {
    console.error(`  FAIL: cannot read ide-extension/manifest.json (${err.message})`);
    failed = true;
  }

  if (failed) {
    console.error('\nInstall verification FAILED.');
    process.exit(1);
  }

  console.log('\nInstall verification passed.');
} finally {
  rmSync(prefix, { recursive: true, force: true });
}
