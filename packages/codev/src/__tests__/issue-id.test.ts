/**
 * Issue #1740: issue identifiers are bare numbers (GitHub, GitLab, Gitea) or
 * tracker keys (Jira, Linear: `ENG-123`).
 */

import { describe, it, expect } from 'vitest';
import { canonicalIssueId, isIssueKey, issueRef, parseIssueArg, sameIssueId } from '../lib/issue-id.js';

describe('isIssueKey', () => {
  it.each(['ENG-123', 'AB2-12', 'MY_PROJ-1', 'eng-1', 'A-1'])('accepts %s', (id) => {
    expect(isIssueKey(id)).toBe(true);
  });

  it.each(['', '42', '-12', 'ENG-', 'ENG', '12-ENG', '2AB-1', 'ENG-1a', 'ENG 1', 'ENG--1', '#ENG-1'])('rejects %j', (id) => {
    expect(isIssueKey(id)).toBe(false);
  });
});

describe('canonicalIssueId', () => {
  it('upper-cases keys and leaves everything else alone', () => {
    expect(canonicalIssueId('eng-123')).toBe('ENG-123');
    expect(canonicalIssueId('Ab2_x-7')).toBe('AB2_X-7');
    expect(canonicalIssueId('42')).toBe('42');
    expect(canonicalIssueId('task-abc')).toBe('task-abc');
  });
});

describe('parseIssueArg', () => {
  it('parses positive integers as numbers', () => {
    expect(parseIssueArg('42')).toBe(42);
    expect(parseIssueArg('0042')).toBe(42);
    expect(parseIssueArg(' 7 ')).toBe(7);
  });

  it('parses keys, canonicalized', () => {
    expect(parseIssueArg('ENG-123')).toBe('ENG-123');
    expect(parseIssueArg('eng-123')).toBe('ENG-123');
    expect(parseIssueArg('AB2-12')).toBe('AB2-12');
  });

  it('rejects zero, partial numbers and junk', () => {
    for (const bad of ['0', '12a', '-3', 'abc', '', 'ENG-', '#42']) {
      expect(parseIssueArg(bad), bad).toBeUndefined();
    }
  });
});

describe('sameIssueId', () => {
  it('compares keys case-insensitively and numbers by value as text', () => {
    expect(sameIssueId('ENG-1', 'eng-1')).toBe(true);
    expect(sameIssueId(42, '42')).toBe(true);
    expect(sameIssueId(42, 43)).toBe(false);
    expect(sameIssueId(undefined, 42)).toBe(false);
  });
});

describe('issueRef', () => {
  it('writes #N for numbers and the canonical key for keys', () => {
    expect(issueRef(42)).toBe('#42');
    expect(issueRef('42')).toBe('#42');
    expect(issueRef('eng-123')).toBe('ENG-123');
  });
});
