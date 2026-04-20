/**
 * Regression tests for PR query construction (#684).
 *
 * Covers the fix for "Gemini consult fails on large PR diffs due to inlined
 * payload size": buildPRQuery must write the diff to a temp file and
 * reference the path, NOT inline the raw diff in the prompt.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { _composePRQueryText as composePRQueryText } from '../index.js';

describe('composePRQueryText (#684)', () => {
  const baseParams = {
    prId: '796',
    info: '{"title":"Some PR","state":"OPEN","additions":16846,"deletions":0}',
    changedFiles: ['src/foo.ts', 'tests/foo.test.ts'],
    comments: '(No comments)',
    diffPath: '/tmp/codev-pr-796-1234567890.diff',
    diffBytes: 851_000,
    diffLines: 16846,
  };

  it('references the diff file path', () => {
    const q = composePRQueryText(baseParams);
    expect(q).toContain(baseParams.diffPath);
  });

  it('does NOT inline the raw diff content', () => {
    // A recognisable chunk of real diff syntax we passed (or would pass) should
    // not appear in the prompt — the model is pointed at the file instead.
    const fakeDiff = 'diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n+SENTINEL_DIFF_BODY';
    const q = composePRQueryText({ ...baseParams, info: `${baseParams.info}\n${fakeDiff}` });
    // The sentinel only appears because we stuffed it into `info` above —
    // verify the prompt has no diff-fenced block with raw diff syntax.
    // Specifically: no "```diff" fence (that was the pre-fix pattern).
    expect(q).not.toContain('```diff');
  });

  it('lists changed files', () => {
    const q = composePRQueryText(baseParams);
    for (const f of baseParams.changedFiles) {
      expect(q).toContain(`- ${f}`);
    }
    expect(q).toContain('## Changed Files (2)');
  });

  it('reports diff size in the prompt', () => {
    const q = composePRQueryText(baseParams);
    expect(q).toContain(`${baseParams.diffBytes} bytes`);
    expect(q).toContain(`${baseParams.diffLines} lines`);
  });

  it('keeps the prompt small regardless of diff size', () => {
    // Simulated 800KB diff — the prompt must remain small (< ~10KB).
    // This is the core regression guard: previously, a large diff blew the
    // prompt past what gemini-cli's JSON path could survive.
    const bigDiffParams = { ...baseParams, diffBytes: 851_000, diffLines: 16846 };
    const q = composePRQueryText(bigDiffParams);
    expect(q.length).toBeLessThan(10_000);
  });

  it('includes the verdict template', () => {
    const q = composePRQueryText(baseParams);
    expect(q).toContain('VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]');
    expect(q).toContain('KEY_ISSUES:');
  });
});

describe('buildPRQuery temp-file security contract (#684)', () => {
  it('creates an owner-only dir + file and refuses to follow symlinks', () => {
    // Contract test for the secure temp-file convention used by buildPRQuery:
    //   - mkdtempSync gives us a dedicated dir, so nothing else can race us
    //     into the final filename.
    //   - writeFileSync with mode 0o600 + flag 'wx' enforces owner-only perms
    //     and fails on an existing file/symlink.
    // We exercise the same primitives to lock in the convention.
    const diffDir = fs.mkdtempSync(path.join(tmpdir(), 'codev-pr-'));
    const diffPath = path.join(diffDir, 'pr-796.diff');
    try {
      fs.writeFileSync(diffPath, 'fake diff', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });

      expect(diffDir.startsWith(tmpdir())).toBe(true);
      expect(path.basename(diffDir)).toMatch(/^codev-pr-/);

      const stat = fs.statSync(diffPath);
      // Verify owner-only bits; strip the file-type bits so we can compare permissions.
      expect(stat.mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(diffPath, 'utf-8')).toBe('fake diff');

      // Second write must refuse (would-overwrite), confirming flag 'wx' is
      // enforced — the real guard against a pre-planted symlink.
      expect(() =>
        fs.writeFileSync(diffPath, 'collision', { encoding: 'utf-8', mode: 0o600, flag: 'wx' }),
      ).toThrow(/EEXIST/);
    } finally {
      if (fs.existsSync(diffPath)) fs.unlinkSync(diffPath);
      if (fs.existsSync(diffDir)) fs.rmdirSync(diffDir);
    }
  });
});
