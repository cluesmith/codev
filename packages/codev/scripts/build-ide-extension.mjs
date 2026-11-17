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

/**
 * How to run pnpm. On native Windows `pnpm` is a `.cmd` shim that spawn cannot
 * run without a shell (ENOENT), so when this script runs under pnpm its own JS
 * entry (`npm_execpath`) runs under the current Node instead (Spec 1658).
 * Everywhere else, `pnpm` as before.
 */
function pnpmCommand(args) {
  const entry = process.env.npm_execpath;
  if (process.platform === 'win32' && entry && /\.[cm]?js$/i.test(entry)) {
    return { command: process.execPath, args: [entry, ...args] };
  }
  return { command: 'pnpm', args };
}

const pnpm = pnpmCommand(['--filter', 'codev-vscode', 'exec', 'vsce', 'package', '--no-dependencies', '--out', vsixPath]);
const result = spawnSync(pnpm.command, pnpm.args, { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
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
