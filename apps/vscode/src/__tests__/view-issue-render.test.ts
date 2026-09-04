/**
 * #1592 — issue-view metadata rendering.
 *
 * `renderIssue` turns an `IssueView` into the markdown shown in the in-editor
 * issue preview. These tests pin the metadata block added under the title
 * (opened-by + date, labels, assignees, milestone) and, crucially, the
 * omit-when-absent behavior: a field the forge didn't supply produces no line,
 * and an issue with no metadata at all renders exactly as it did before #1592.
 *
 * Like `view-issue-column.test.ts`, `view-issue.ts` imports `vscode` and `new`s
 * an `EventEmitter` at module load, so the minimal mock below just lets that
 * import chain resolve; `renderIssue` itself touches no VS Code API.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IssueView } from '@cluesmith/codev-types';

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (): { dispose(): void } => ({ dispose() {} });
    fire(): void {}
    dispose(): void {}
  },
  ViewColumn: { One: 1, Two: 2 },
  Uri: { parse: (s: string): { toString(): string } => ({ toString: () => s }) },
}));

const { renderIssue } = await import('../commands/view-issue.js');

/** A minimal issue with no optional metadata and no comments. */
function baseIssue(overrides: Partial<IssueView> = {}): IssueView {
  return {
    title: 'Fix the thing',
    body: 'Body text.',
    state: 'open',
    comments: [],
    ...overrides,
  };
}

describe('renderIssue metadata block', () => {
  it('renders opened-by+date, labels, assignees, and milestone under the title', () => {
    const md = renderIssue('1592', baseIssue({
      author: { login: 'amrmelsayed' },
      createdAt: '2026-09-02T22:51:59Z',
      labels: [{ name: 'area/cross-cutting' }, { name: 'area/vscode' }],
      assignees: [{ login: 'alice' }, { login: 'bob' }],
      milestone: { title: 'v3.4.0' },
    }));

    expect(md).toContain('# #1592 Fix the thing');
    expect(md).toContain('**State:** open');
    expect(md).toContain('**Opened by** @amrmelsayed on 2026-09-02');
    expect(md).toContain('**Labels:** area/cross-cutting, area/vscode');
    expect(md).toContain('**Assignees:** @alice, @bob');
    expect(md).toContain('**Milestone:** v3.4.0');

    // Order: state, then opened-by, then labels, then assignees, then milestone.
    const iState = md.indexOf('**State:**');
    const iOpened = md.indexOf('**Opened by**');
    const iLabels = md.indexOf('**Labels:**');
    const iAssignees = md.indexOf('**Assignees:**');
    const iMilestone = md.indexOf('**Milestone:**');
    expect(iState).toBeLessThan(iOpened);
    expect(iOpened).toBeLessThan(iLabels);
    expect(iLabels).toBeLessThan(iAssignees);
    expect(iAssignees).toBeLessThan(iMilestone);
  });

  it('renders the date as a YYYY-MM-DD prefix of the ISO timestamp', () => {
    const md = renderIssue('7', baseIssue({ createdAt: '2026-01-15T08:30:00Z' }));
    expect(md).toContain('**Opened** 2026-01-15');
    expect(md).not.toContain('08:30:00');
  });

  it('shows only the present fields when a subset of metadata is supplied', () => {
    const md = renderIssue('7', baseIssue({ labels: [{ name: 'bug' }] }));
    expect(md).toContain('**Labels:** bug');
    expect(md).not.toContain('**Opened');
    expect(md).not.toContain('**Assignees:**');
    expect(md).not.toContain('**Milestone:**');
  });

  it('collapses opened-by to just the author when no createdAt is supplied', () => {
    const md = renderIssue('7', baseIssue({ author: { login: 'alice' } }));
    expect(md).toContain('**Opened by** @alice');
    expect(md).not.toContain(' on ');
  });

  it('omits the milestone line when milestone is null (GitHub emits null when unset)', () => {
    const md = renderIssue('7', baseIssue({ milestone: null }));
    expect(md).not.toContain('**Milestone:**');
  });

  it('omits empty label and assignee arrays', () => {
    const md = renderIssue('7', baseIssue({ labels: [], assignees: [] }));
    expect(md).not.toContain('**Labels:**');
    expect(md).not.toContain('**Assignees:**');
  });

  it('renders identically to the pre-#1592 output when no metadata is present', () => {
    const md = renderIssue('7', baseIssue());
    expect(md).toBe('# #7 Fix the thing\n\n**State:** open\n\nBody text.');
  });

  it('falls back to a placeholder when the body is empty', () => {
    const md = renderIssue('7', baseIssue({ body: '   ' }));
    expect(md).toContain('_No description._');
  });

  it('still renders the comments section after the metadata block', () => {
    const md = renderIssue('7', baseIssue({
      author: { login: 'alice' },
      comments: [{ body: 'A comment', createdAt: '2026-02-01T00:00:00Z', author: { login: 'bob' } }],
    }));
    expect(md).toContain('## Comments (1)');
    expect(md).toContain('### @bob — 2026-02-01T00:00:00Z');
    // Metadata precedes comments.
    expect(md.indexOf('**Opened by**')).toBeLessThan(md.indexOf('## Comments'));
  });
});
