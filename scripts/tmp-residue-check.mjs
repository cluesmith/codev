#!/usr/bin/env node
/**
 * `/tmp` residue check (Spec 1658): `/tmp` does not exist on native Windows,
 * so every `/tmp` in code that runs there must be explained. Runs in CI
 * (test.yml, unit job); run locally from the repo root:
 *
 *   node scripts/tmp-residue-check.mjs
 *
 * Runtime (non-test .ts under packages/{codev,core,sdk}/src and apps/vscode/src):
 *   a `/tmp` on a comment line is prose; any other `/tmp` needs a comment
 *   naming POSIX on its own line or within the six lines above it (the site
 *   sits on a POSIX-only branch or list).
 *
 * Tests (files under __tests__/ or named *.test.ts): a file containing `/tmp`
 * must be listed in scripts/tmp-residue-allowlist.json with its reason:
 *   - `opaque`: every `/tmp` is a path string that never reaches the disk
 *     (mocked fs, fake rows, argv assertions);
 *   - `posix-only`: the tests using `/tmp` are skipped on win32;
 *   - `sun_path`: `/tmp` is used on POSIX to keep Unix-socket paths under the
 *     104-byte macOS limit, and Windows uses os.tmpdir().
 * A listed file that no longer contains `/tmp` is a stale entry and fails too.
 *
 * Exits non-zero listing each problem.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['packages/codev/src', 'packages/core/src', 'packages/sdk/src', 'apps/vscode/src'];
const TMP = /(['"`]\/tmp\b|\/tmp\/|\/private\/tmp)/;
const ALLOWLIST = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/tmp-residue-allowlist.json'), 'utf8')).files;
const REASONS = new Set(['opaque', 'posix-only', 'sun_path']);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|mts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(rel) {
  return rel.includes('__tests__') || /\.test\.(ts|mts|tsx)$/.test(rel);
}

function isCommentLine(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

const problems = [];
const seen = new Set();
const summary = { runtimeSites: 0, testFiles: { opaque: 0, 'posix-only': 0, sun_path: 0 } };

for (const root of ROOTS) {
  for (const file of walk(path.join(repoRoot, root), [])) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    if (!TMP.test(text)) continue;
    if (isTestFile(rel)) {
      seen.add(rel);
      const entry = ALLOWLIST[rel];
      if (entry === undefined) {
        problems.push(`${rel}: test file uses /tmp but is not in scripts/tmp-residue-allowlist.json`);
      } else if (!REASONS.has(entry.reason)) {
        problems.push(`${rel}: allowlist reason must be opaque, posix-only or sun_path, got ${JSON.stringify(entry.reason)}`);
      } else {
        summary.testFiles[entry.reason] += 1;
      }
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!TMP.test(line) || isCommentLine(line)) return;
      summary.runtimeSites += 1;
      const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      if (!/POSIX/.test(window)) {
        problems.push(`${rel}:${i + 1}: runtime /tmp without a POSIX annotation: ${line.trim()}`);
      }
    });
  }
}

for (const rel of Object.keys(ALLOWLIST)) {
  if (!seen.has(rel)) {
    problems.push(`${rel}: listed in scripts/tmp-residue-allowlist.json but no longer contains /tmp (remove the entry)`);
  }
}

console.log(JSON.stringify(summary));
if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`${problems.length} problem(s) with /tmp`);
  process.exit(1);
}
console.log('OK: every /tmp is annotated');
