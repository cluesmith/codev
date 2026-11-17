#!/usr/bin/env node
/**
 * Native-dependency install guard check (Spec 1658, Phase 10). Not shipped:
 * run by the on-demand `windows.yml` workflow (`install-guard` job) on a
 * real Windows host, against tarballs packed from the branch.
 *
 * The compiler is made unreachable by a `node-gyp` stub that records each
 * call and fails. npm does not forward its `node-gyp` config (CLI flag or
 * `npm_config_node_gyp`) to dependency install scripts: @npmcli/run-script
 * falls back to the bundled node-gyp. What it does honour is PATH order: a
 * script's PATH lists `node_modules/.bin` of every ancestor directory before
 * npm's own node-gyp shim. So the stub is placed in `<root>/node_modules/.bin`,
 * and the control project and the install prefix both live under `<root>`.
 *
 * Usage (from the repo root, with the four packed tarballs in <dir>):
 *   node scripts/windows-install-guard-check.mjs --control <dir>
 *       better-sqlite3 alone, with no guard in front of it: the stub MUST be
 *       invoked on this Node (proves the stub intercepts the fallback).
 *   node scripts/windows-install-guard-check.mjs --unsupported <dir>
 *       global install of the branch packages: MUST fail with the
 *       supported-versions message and MUST NOT invoke the stub.
 *   node scripts/windows-install-guard-check.mjs --supported <dir>
 *       global install of the branch packages: MUST succeed without invoking
 *       the stub, and `codev --version` MUST run.
 *
 * Exits non-zero, with the reason, when the expectation does not hold.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, packDir] = process.argv.slice(2);
const SUPPORTED_MESSAGE = 'native Windows needs Node.js 22 or 24';

function fail(reason, output) {
  console.error(`FAIL (${mode}, Node ${process.version}): ${reason}`);
  if (output) {
    console.error('--- npm output ---');
    console.error(output);
  }
  process.exit(1);
}

/**
 * A node-gyp stand-in that records each call in `marker` and fails, reachable
 * as `node-gyp` from every script run under `root`: a POSIX-shell shim for npm's
 * Git Bash script shell and a .cmd shim for cmd.exe.
 */
function makeStub() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codev-gyp-'));
  const binDir = path.join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const marker = path.join(root, 'invoked.log');
  const stub = path.join(root, 'node-gyp-stub.cjs');
  writeFileSync(stub, [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n');`,
    "console.error('node-gyp stub: the compiler is unreachable in this check');",
    'process.exit(1);',
    '',
  ].join('\n'));
  const stubForShell = stub.split(path.sep).join('/');
  writeFileSync(path.join(binDir, 'node-gyp'), `#!/usr/bin/env sh\nnode "${stubForShell}" "$@"\n`);
  writeFileSync(path.join(binDir, 'node-gyp.cmd'), `@node "${stub}" %*\r\n`);
  return { root, marker };
}

function npm(args, env, cwd) {
  const result = spawnSync('npm', args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout: 15 * 60 * 1000,
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function tarballs() {
  const names = ['codev-types', 'codev-core', 'codev-sdk', 'codev'];
  const files = readdirSync(packDir);
  return names.map((name) => {
    const file = files.find((f) => new RegExp(`^cluesmith-${name}-\\d.*\\.tgz$`).test(f));
    if (!file) fail(`no packed tarball for @cluesmith/${name} in ${packDir}`);
    return path.join(packDir, file);
  });
}

function quote(value) {
  return `"${value}"`;
}

const { root, marker } = makeStub();
const env = { ...process.env };
delete env.npm_config_prefix;

if (mode === '--control') {
  const project = path.join(root, 'control');
  mkdirSync(project);
  writeFileSync(path.join(project, 'package.json'), '{"name":"control","version":"1.0.0","private":true}\n');
  const range = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'codev', 'package.json'), 'utf8')).dependencies['better-sqlite3'];
  const { code, output } = npm(['install', quote(`better-sqlite3@${range}`), '--no-audit', '--no-fund'], env, project);
  if (!existsSync(marker)) {
    fail(`better-sqlite3 installed (exit ${code}) without reaching node-gyp: this Node has a prebuild, so the control proves nothing here`, output);
  }
  console.log(`OK control: the source-build fallback reached the stub (${readFileSync(marker, 'utf8').trim()}); npm exit ${code}`);
} else if (mode === '--unsupported' || mode === '--supported') {
  const prefix = path.join(root, 'prefix');
  mkdirSync(prefix);
  const { code, output } = npm(['install', '-g', '--prefix', quote(prefix), '--no-audit', '--no-fund', ...tarballs().map(quote)], env, root);
  const invoked = existsSync(marker);
  if (mode === '--unsupported') {
    if (code === 0) fail('the install succeeded on an unsupported Node', output);
    if (invoked) fail(`node-gyp was invoked (${readFileSync(marker, 'utf8').trim()})`, output);
    if (!output.includes(SUPPORTED_MESSAGE)) fail('the failure does not carry the supported-versions message', output);
    console.log(`OK unsupported: npm exit ${code}, supported-versions message shown, node-gyp never invoked`);
  } else {
    if (code !== 0) fail(`the install failed (exit ${code})`, output);
    if (invoked) fail(`node-gyp was invoked (${readFileSync(marker, 'utf8').trim()})`, output);
    const expected = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'codev', 'package.json'), 'utf8')).version;
    const version = spawnSync(quote(path.join(prefix, 'codev.cmd')), ['--version'], { encoding: 'utf8', shell: true, windowsHide: true });
    const versionOutput = `stdout: ${JSON.stringify(version.stdout)}\nstderr: ${JSON.stringify(version.stderr)}`;
    if (version.status !== 0) fail(`codev --version failed (exit ${version.status})`, versionOutput);
    if (!version.stdout.includes(expected)) fail(`codev --version did not print ${expected}`, versionOutput);
    console.log(`OK supported: installed without node-gyp; codev --version = ${version.stdout.trim()}`);
  }
} else {
  fail('usage: --control|--unsupported|--supported <pack dir>');
}
