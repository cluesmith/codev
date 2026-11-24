/**
 * Spec 1963: the shared Work view against a fake host. A control renders only when its host
 * provides the action, a slot renders only when the host passes it, and every action goes to the
 * host with what it needs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ArchitectState, OverviewBacklogItem, OverviewBuilder, OverviewData, OverviewRecentlyClosed } from '@cluesmith/codev-types';
import { WorkView } from '../components/WorkView.js';
import type { WorkViewHost } from '../host.js';
import { fakeWorkHost } from './fakeHost.js';

afterEach(() => {
  cleanup();
});

function makeBuilder(overrides: Partial<OverviewBuilder> = {}): OverviewBuilder {
  return {
    id: '42',
    issueId: '42',
    issueTitle: 'Fix the scan',
    phase: 'implement',
    protocolPhase: 'implement',
    mode: 'strict',
    gates: {},
    worktreePath: '/ws/.builders/spir-42',
    roleId: 'builder-spir-42',
    protocol: 'spir',
    planPhases: [],
    progress: 40,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: null,
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect: 'web',
    prReady: false,
    area: '',
    ...overrides,
  };
}

const BACKLOG: OverviewBacklogItem = {
  id: '401', title: 'Backlog feature', url: 'https://example.com/issues/401', type: 'project', priority: 'high', area: '',
  hasSpec: true, hasPlan: true, hasReview: false, hasBuilder: false, createdAt: new Date().toISOString(),
  specPath: 'codev/specs/401-backlog-feature.md', planPath: 'codev/plans/401-backlog-feature.md',
};

const CLOSED: OverviewRecentlyClosed = {
  id: '399', title: 'Closed feature', url: 'https://example.com/issues/399', type: 'project',
  closedAt: new Date().toISOString(), reviewPath: 'codev/reviews/399-closed-feature.md', prUrl: 'https://example.com/pull/398',
};

const architect = (name: string): ArchitectState => ({ name } as ArchitectState);

function makeOverview(overrides: Partial<OverviewData> = {}): OverviewData {
  return {
    builders: [makeBuilder()],
    pendingPRs: [],
    backlog: [BACKLOG],
    recentlyClosed: [CLOSED],
    architects: [architect('main')],
    heldCount: 0,
    mailboxEscalated: false,
    queuedFeedback: {},
    feedbackMode: 'forward',
    ...overrides,
  } as OverviewData;
}

function show(host: WorkViewHost, props: Omit<Parameters<typeof WorkView>[0], 'host'> = {}) {
  return render(<WorkView host={host} {...props} />);
}

describe('WorkView — loading and data', () => {
  it('shows the loading state while the host has no overview', () => {
    show(fakeWorkHost({ overview: null }));
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Work')).toBeNull();
  });

  it('renders the overview the host holds', () => {
    show(fakeWorkHost({ overview: { data: makeOverview(), error: null } }));
    expect(screen.getByRole('heading', { name: 'Work' })).toBeInTheDocument();
    expect(screen.getByText('Fix the scan')).toBeInTheDocument();
    expect(screen.getByText('Backlog feature')).toBeInTheDocument();
    expect(screen.getByText('Closed feature')).toBeInTheDocument();
  });

  it('shows the host\'s read error above the last overview it kept', () => {
    show(fakeWorkHost({ overview: { data: makeOverview(), error: 'Tower is not reachable' } }));
    expect(screen.getByText('Failed to load overview: Tower is not reachable')).toBeInTheDocument();
    expect(screen.getByText('Fix the scan')).toBeInTheDocument();
  });

  it('renders its sections empty before the first overview arrives', () => {
    show(fakeWorkHost({ overview: { data: null, error: null } }));
    expect(screen.getByText('No active builders')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
  });
});

describe('WorkView — controls follow the host\'s actions', () => {
  const data = makeOverview();

  it('shows every control a full host provides, each calling its action', () => {
    const host = fakeWorkHost({ overview: { data, error: null } });
    show(host);
    fireEvent.click(screen.getByRole('button', { name: '+ Shell' }));
    expect(host.newShell).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(host.refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(host.openBuilder).toHaveBeenCalledExactlyOnceWith(data.builders[0]);
    fireEvent.click(screen.getByRole('button', { name: 'spec' }));
    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    expect(host.openArtifact).toHaveBeenNthCalledWith(1, 'codev/specs/401-backlog-feature.md');
    expect(host.openArtifact).toHaveBeenNthCalledWith(2, 'codev/reviews/399-closed-feature.md');
  });

  it('hides Open when the host has no openBuilder', () => {
    show(fakeWorkHost({ overview: { data, error: null }, openBuilder: undefined }));
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByText('Fix the scan')).toBeInTheDocument();
  });

  it('hides + Shell when the host has no newShell, and Refresh when it has no refresh', () => {
    show(fakeWorkHost({ overview: { data, error: null }, newShell: undefined, refresh: undefined }));
    expect(screen.queryByRole('button', { name: '+ Shell' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('hides the spec / plan / review links when the host has no openArtifact, and keeps the PR link', () => {
    show(fakeWorkHost({ overview: { data, error: null }, openArtifact: undefined }));
    for (const name of ['spec', 'plan', 'review']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('link', { name: 'PR' })).toHaveAttribute('href', 'https://example.com/pull/398');
  });

  it('calls a class-based host\'s actions with the host as `this`', () => {
    class Host implements WorkViewHost {
      overview = { data, error: null };
      opened: string[] = [];
      openBuilder(builder: OverviewBuilder) { this.opened.push(builder.id); }
      openArtifact(path: string) { this.opened.push(path); }
    }
    const host = new Host();
    show(host);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'plan' }));
    expect(host.opened).toEqual(['42', 'codev/plans/401-backlog-feature.md']);
  });
});

describe('WorkView — slots', () => {
  const data = makeOverview();

  it('renders no slot content, no file panel and no file-panel class without slots', () => {
    const { container } = show(fakeWorkHost({ overview: { data, error: null } }));
    const root = container.querySelector('.work-view')!;
    expect(root.className).toBe('work-view ');
    expect(root.children).toHaveLength(1);
    expect(container.querySelector('.work-file-panel, .work-file-panel-search, .tip-banner')).toBeNull();
  });

  it('places the tip after the header and Open Files & Shells after Builders', () => {
    const { container } = show(fakeWorkHost({ overview: { data, error: null } }), {
      slots: { tip: <div data-testid="tip" />, openFilesShells: <section data-testid="ofs" /> },
    });
    const content = [...container.querySelector('.work-content')!.children];
    const at = (el: Element | null) => content.indexOf(el!);
    expect(at(screen.getByTestId('tip'))).toBe(at(container.querySelector('.work-header')) + 1);
    const builders = screen.getByText('Builders').closest('section');
    expect(at(screen.getByTestId('ofs'))).toBe(at(builders) + 1);
  });

  it('keeps the file panel\'s open state and marks the root while it is open', () => {
    const filePanel = vi.fn(({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) => (
      <button data-testid="panel" onClick={() => setOpen(!open)}>{open ? 'open' : 'closed'}</button>
    ));
    const { container } = show(fakeWorkHost({ overview: { data, error: null } }), { slots: { filePanel } });
    const root = container.querySelector('.work-view')!;
    expect(root.lastElementChild).toBe(screen.getByTestId('panel'));
    expect(screen.getByTestId('panel')).toHaveTextContent('closed');
    expect(root).not.toHaveClass('file-panel-open');

    fireEvent.click(screen.getByTestId('panel'));
    expect(screen.getByTestId('panel')).toHaveTextContent('open');
    expect(root).toHaveClass('file-panel-open');
  });
});

describe('WorkView — the attribution count (Spec 823)', () => {
  const data = makeOverview({ architects: [architect('main'), architect('web')] });

  it('counts the overview\'s live architects by default', () => {
    show(fakeWorkHost({ overview: { data, error: null } }));
    expect(screen.getByTitle('spawned by web')).toBeInTheDocument();
  });

  it('counts what the host passes instead, when it passes a count', () => {
    show(fakeWorkHost({ overview: { data, error: null } }), { architectCount: 1 });
    expect(screen.queryByTitle('spawned by web')).toBeNull();
  });
});
