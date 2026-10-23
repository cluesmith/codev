#!/usr/bin/env node
/**
 * Spec 1658, Phase 10 grep check: no unannotated `/tmp` in runtime code or in
 * tests that run on Windows. Not shipped; run from the repo root:
 *
 *   node scripts/spec-1658-tmp-residue-check.mjs
 *
 * Runtime (non-test .ts under packages/{codev,core,sdk}/src and apps/vscode/src):
 *   a `/tmp` on a comment line is prose; any other `/tmp` needs a comment
 *   naming POSIX on its own line or within the six lines above it (the site
 *   sits on a POSIX-only branch or list).
 *
 * Tests (files under __tests__/ or named *.test.ts): a file containing
 * `/tmp` carries a `spec-1658-tmp:` comment saying which case it is:
 *   - `spec-1658-tmp: opaque` — every `/tmp` is a path string that never
 *     reaches the disk (mocked fs, fake rows, argv assertions);
 *   - `spec-1658-tmp: posix-only` — the file (or every test using `/tmp`)
 *     is skipped on win32, with the reason next to the skip;
 *   - `spec-1658-tmp: sun_path` — `/tmp` is used deliberately on POSIX to
 *     keep Unix-socket paths under the 104-byte macOS limit, and the Windows
 *     branch uses os.tmpdir().
 *
 * Exits non-zero listing each unannotated site.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['packages/codev/src', 'packages/core/src', 'packages/sdk/src', 'apps/vscode/src'];
const TMP = /(['"`]\/tmp\b|\/tmp\/|\/private\/tmp)/;
const TEST_MARKER = /spec-1658-tmp: (opaque|posix-only|sun_path)\b/;

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
const summary = { runtimeSites: 0, testFiles: { opaque: 0, 'posix-only': 0, sun_path: 0 } };

for (const root of ROOTS) {
  for (const file of walk(path.join(repoRoot, root), [])) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    if (!TMP.test(text)) continue;
    if (isTestFile(rel)) {
      const marker = TEST_MARKER.exec(text);
      if (marker === null) {
        problems.push(`${rel}: test file uses /tmp without a spec-1658-tmp: annotation`);
      } else {
        summary.testFiles[marker[1]] += 1;
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

console.log(JSON.stringify(summary));
if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`${problems.length} unannotated /tmp site(s)`);
  process.exit(1);
}
console.log('OK: every /tmp is annotated');
