/**
 * Unit tests for lib/github.ts — shared GitHub utilities.
 *
 * Tests: parseLinkedIssue, parseLabelDefaults.
 */

import { describe, it, expect } from 'vitest';
import {
  parseLinkedIssue,
  parseLabelDefaults,
} from '../lib/github.js';

describe('parseLinkedIssue', () => {
  it('parses "Fixes #N" from PR body', () => {
    expect(parseLinkedIssue('This PR fixes #315', 'Some title')).toBe(315);
  });

  it('parses "Closes #N" from PR body', () => {
    expect(parseLinkedIssue('Closes #42\n\nSome description', 'Title')).toBe(42);
  });

  it('parses "Resolves #N" from PR body', () => {
    expect(parseLinkedIssue('Resolves #100', 'Title')).toBe(100);
  });

  it('parses "Fix #N" (without es) from PR body', () => {
    expect(parseLinkedIssue('Fix #7', 'Title')).toBe(7);
  });

  it('parses "Closed #N" from PR body', () => {
    expect(parseLinkedIssue('Closed #99', 'Title')).toBe(99);
  });

  it('parses "Resolved #N" from PR body', () => {
    expect(parseLinkedIssue('Resolved #200', 'Title')).toBe(200);
  });

  it('parses [Spec N] from PR title', () => {
    expect(parseLinkedIssue('', '[Spec 0126] Initial plan')).toBe(126);
  });

  it('parses [Spec #N] from PR title', () => {
    expect(parseLinkedIssue('', '[Spec #42] Feature name')).toBe(42);
  });

  it('parses [Bugfix #N] from PR title', () => {
    expect(parseLinkedIssue('', '[Bugfix #315] Fix stale gates')).toBe(315);
  });

  it('parses [Bugfix N] from PR title (no hash)', () => {
    expect(parseLinkedIssue('', '[Bugfix 99] Remove flicker')).toBe(99);
  });

  it('parses [Spec N] from PR body when title has no match', () => {
    expect(parseLinkedIssue('[Spec 50] details here', 'PR title')).toBe(50);
  });

  it('parses [Bugfix #N] from PR body when title has no match', () => {
    expect(parseLinkedIssue('[Bugfix #88] fix details', 'PR title')).toBe(88);
  });

  it('prefers closing keywords over [Spec N]', () => {
    expect(parseLinkedIssue('Fixes #10\n[Spec 20]', '[Spec 30] Title')).toBe(10);
  });

  it('returns null when no match found', () => {
    expect(parseLinkedIssue('No issue reference here', 'Plain title')).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(parseLinkedIssue('', '')).toBeNull();
  });

  it('is case-insensitive for closing keywords', () => {
    expect(parseLinkedIssue('FIXES #123', 'Title')).toBe(123);
  });

  it('is case-insensitive for [Spec] pattern', () => {
    expect(parseLinkedIssue('', '[spec #5] Title')).toBe(5);
  });
});

describe('parseLabelDefaults', () => {
  it('returns defaults for empty labels', () => {
    expect(parseLabelDefaults([])).toEqual({ type: 'feature', priority: 'medium' });
  });

  it('extracts type:bug label', () => {
    expect(parseLabelDefaults([{ name: 'type:bug' }])).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('extracts priority:high label', () => {
    expect(parseLabelDefaults([{ name: 'priority:high' }])).toEqual({
      type: 'feature',
      priority: 'high',
    });
  });

  it('extracts both type and priority', () => {
    expect(parseLabelDefaults([
      { name: 'type:feature' },
      { name: 'priority:low' },
    ])).toEqual({ type: 'feature', priority: 'low' });
  });

  it('ignores non-type/priority labels', () => {
    expect(parseLabelDefaults([
      { name: 'good-first-issue' },
      { name: 'type:bug' },
      { name: 'help-wanted' },
    ])).toEqual({ type: 'bug', priority: 'medium' });
  });

  it('picks first alphabetical for multiple type labels', () => {
    expect(parseLabelDefaults([
      { name: 'type:feature' },
      { name: 'type:bug' },
    ])).toEqual({ type: 'bug', priority: 'medium' });
  });

  it('picks first alphabetical for multiple priority labels', () => {
    expect(parseLabelDefaults([
      { name: 'priority:medium' },
      { name: 'priority:high' },
    ])).toEqual({ type: 'feature', priority: 'high' });
  });

  it('matches bare "bug" label when no type: prefix exists', () => {
    expect(parseLabelDefaults([{ name: 'bug' }])).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('matches bare "project" label when no type: prefix exists', () => {
    expect(parseLabelDefaults([{ name: 'project' }])).toEqual({
      type: 'project',
      priority: 'medium',
    });
  });

  it('prefers type: prefixed label over bare label', () => {
    expect(parseLabelDefaults([
      { name: 'bug' },
      { name: 'type:project' },
    ])).toEqual({ type: 'project', priority: 'medium' });
  });

  it('ignores bare labels that are not known types', () => {
    expect(parseLabelDefaults([
      { name: 'help-wanted' },
      { name: 'good-first-issue' },
    ])).toEqual({ type: 'feature', priority: 'medium' });
  });
});
