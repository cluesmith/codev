/**
 * Spec 1951 — the schema-1 report, verdict and exit codes, and both renderers.
 */

import { describe, expect, it } from 'vitest';
import { RunnerRefusal } from '../allow-list.js';
import {
  applySkips,
  check,
  CheckCommandError,
  describeRuns,
  errorReport,
  exitCodeOf,
  notRun,
  off,
  summarizeRuns,
  truncateList,
  verdictOf,
  type PrReport,
} from '../report.js';
import { attentionNames, renderChecks, renderErrorHuman, renderHuman, renderJson } from '../render.js';
import { InputError } from '../validate.js';

const HEAD = 'a1b2c3d'.padEnd(40, '0');
const BASE = '7c0f3ab'.padEnd(40, '0');

describe('Spec 1951 — verdict and exit code', () => {
  it('is clear when nothing needs attention; info, off and skip never change it', () => {
    const checks = [check('size', 'info', '+1 −0 in 1 file'), check('state', 'ok', 'OPEN'), off('deploy-run', 'no workflow'), check('overlap', 'skip', 'skipped')];
    expect(verdictOf(checks)).toBe('clear');
    expect(exitCodeOf(verdictOf(checks))).toBe(0);
  });

  it('is attention for an attention check', () => {
    expect(verdictOf([check('state', 'ok', ''), check('attribution', 'attention', '1 line')])).toBe('attention');
    expect(exitCodeOf('attention')).toBe(1);
  });

  it('counts a check that could not run as attention, never as passing', () => {
    const c = notRun('checks', 'commit-checks timed out after 30s');
    expect(c).toEqual({ id: 'checks', status: 'not-run', summary: 'commit-checks timed out after 30s', details: {}, reason: 'commit-checks timed out after 30s' });
    expect(verdictOf([c])).toBe('attention');
  });

  it('replaces a skipped check, attention included, with a skip entry', () => {
    const checks = applySkips([check('size', 'info', 'x'), check('attribution', 'attention', 'y', { hits: [1] })], new Set(['attribution']));
    expect(checks[1]).toEqual({ id: 'attribution', status: 'skip', summary: 'skipped (check.skip)', details: {}, reason: 'check.skip' });
    expect(verdictOf(checks)).toBe('clear');
  });
});

describe('Spec 1951 — summarizeRuns', () => {
  it('counts passed, failed and pending, with skipped and neutral as passed', () => {
    const runs = summarizeRuns(HEAD, [
      { name: 'unit', state: 'fail' },
      { name: 'lint', state: 'pass' },
      { name: 'docs', state: 'skipped' },
      { name: 'info', state: 'neutral' },
      { name: 'e2e', state: 'pending' },
    ]);
    expect(runs).toMatchObject({ sha: HEAD, passed: 3, failed: 1, pending: 1 });
    expect(runs.runs).toHaveLength(5);
    expect(describeRuns(runs)).toBe('3 passed, 1 failed (unit), 1 still running');
  });

  it('describes no runs, and truncates the failed names', () => {
    expect(describeRuns(summarizeRuns(HEAD, []))).toBe('no runs');
    const many = summarizeRuns(HEAD, ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, state: 'fail' as const })));
    expect(describeRuns(many)).toBe('5 failed (a, b, c, … +2)');
  });

  it('truncates a list with a count', () => {
    expect(truncateList(['a', 'b'], 3)).toBe('a, b');
    expect(truncateList(['a', 'b', 'c', 'd'], 2)).toBe('a, b, … +2');
  });
});

describe('Spec 1951 — human form', () => {
  const checks = [
    check('attribution', 'attention', '2 lines: commit 9f8e7d6 "Co-Authored-By: Claude …"'),
    check('trial-merge', 'ok', 'clean into main @ 7c0f3ab'),
    check('checks', 'attention', 'code 57d2ec5: 7 passed, 1 failed (unit)\nhead a1b2c3d: no runs'),
    notRun('forge', 'pr-view timed out after 30s'),
    off('deploy-run', 'no deploy workflow configured (check.deploy.workflow)'),
    check('size', 'skip', 'skipped (check.skip)'),
    check('to-read', 'info', '14 files'),
  ];

  it('names what needs attention on the verdict line, with qualifiers', () => {
    const names = attentionNames(checks, { qualifier: (c) => (c.id === 'checks' ? 'failed' : null) });
    expect(names).toEqual(['attribution', 'checks (failed)', 'forge (not run)']);
  });

  it('prints one line per check with its status word, continuation lines aligned', () => {
    const lines = renderChecks(checks);
    expect(lines).toEqual([
      '  ATTN    attribution   2 lines: commit 9f8e7d6 "Co-Authored-By: Claude …"',
      '  ok      trial merge   clean into main @ 7c0f3ab',
      '  ATTN    checks        code 57d2ec5: 7 passed, 1 failed (unit)',
      '                        head a1b2c3d: no runs',
      '  not run forge         pr-view timed out after 30s',
      '  off     deploy run    no deploy workflow configured (check.deploy.workflow)',
      '  skip    size          skipped (check.skip)',
      '  info    to read       14 files',
    ]);
  });

  it('puts the verdict first, then the header, then the checks', () => {
    const text = renderHuman({
      verdictLine: 'ATTENTION  PR #1957 — attribution',
      header: ['PR #1957  Title   OPEN   builder/x → main'],
      sections: [{ checks: [checks[0]] }],
    });
    expect(text.split('\n')).toEqual([
      'ATTENTION  PR #1957 — attribution',
      '',
      'PR #1957  Title   OPEN   builder/x → main',
      '  ATTN    attribution   2 lines: commit 9f8e7d6 "Co-Authored-By: Claude …"',
      '',
    ]);
  });

  it('prints a section title above its checks', () => {
    const text = renderHuman({ verdictLine: 'CLEAR  #1948', header: [], sections: [{ title: '#1948  merged', checks: [checks[1]] }] });
    expect(text).toBe('CLEAR  #1948\n\n#1948  merged\n  ok      trial merge   clean into main @ 7c0f3ab\n');
  });
});

describe('Spec 1951 — --json', () => {
  it('writes one object with the schema-1 shape for a report', () => {
    const report: PrReport = {
      schema: 1,
      command: 'pr',
      verdict: 'attention',
      generatedAt: '2026-11-23T00:00:00.000Z',
      pr: { number: 1957, title: 'T', state: 'OPEN', draft: false, headRef: 'builder/x', head: HEAD, baseRef: 'main', baseTip: BASE, localBranch: null },
      checks: [check('attribution', 'attention', '1 line', { patterns: ['x'], hits: [] })],
    };
    const text = renderJson(report);
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(report);
    expect(Object.keys(parsed)).toEqual(['schema', 'command', 'verdict', 'generatedAt', 'pr', 'checks']);
    expect(Object.keys(parsed.checks[0])).toEqual(['id', 'status', 'summary', 'details']);
  });

  it('writes the error report for a failure', () => {
    const parsed = JSON.parse(renderJson(errorReport('pr', new CheckCommandError('PR #9 not found', 'gh: no pull requests found'))));
    expect(parsed).toEqual({ schema: 1, command: 'pr', error: { message: 'PR #9 not found', cause: 'gh: no pull requests found' } });
  });

  it('maps input errors, refusals and unexpected errors to an error report', () => {
    expect(errorReport('deploy', new InputError('invalid PR number "12a"')).error).toEqual({ message: 'invalid PR number "12a"' });
    expect(errorReport('worktree', new RunnerRefusal(['git', 'push'], 'no')).error.message).toBe('refused to run git push: no');
    expect(errorReport('pr', new Error('boom')).error).toEqual({ message: 'unexpected failure: boom' });
  });

  it('renders an error for stderr', () => {
    expect(renderErrorHuman(errorReport('pr', new CheckCommandError('no origin', 'line 1\nline 2')))).toBe(
      'codev check pr: no origin\n  line 1\n  line 2\n',
    );
  });
});
