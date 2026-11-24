/**
 * Spec 1963: the dashboard's Work tab is the shared view with the dashboard as its host. This
 * renders the dashboard's own wrapper with the real overview hook and `lib/api.ts`, with only
 * `fetch` faked, so it checks the wrapper's action mapping, which nothing else pins at this level
 * (the view's own behaviour is tested in the package against a fake host):
 * - *Open* selects the builder's terminal tab (`findBuilderTab`, by role id), through `onSelectTab`;
 * - *+ Shell* POSTs `api/tabs/shell`, then refreshes the dashboard state;
 * - a spec link POSTs `api/tabs/file` with its path, then refreshes the dashboard state.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { WorkView } from '../src/components/WorkView.js';
import type { DashboardState } from '../src/lib/api.js';

const BUILDER: OverviewBuilder = {
  id: '42', issueId: '42', issueTitle: 'Fix the scan', phase: 'implement', protocolPhase: 'implement',
  mode: 'strict', gates: {}, worktreePath: '/ws/.builders/spir-42', roleId: 'builder-spir-42',
  protocol: 'spir', planPhases: [], progress: 40, blocked: null, blockedGate: null, blockedSince: null,
  startedAt: null, idleMs: 0, lastDataAt: null, spawnedByArchitect: 'main', prReady: false, area: '',
};

const OVERVIEW = {
  builders: [BUILDER],
  pendingPRs: [],
  backlog: [{
    id: '401', title: 'Backlog feature', url: 'https://example.com/issues/401', type: 'project', priority: 'high',
    area: '', hasSpec: true, hasPlan: false, hasReview: false, hasBuilder: false, createdAt: new Date().toISOString(),
    specPath: 'codev/specs/401-backlog-feature.md',
  }],
  recentlyClosed: [],
  architects: [],
  heldCount: 0,
  mailboxEscalated: false,
  queuedFeedback: {},
  feedbackMode: 'forward',
} as unknown as OverviewData;

/** The dashboard state: the builder's terminal tab, keyed by its role id, beside an unrelated one. */
const STATE = {
  architect: null,
  architects: [],
  builders: [
    { id: 'builder-spir-7', name: 'Builder 7' },
    { id: 'builder-spir-42', name: 'Builder 42' },
  ],
  utils: [],
  annotations: [],
  workspaceName: 'test',
} as unknown as DashboardState;

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function posts(endpoint: string) {
  return fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(endpoint) && init?.method === 'POST');
}

async function show() {
  const onSelectTab = vi.fn();
  const onRefresh = vi.fn();
  render(<WorkView state={STATE} onRefresh={onRefresh} onSelectTab={onSelectTab} />);
  await screen.findByText('Fix the scan');
  return { onSelectTab, onRefresh };
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith('api/overview')) return json(OVERVIEW);
    if (path.endsWith('api/tabs/shell') && init?.method === 'POST') return json({ id: 'shell-1', port: 0, name: 'Shell 1' });
    if (path.endsWith('api/tabs/file') && init?.method === 'POST') return json({ id: 'file-1', existing: false });
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the dashboard's Work tab maps the shared view's actions to the dashboard", () => {
  it("Open selects the builder's own terminal tab, found by its role id", async () => {
    const { onSelectTab, onRefresh } = await show();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith('builder-spir-42');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('+ Shell creates a shell tab, then refreshes the dashboard state', async () => {
    const { onRefresh } = await show();
    fireEvent.click(screen.getByRole('button', { name: '+ Shell' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(posts('api/tabs/shell')).toHaveLength(1);
  });

  it('a spec link opens the file in a dashboard tab, then refreshes the dashboard state', async () => {
    const { onRefresh } = await show();
    fireEvent.click(screen.getByRole('button', { name: 'spec' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    const [call] = posts('api/tabs/file');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ path: 'codev/specs/401-backlog-feature.md' });
  });
});
