/**
 * Spec 1951 — the `linked-issue` check: closing keywords in the description against the
 * builder branch's issue (Scenario 12a).
 */

import { describe, expect, it } from 'vitest';
import { branchIssue, checkLinkedIssue, closingReferences } from '../linked-issue.js';

describe('Spec 1951 — closing keywords', () => {
  it.each([
    ['close #1', 'close'],
    ['closes #1', 'closes'],
    ['Closed #1', 'Closed'],
    ['fix #1', 'fix'],
    ['Fixes #1', 'Fixes'],
    ['FIXED #1', 'FIXED'],
    ['resolve #1', 'resolve'],
    ['Resolves: #1', 'Resolves'],
    ['resolved  #1', 'resolved'],
  ])('%j is a closing keyword', (text, keyword) => {
    expect(closingReferences(text)).toEqual([{ keyword, issue: 1 }]);
  });

  it.each([
    ['a word that only ends in one', 'prefixes #1'],
    ['a keyword run into the number', 'Fixes#1'],
    ['another repository', 'Fixes owner/repo#1'],
    ['a mention without a keyword', 'See #1'],
    ['an inflection GitHub does not take', 'Fixing #1'],
  ])('%s is not one: %j', (_name, text) => {
    expect(closingReferences(text)).toEqual([]);
  });

  it('finds every reference, in order', () => {
    expect(closingReferences('Fixes #12\n\nAlso closes #13 and resolves #12.')).toEqual([
      { keyword: 'Fixes', issue: 12 },
      { keyword: 'closes', issue: 13 },
      { keyword: 'resolves', issue: 12 },
    ]);
  });

  it('reads the issue from a builder/<protocol>-<id> branch only', () => {
    expect(branchIssue('builder/spir-1951')).toBe(1951);
    expect(branchIssue('builder/bugfix-42')).toBe(42);
    expect(branchIssue('feature/1951')).toBeNull();
    expect(branchIssue('builder/spir-1951-extra')).toBeNull();
    expect(branchIssue('main')).toBeNull();
  });
});

describe('Spec 1951 — Scenario 12a: the linked-issue check', () => {
  it('a keyword naming the branch issue is info', () => {
    expect(checkLinkedIssue('Summary\n\nFixes #1951', 'builder/spir-1951')).toEqual({
      id: 'linked-issue',
      status: 'info',
      summary: '"Fixes #1951" — matches builder/spir-1951',
      details: { references: [{ keyword: 'Fixes', issue: 1951 }], branchIssue: 1951, keyword: 'Fixes', issue: 1951 },
    });
  });

  it('no keyword is info with the close-by-hand note', () => {
    expect(checkLinkedIssue('Part of #1951', 'builder/spir-1951')).toMatchObject({
      status: 'info',
      summary: 'no closing keyword — close #1951 by hand after merge',
      details: { references: [], branchIssue: 1951 },
    });
  });

  it('a keyword naming a different issue needs attention', () => {
    expect(checkLinkedIssue('Fixes #1950', 'builder/spir-1951')).toMatchObject({
      status: 'attention',
      summary: '"Fixes #1950", but builder/spir-1951 is for #1951',
      details: { keyword: 'Fixes', issue: 1950, branchIssue: 1951 },
    });
  });

  it('the branch issue among several is info, naming the others', () => {
    expect(checkLinkedIssue('Closes #1950\nFixes #1951', 'builder/spir-1951')).toMatchObject({
      status: 'info',
      summary: '"Fixes #1951" — matches builder/spir-1951; also #1950',
    });
  });

  it('on a branch that names no issue, a keyword is info and none is the plain note', () => {
    expect(checkLinkedIssue('Fixes #12', 'feature/x')).toMatchObject({ status: 'info', summary: '"Fixes #12"' });
    expect(checkLinkedIssue('nothing', 'feature/x')).toMatchObject({ status: 'info', summary: 'no closing keyword', details: { references: [] } });
  });

  it('no description is not run, naming the concept', () => {
    expect(checkLinkedIssue(null, 'builder/spir-1951')).toMatchObject({
      status: 'not-run',
      reason: 'pr-view did not return body (the description)',
    });
  });
});
