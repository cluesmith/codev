// @vitest-environment jsdom
/**
 * Spec 1963 scenarios 10 and 17 (webview side): the Work panel's UI, fed through its store as the
 * extension host's `work/overview` messages feed it.
 * - Loading until the first overview; then builders, Needs Attention, Backlog and Recently Closed;
 *   the last overview stays under the not-connected notice, and with none yet the sections say
 *   they are loading under it.
 * - Every kept control is a message to the extension host: *Open*, *+ Shell*, *Refresh*, a
 *   *spec* / *plan* / *review* link, and an issue or PR link, which the webview does not follow.
 * - The affordances VS Code drops (Open Files & Shells, the file panel, the tip of the day) are
 *   not rendered.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OverviewBacklogItem, OverviewBuilder, OverviewData, OverviewPR, OverviewRecentlyClosed } from '@cluesmith/codev-types';
import type { WorkWebviewMessage } from '../../messages.js';
import { WorkApp, WorkStore, workOverviewOf } from '../WorkApp.js';

afterEach(() => {
  cleanup();
});

function builder(overrides: Partial<OverviewBuilder> = {}): OverviewBuilder {
  return {
    id: 'spir-1963',
    issueId: '1963',
    issueTitle: 'Cockpit layout',
    phase: 'implement',
    protocolPhase: 'implement',
    mode: 'strict',
    gates: {},
    worktreePath: '/ws/.builders/spir-1963',
    roleId: 'builder-spir-1963',
    protocol: 'spir',
    planPhases: [],
    progress: 40,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: null,
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect: 'main',
    prReady: false,
    area: '',
    ...overrides,
  };
}

const BACKLOG: OverviewBacklogItem = {
  id: '401', title: 'Backlog feature', url: 'https://github.com/cluesmith/codev/issues/401', type: 'project', priority: 'high', area: '',
  hasSpec: true, hasPlan: true, hasReview: false, hasBuilder: false, createdAt: new Date().toISOString(),
  specPath: 'codev/specs/401-backlog-feature.md', planPath: 'codev/plans/401-backlog-feature.md',
};

const CLOSED: OverviewRecentlyClosed = {
  id: '399', title: 'Closed feature', url: 'https://github.com/cluesmith/codev/issues/399', type: 'project',
  closedAt: new Date().toISOString(), reviewPath: 'codev/reviews/399-closed-feature.md', prUrl: 'https://github.com/cluesmith/codev/pull/398',
};

const PR: OverviewPR = {
  id: '301', title: 'A human-authored change', url: 'https://github.com/cluesmith/codev/pull/301', reviewStatus: 'REVIEW_REQUIRED',
  linkedIssue: null, createdAt: new Date().toISOString(), reviewRequests: [], isDraft: false,
};

const DATA = {
  builders: [builder()],
  pendingPRs: [PR],
  backlog: [BACKLOG],
  recentlyClosed: [CLOSED],
  architects: [{ name: 'main' }],
  heldCount: 0,
  mailboxEscalated: false,
  queuedFeedback: {},
  feedbackMode: 'forward',
} as unknown as OverviewData;

function mount() {
  const posted: WorkWebviewMessage[] = [];
  const store = new WorkStore();
  const post = (message: WorkWebviewMessage) => { posted.push(message); };
  const view = render(<WorkApp store={store} post={post} />);
  const push = (message: unknown) => {
    const overview = workOverviewOf(message);
    if (overview !== undefined) { act(() => store.setOverview(overview)); }
  };
  return { posted, push, ...view };
}

describe('what the Work panel shows', () => {
  it('shows its loading state until the extension host pushes an overview', () => {
    const { push } = mount();
    expect(screen.getByText('Loading...')).toBeTruthy();
    push({ type: 'work/overview', overview: null });
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders builders, Needs Attention, Backlog and Recently Closed from the overview', () => {
    const { push, container } = mount();
    push({ type: 'work/overview', overview: { data: DATA, error: null } });
    expect(screen.getByRole('heading', { name: 'Work' })).toBeTruthy();
    for (const section of ['Builders', 'Needs Attention', 'Backlog', 'Recently Closed']) {
      expect(screen.getByRole('heading', { name: section })).toBeTruthy();
    }
    expect(screen.getByText('Cockpit layout')).toBeTruthy();
    expect(screen.getByText('A human-authored change')).toBeTruthy();
    expect(screen.getByText('Backlog feature')).toBeTruthy();
    expect(screen.getByText('Closed feature')).toBeTruthy();
    // The progress bar is drawn at its width by an inline style, which the panel's CSP admits.
    expect(container.querySelector<HTMLElement>('[style*="width"]')?.style.width).toBe('40%');
  });

  it('keeps the last overview under the not-connected notice, and drops the notice on reconnect', () => {
    const { push } = mount();
    push({ type: 'work/overview', overview: { data: DATA, error: null } });
    push({ type: 'work/overview', overview: { data: DATA, error: 'Not connected to Tower.' } });
    expect(screen.getByText('Failed to load overview: Not connected to Tower.')).toBeTruthy();
    expect(screen.getByText('Cockpit layout')).toBeTruthy();
    push({ type: 'work/overview', overview: { data: DATA, error: null } });
    expect(screen.queryByText(/Not connected to Tower/)).toBeNull();
  });

  it('before any overview, shows the not-connected notice over sections that are loading, none empty', () => {
    const { push } = mount();
    push({ type: 'work/overview', overview: { data: null, error: 'Not connected to Tower.' } });
    expect(screen.getByText('Failed to load overview: Not connected to Tower.')).toBeTruthy();
    expect(screen.getAllByText('Loading...')).toHaveLength(3);
    expect(screen.queryByText('No active builders')).toBeNull();
    expect(screen.queryByText('Nothing needs attention')).toBeNull();
    expect(screen.queryByText('No open issues')).toBeNull();
  });

  it('renders none of the dropped dashboard affordances', () => {
    const { push, container } = mount();
    push({ type: 'work/overview', overview: { data: DATA, error: null } });
    expect(screen.queryByText(/Open Files/i)).toBeNull();
    expect(screen.queryByText(/tip/i)).toBeNull();
    expect(container.querySelector('.work-view')?.className).not.toContain('file-panel-open');
    // The only buttons are the mapped ones.
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['+ Shell', 'Refresh', 'Open', 'spec', 'plan', 'review']);
  });
});

describe('every control is a message to the extension host', () => {
  it('Open, + Shell and Refresh', () => {
    const { push, posted } = mount();
    push({ type: 'work/overview', overview: { data: DATA, error: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Shell' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(posted).toEqual([
      { type: 'work/open-builder', builderId: 'spir-1963' },
      { type: 'work/new-shell' },
      { type: 'work/refresh' },
    ]);
  });

  it('spec, plan and review links name the file as the overview does', () => {
    const { push, posted } = mount();
    push({ type: 'work/overview', overview: { data: DATA, error: null } });
    for (const name of ['spec', 'plan', 'review']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(posted).toEqual([
      { type: 'work/open-artifact', path: 'codev/specs/401-backlog-feature.md' },
      { type: 'work/open-artifact', path: 'codev/plans/401-backlog-feature.md' },
      { type: 'work/open-artifact', path: 'codev/reviews/399-closed-feature.md' },
    ]);
  });

  it('an issue or PR link goes to the extension host, and the webview does not follow it', () => {
    const { push, posted } = mount();
    push({ type: 'work/overview', overview: { data: DATA, error: null } });
    for (const text of ['A human-authored change', 'Backlog feature', 'Closed feature']) {
      const link = screen.getByText(text).closest('a');
      expect(link, text).not.toBeNull();
      const followed = fireEvent.click(link!);
      expect(followed, `${text}: default prevented`).toBe(false);
    }
    expect(posted).toEqual([
      { type: 'open-external', url: 'https://github.com/cluesmith/codev/pull/301' },
      { type: 'open-external', url: 'https://github.com/cluesmith/codev/issues/401' },
      { type: 'open-external', url: 'https://github.com/cluesmith/codev/issues/399' },
    ]);
  });
});

describe('workOverviewOf: what the webview takes from the host', () => {
  it('takes a pushed overview, or null for loading', () => {
    expect(workOverviewOf({ type: 'work/overview', overview: null })).toBeNull();
    expect(workOverviewOf({ type: 'work/overview', overview: { data: DATA, error: null } })).toEqual({ data: DATA, error: null });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['another type', { type: 'visibility', visible: true }],
    ['no overview', { type: 'work/overview' }],
    ['an overview missing its error', { type: 'work/overview', overview: { data: null } }],
    ['a string overview', { type: 'work/overview', overview: 'loading' }],
  ])('ignores %s', (_label, message) => {
    expect(workOverviewOf(message)).toBeUndefined();
  });
});
