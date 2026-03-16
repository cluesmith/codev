/**
 * Unit tests for lib/github.ts — shared GitHub utilities.
 *
 * Tests: parseLinkedIssue, parseLabelDefaults, forge concept routing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseLinkedIssue,
  parseLabelDefaults,
} from '../lib/github.js';

// Mock forge.js for concept command routing tests
const executeForgeCommandMock = vi.fn();
vi.mock('../lib/forge.js', () => ({
  executeForgeCommand: (...args: unknown[]) => executeForgeCommandMock(...args),
}));

describe('parseLinkedIssue', () => {
  it('parses "Fixes #N" from PR body', () => {
    expect(parseLinkedIssue('This PR fixes #315', 'Some title')).toBe('315');
  });

  it('parses "Closes #N" from PR body', () => {
    expect(parseLinkedIssue('Closes #42\n\nSome description', 'Title')).toBe('42');
  });

  it('parses "Resolves #N" from PR body', () => {
    expect(parseLinkedIssue('Resolves #100', 'Title')).toBe('100');
  });

  it('parses "Fix #N" (without es) from PR body', () => {
    expect(parseLinkedIssue('Fix #7', 'Title')).toBe('7');
  });

  it('parses "Closed #N" from PR body', () => {
    expect(parseLinkedIssue('Closed #99', 'Title')).toBe('99');
  });

  it('parses "Resolved #N" from PR body', () => {
    expect(parseLinkedIssue('Resolved #200', 'Title')).toBe('200');
  });

  it('parses [Spec N] from PR title', () => {
    expect(parseLinkedIssue('', '[Spec 0126] Initial plan')).toBe('126');
  });

  it('parses [Spec #N] from PR title', () => {
    expect(parseLinkedIssue('', '[Spec #42] Feature name')).toBe('42');
  });

  it('parses [Bugfix #N] from PR title', () => {
    expect(parseLinkedIssue('', '[Bugfix #315] Fix stale gates')).toBe('315');
  });

  it('parses [Bugfix N] from PR title (no hash)', () => {
    expect(parseLinkedIssue('', '[Bugfix 99] Remove flicker')).toBe('99');
  });

  it('parses [Spec N] from PR body when title has no match', () => {
    expect(parseLinkedIssue('[Spec 50] details here', 'PR title')).toBe('50');
  });

  it('parses [Bugfix #N] from PR body when title has no match', () => {
    expect(parseLinkedIssue('[Bugfix #88] fix details', 'PR title')).toBe('88');
  });

  it('prefers closing keywords over [Spec N]', () => {
    expect(parseLinkedIssue('Fixes #10\n[Spec 20]', '[Spec 30] Title')).toBe('10');
  });

  it('returns null when no match found', () => {
    expect(parseLinkedIssue('No issue reference here', 'Plain title')).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(parseLinkedIssue('', '')).toBeNull();
  });

  it('is case-insensitive for closing keywords', () => {
    expect(parseLinkedIssue('FIXES #123', 'Title')).toBe('123');
  });

  it('is case-insensitive for [Spec] pattern', () => {
    expect(parseLinkedIssue('', '[spec #5] Title')).toBe('5');
  });
});

describe('parseLabelDefaults', () => {
  it('defaults to project when no labels and no title', () => {
    expect(parseLabelDefaults([])).toEqual({ type: 'project', priority: 'medium' });
  });

  it('extracts type:bug label', () => {
    expect(parseLabelDefaults([{ name: 'type:bug' }])).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('defaults to project when only priority label and no title', () => {
    expect(parseLabelDefaults([{ name: 'priority:high' }])).toEqual({
      type: 'project',
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

  it('defaults to project for multiple priority labels without type', () => {
    expect(parseLabelDefaults([
      { name: 'priority:medium' },
      { name: 'priority:high' },
    ])).toEqual({ type: 'project', priority: 'high' });
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

  it('matches bare "spike" label when no type: prefix exists', () => {
    expect(parseLabelDefaults([{ name: 'spike' }])).toEqual({
      type: 'spike',
      priority: 'medium',
    });
  });

  it('prefers type: prefixed label over bare label', () => {
    expect(parseLabelDefaults([
      { name: 'bug' },
      { name: 'type:project' },
    ])).toEqual({ type: 'project', priority: 'medium' });
  });

  it('defaults to project for unrecognized bare labels without title', () => {
    expect(parseLabelDefaults([
      { name: 'help-wanted' },
      { name: 'good-first-issue' },
    ])).toEqual({ type: 'project', priority: 'medium' });
  });

  it('infers bug from title with "fix" keyword', () => {
    expect(parseLabelDefaults([], 'Fix login timeout')).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('infers bug from title with "broken" keyword', () => {
    expect(parseLabelDefaults([], 'Dashboard broken on mobile')).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('infers bug from title with "error" keyword', () => {
    expect(parseLabelDefaults([], 'Error when saving settings')).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('infers bug from title with "crash" keyword', () => {
    expect(parseLabelDefaults([], 'App crash on startup')).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('infers bug from title with "regression" keyword', () => {
    expect(parseLabelDefaults([], 'Regression in auth flow')).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('infers bug from title with "not working" keyword', () => {
    expect(parseLabelDefaults([], 'Search not working after update')).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('infers project from title without bug keywords', () => {
    expect(parseLabelDefaults([], 'Add dark mode support')).toEqual({
      type: 'project',
      priority: 'medium',
    });
  });

  it('infers project from title with "implement" keyword', () => {
    expect(parseLabelDefaults([], 'Implement user authentication')).toEqual({
      type: 'project',
      priority: 'medium',
    });
  });

  it('explicit label takes precedence over title heuristic', () => {
    expect(parseLabelDefaults([{ name: 'type:project' }], 'Fix broken auth')).toEqual({
      type: 'project',
      priority: 'medium',
    });
  });

  it('bare label takes precedence over title heuristic', () => {
    expect(parseLabelDefaults([{ name: 'project' }], 'Fix broken auth')).toEqual({
      type: 'project',
      priority: 'medium',
    });
  });

  it('title heuristic is case-insensitive', () => {
    expect(parseLabelDefaults([], 'FIX: Broken tooltip')).toEqual({
      type: 'bug',
      priority: 'medium',
    });
  });

  it('matches verb variants like "Fixes" and "Errors"', () => {
    expect(parseLabelDefaults([], 'Fixes stale data in cache').type).toBe('bug');
    expect(parseLabelDefaults([], 'Errors in production logs').type).toBe('bug');
    expect(parseLabelDefaults([], 'Crashed during migration').type).toBe('bug');
    expect(parseLabelDefaults([], 'Failed to load config').type).toBe('bug');
  });

  it('does not misclassify "issue" in title as bug', () => {
    expect(parseLabelDefaults([], 'Add issue tracking').type).toBe('project');
    expect(parseLabelDefaults([], 'Create issue template').type).toBe('project');
    expect(parseLabelDefaults([], 'Improve issue search').type).toBe('project');
  });
});

// =============================================================================
// Forge concept command routing tests
// =============================================================================

describe('forge concept routing', () => {
  beforeEach(() => {
    executeForgeCommandMock.mockReset();
  });

  describe('fetchGitHubIssue', () => {
    it('routes through issue-view concept with CODEV_ISSUE_ID', async () => {
      const { fetchGitHubIssue } = await import('../lib/github.js');
      const mockIssue = { title: 'Test', body: 'Body', state: 'open', comments: [] };
      executeForgeCommandMock.mockResolvedValue(mockIssue);

      const result = await fetchGitHubIssue(42, { cwd: '/tmp' });

      expect(result).toEqual(mockIssue);
      expect(executeForgeCommandMock).toHaveBeenCalledWith(
        'issue-view',
        { CODEV_ISSUE_ID: '42' },
        expect.objectContaining({ cwd: '/tmp' }),
      );
    });

    it('accepts string issue ID for non-GitHub forges', async () => {
      const { fetchGitHubIssue } = await import('../lib/github.js');
      executeForgeCommandMock.mockResolvedValue(null);

      await fetchGitHubIssue('PROJ-123');

      expect(executeForgeCommandMock).toHaveBeenCalledWith(
        'issue-view',
        { CODEV_ISSUE_ID: 'PROJ-123' },
        expect.any(Object),
      );
    });

    it('returns null when concept command fails', async () => {
      const { fetchGitHubIssue } = await import('../lib/github.js');
      executeForgeCommandMock.mockResolvedValue(null);

      const result = await fetchGitHubIssue(99);
      expect(result).toBeNull();
    });
  });

  describe('fetchGitHubIssueOrThrow', () => {
    it('throws when concept command returns null', async () => {
      const { fetchGitHubIssueOrThrow } = await import('../lib/github.js');
      executeForgeCommandMock.mockResolvedValue(null);

      await expect(fetchGitHubIssueOrThrow(99)).rejects.toThrow(/issue-view/);
    });
  });

  describe('fetchPRList', () => {
    it('routes through pr-list concept', async () => {
      const { fetchPRList } = await import('../lib/github.js');
      const mockPRs = [{ number: 1, title: 'PR 1', url: '', reviewDecision: '', body: '', createdAt: '' }];
      executeForgeCommandMock.mockResolvedValue(mockPRs);

      const result = await fetchPRList('/repo');

      expect(result).toEqual(mockPRs);
      expect(executeForgeCommandMock).toHaveBeenCalledWith('pr-list', {}, expect.objectContaining({ cwd: '/repo' }));
    });
  });

  describe('fetchIssueList', () => {
    it('routes through issue-list concept', async () => {
      const { fetchIssueList } = await import('../lib/github.js');
      executeForgeCommandMock.mockResolvedValue([]);

      await fetchIssueList('/repo');

      expect(executeForgeCommandMock).toHaveBeenCalledWith('issue-list', {}, expect.objectContaining({ cwd: '/repo' }));
    });
  });

  describe('fetchRecentlyClosed', () => {
    it('routes through recently-closed with CODEV_SINCE_DATE', async () => {
      const { fetchRecentlyClosed } = await import('../lib/github.js');
      executeForgeCommandMock.mockResolvedValue([]);

      await fetchRecentlyClosed('/repo');

      expect(executeForgeCommandMock).toHaveBeenCalledWith(
        'recently-closed',
        expect.objectContaining({ CODEV_SINCE_DATE: expect.any(String) }),
        expect.any(Object),
      );
    });
  });

  describe('fetchRecentMergedPRs', () => {
    it('routes through recently-merged with CODEV_SINCE_DATE', async () => {
      const { fetchRecentMergedPRs } = await import('../lib/github.js');
      executeForgeCommandMock.mockResolvedValue([]);

      await fetchRecentMergedPRs('/repo');

      expect(executeForgeCommandMock).toHaveBeenCalledWith(
        'recently-merged',
        expect.objectContaining({ CODEV_SINCE_DATE: expect.any(String) }),
        expect.any(Object),
      );
    });
  });

  describe('forgeConfig threading', () => {
    it('passes forgeConfig to concept commands', async () => {
      const { fetchPRList } = await import('../lib/github.js');
      const config = { 'pr-list': 'custom-command' };
      executeForgeCommandMock.mockResolvedValue([]);

      await fetchPRList('/repo', config);

      expect(executeForgeCommandMock).toHaveBeenCalledWith(
        'pr-list',
        {},
        expect.objectContaining({ forgeConfig: config }),
      );
    });
  });
});
