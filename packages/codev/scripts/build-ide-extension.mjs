#!/usr/bin/env node

/**
 * Build step: package the sidebar extension (apps/vscode) as a vsix and embed
 * it in @cluesmith/codev under ide-extension/ (Spec 1789).
 *
 * Tower installs this vsix into its own extensions directory before spawning
 * the Codev IDE server, so the sidebar always matches the installed codev
 * version. The output is .gitignored and ships via the package's `files`
 * allowlist, like dashboard-dist/ and skeleton/.
 *
 * Uses the extension's declared @vscode/vsce (never a global `vsce`) with the
 * same command the release uses (`vsce package --no-dependencies`), which runs
 * the extension's vscode:prepublish (type-check, lint, production esbuild).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  IDE_EXTENSION_DIR,
  IDE_EXTENSION_MANIFEST,
  IDE_EXTENSION_VSIX,
  buildIdeExtensionManifest,
} from './ide-extension-manifest.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const extensionRoot = join(repoRoot, 'apps', 'vscode');
const outDir = join(packageRoot, IDE_EXTENSION_DIR);
const vsixPath = join(outDir, IDE_EXTENSION_VSIX);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = spawnSync(
  'pnpm',
  ['--filter', 'codev-vscode', 'exec', 'vsce', 'package', '--no-dependencies', '--out', vsixPath],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (result.error) {
  throw new Error(`build-ide-extension: failed to run vsce: ${result.error.message}`);
}
if (result.status !== 0) {
  throw new Error(`build-ide-extension: vsce package exited with status ${result.status}`);
}
if (!existsSync(vsixPath)) {
  throw new Error(`build-ide-extension: vsce reported success but ${vsixPath} is missing`);
}

const extensionPackageJson = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8'));
const manifest = buildIdeExtensionManifest(extensionPackageJson);
writeFileSync(join(outDir, IDE_EXTENSION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

const sizeKb = Math.round(statSync(vsixPath).size / 1024);
console.log(`build-ide-extension: embedded ${manifest.id}@${manifest.version} (${sizeKb} KB) in ${IDE_EXTENSION_DIR}/`);
