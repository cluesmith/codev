/**
 * Protocol prompt audit — regression guards for cluesmith/codev#777 and #784.
 *
 * This branch fixed three specific bug classes in the protocol .md files that
 * builder agents read and execute. Each `it()` block below grep-asserts that
 * the pattern is gone and stays gone. If a future protocol author re-introduces
 * one of these, the test fails with the offending file, line, and text.
 *
 * Not a correctness oracle — only catches the three bug classes named here.
 * New bug shapes will need their own assertions.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(files: string[], pattern: RegExp): Violation[] {
  const hits: Violation[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      if (pattern.test(line)) {
        hits.push({
          file: path.relative(repoRoot, file),
          line: idx + 1,
          text: line.trim(),
        });
      }
    });
  }
  return hits;
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return '';
  return (
    `\nFound ${violations.length} violation(s):\n` +
    violations.map(v => `  ${v.file}:${v.line}\n    ${v.text}`).join('\n')
  );
}

describe('protocol prompt audit (#777 / #784 regression guards)', () => {
  const protocolDirs = [
    path.join(repoRoot, 'codev-skeleton/protocols'),
    path.join(repoRoot, 'codev-skeleton/protocols'),
  ];
  const files = protocolDirs.flatMap(walkMarkdown);

  it('finds protocol .md files to audit', () => {
    // Sanity check — if this fails the regex tests below would silently pass.
    expect(files.length).toBeGreaterThan(0);
  });

  it('no `git diff "$DEFAULT_BRANCH"` (two-tree diff against the moving base tip — #784)', () => {
    // Matches `git diff [--stat] "$DEFAULT_BRANCH"` or `"${DEFAULT_BRANCH:-main}"`
    // when the variable is the *bare* argument — NOT wrapped in
    // `$(git merge-base ...)`. Single-arg `git diff <ref>` compares the moving
    // branch tip against the working tree, pulling in upstream churn the
    // builder didn't author. Use `$(git merge-base "$DEFAULT_BRANCH" HEAD)` or
    // a pre-resolved `$MERGE_BASE` variable instead.
    const bad = /git diff(\s+--stat)?\s+"\$(\{DEFAULT_BRANCH(:-[^}]*)?\}|DEFAULT_BRANCH)"/;
    const violations = findViolations(files, bad);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('no `|| echo main` shell-bug pattern (sed-swallows-pipeline-exit-code)', () => {
    // sed exits 0 on empty input, so when `git symbolic-ref` fails the
    // pipeline's exit status is sed's (0), and `|| echo main` never fires.
    // DEFAULT_BRANCH ends up empty rather than `main`. Use
    // `${DEFAULT_BRANCH:-main}` parameter expansion instead.
    const bad = /\|\|\s+echo\s+main/;
    const violations = findViolations(files, bad);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('no hardcoded `git diff main` (#777 Defect B Layer 2)', () => {
    // The integration branch isn't always `main` (e.g. `ci`, `develop`,
    // `trunk`). Resolve it dynamically via `git symbolic-ref --short
    // refs/remotes/origin/HEAD` with a fallback. Excludes false-positive
    // matches like "main goal", "maintain", etc. by requiring a word boundary.
    const bad = /git diff(\s+--stat)?\s+main\b/;
    const violations = findViolations(files, bad);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});
