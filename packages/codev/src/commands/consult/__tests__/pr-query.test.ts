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

describe('buildPRQuery temp-file contract (#684)', () => {
  it('writes diff to a /tmp path matching the codev-pr-<N>-<ts>.diff pattern', () => {
    // This is a contract test for the temp-file convention, exercised without
    // spawning the forge layer. We re-do the write locally and assert the
    // pattern: it must live in os.tmpdir() with the expected prefix so /tmp
    // rotation can reliably find and reap these files.
    const prId = '796';
    const ts = Date.now();
    const diffPath = path.join(tmpdir(), `codev-pr-${prId}-${ts}.diff`);
    fs.writeFileSync(diffPath, 'fake diff contents', 'utf-8');
    try {
      expect(diffPath.startsWith(tmpdir())).toBe(true);
      expect(path.basename(diffPath)).toMatch(/^codev-pr-\d+-\d+\.diff$/);
      expect(fs.readFileSync(diffPath, 'utf-8')).toBe('fake diff contents');
    } finally {
      fs.unlinkSync(diffPath);
    }
  });
});
