/**
 * Spec 1963 Phase 4: the tree behaviours the Agents view owned alone, generalised over the two
 * views that render this window's agents (`views/agent-tree-hosts.ts`): row-click expand, the
 * per-view accordion, the follow-reveals, `builder-active`, the shared badge and the shared
 * settings. Also the periodic overview refresh's visibility gate (`views/overview-refresh-gate.ts`).
 *
 * The providers are the real `BuildersProvider` and `CockpitProvider`; only the tree views are
 * fakes, recording what the hosts ask of them. `extension.ts` cannot be activated in a unit test,
 * so its wiring is pinned at the source level (the convention workspace.test.ts uses).
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import type { ArchitectState, OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import type { TowerWorkspace } from '@cluesmith/codev-sdk/tower-client';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { FleetEntry } from '../views/tower-cache.js';
import type { BuilderFileChange } from '../views/builder-diff-cache.js';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MISSING_WORKTREE = join(tmpdir(), 'codev-test-missing-worktree');
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const configValues: Record<string, unknown> = {};

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire = vi.fn((e: T) => { this.listeners.forEach((l) => l(e)); });
    dispose = vi.fn();
  }
  class TreeItem {
    id?: string;
    tooltip?: string;
    description?: string;
    resourceUri?: unknown;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    constructor(public label: string, public collapsibleState?: number) {}
  }
  class ThemeIcon {
    static readonly Folder = new ThemeIcon('folder');
    constructor(public id: string, public color?: unknown) {}
  }
  class ThemeColor { constructor(public id: string) {} }
  return {
    EventEmitter: FakeEventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { from: (parts: unknown) => ({ ...(parts as object), toString: () => JSON.stringify(parts) }) },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, def: unknown) => (key in configValues ? configValues[key] : def),
      }),
    },
  };
});

const { AgentTreeHosts } = await import('../views/agent-tree-hosts.js');
const { OverviewRefreshGate } = await import('../views/overview-refresh-gate.js');
const { CockpitProvider, cockpitScope } = await import('../views/cockpit.js');
const { BuildersProvider } = await import('../views/builders.js');
const { BuilderTreeItem } = await import('../views/builder-tree-item.js');
const { workspaceActivityBadge } = await import('../mailbox-indicators.js');

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { for (const key of Object.keys(configValues)) { delete configValues[key]; } });

// ── Fixtures ──────────────────────────────────────────────────────────────────

function builder(id: string, owner: string): OverviewBuilder {
  return {
    id, issueId: id.split('-')[1], issueTitle: id, phase: 'implement', protocolPhase: 'implement',
    mode: 'strict', gates: {}, worktreePath: MISSING_WORKTREE, roleId: null, protocol: 'pir',
    planPhases: [], progress: 0, blocked: null, blockedGate: null, blockedSince: null,
    startedAt: null, idleMs: 0, lastDataAt: null, spawnedByArchitect: owner,
    area: 'Uncategorized', prReady: false,
  } as unknown as OverviewBuilder;
}

const DATA = {
  builders: [builder('pir-1', 'main'), builder('pir-2', 'main')],
  architects: [{ name: 'main', port: 0, pid: 0 } as ArchitectState],
  backlog: [], pendingPRs: [], recentlyClosed: [], heldCount: 0, mailboxEscalated: false, queuedFeedback: {},
} as unknown as OverviewData;

const FILE: BuilderFileChange = {
  change: { status: 'M', oldPath: null, path: 'src/a.ts' },
  plan: { resourcePath: 'src/a.ts', left: { kind: 'base', path: 'src/a.ts' }, right: { kind: 'file', path: 'src/a.ts' } },
} as BuilderFileChange;
const DIFFS = { getDiff: async () => ({ baseRef: 'main', files: [FILE] }) } as never;

const HERE = '/work/codev';
const OTHER = '/work/market';

function wsRow(path: string, name: string): TowerWorkspace {
  return { path, name, active: true, proxyUrl: '', terminals: 1 };
}
function entry(ws: TowerWorkspace, data: OverviewData): FleetEntry {
  return { workspace: ws, attention: deriveAttention(data), overview: data };
}

const noEvent = () => ({ dispose() {} });

/** A fake tree view: records reveals, lets a test fire expand / selection events. */
function fakeView(visible = false) {
  const expandListeners: Array<(e: { element: unknown }) => void> = [];
  const selectListeners: Array<(e: { selection: readonly unknown[] }) => void> = [];
  const visibilityListeners: Array<(e: unknown) => void> = [];
  const view = {
    visible,
    badge: undefined as vscode.ViewBadge | undefined,
    reveal: vi.fn(async (_element: unknown, _options?: unknown) => {}),
    onDidExpandElement: (l: (e: { element: unknown }) => void) => { expandListeners.push(l); return { dispose() {} }; },
    onDidChangeSelection: (l: (e: { selection: readonly unknown[] }) => void) => { selectListeners.push(l); return { dispose() {} }; },
    onDidChangeVisibility: (l: (e: unknown) => void) => { visibilityListeners.push(l); return { dispose() {} }; },
    expand: (element: unknown) => expandListeners.forEach(l => l({ element })),
    select: (element: unknown) => selectListeners.forEach(l => l({ selection: [element] })),
    setVisible: (on: boolean) => { view.visible = on; visibilityListeners.forEach(l => l({ visible: on })); },
  };
  return view;
}

/** The two real providers over one window, with fake views and the hosts between them. */
function setup(opts: { worktreeWindow?: boolean; agentsVisible?: boolean; cockpitVisible?: boolean; accordion?: boolean } = {}) {
  const overviewCache = { getData: () => DATA, onDidChange: noEvent };
  const agents = new BuildersProvider(overviewCache as never, DIFFS);
  const fleet = [entry(wsRow(HERE, 'codev'), DATA), entry(wsRow(OTHER, 'marketmaker'), DATA)];
  const cockpit = new CockpitProvider({
    connectionManager: { getState: () => 'connected', getWorkspacePath: () => HERE, onStateChange: noEvent } as never,
    towerCache: {
      getFleet: () => fleet, isLoaded: () => true, onDidChange: noEvent,
      getOverview: (path: string) => fleet.find(e => e.workspace.path === path)?.overview ?? null,
    } as never,
    overviewCache: overviewCache as never,
    diffCache: DIFFS,
    builderWorktreeWindow: opts.worktreeWindow ?? false,
    connection: 'auto',
  });
  const agentsView = fakeView(opts.agentsVisible ?? false);
  const cockpitView = fakeView(opts.cockpitVisible ?? false);
  const hosts = new AgentTreeHosts([
    { view: agentsView, rows: agents, revealWhenNoneVisible: true },
    { view: cockpitView, rows: cockpit },
  ], opts.accordion ?? true);
  hosts.wireAccordion();
  return { agents, cockpit, agentsView, cockpitView, hosts };
}

/** Every row under `node` in the Cockpit, depth-first. */
async function cockpitRows(cockpit: InstanceType<typeof CockpitProvider>): Promise<vscode.TreeItem[]> {
  const rows: vscode.TreeItem[] = [];
  const visit = async (node?: Parameters<typeof cockpit.getChildren>[0]): Promise<void> => {
    for (const child of await cockpit.getChildren(node)) {
      const item = cockpit.getTreeItem(child);
      rows.push(item);
      if (item.collapsibleState) { await visit(child); }
    }
  };
  await visit();
  return rows;
}

async function cockpitBuilderRow(cockpit: InstanceType<typeof CockpitProvider>, scope: string, id: string) {
  const row = (await cockpitRows(cockpit)).find(r => r instanceof BuilderTreeItem && r.scope === scope && r.builderId === id);
  if (!row) { throw new Error(`no ${scope}${id} row`); }
  return row as InstanceType<typeof BuilderTreeItem>;
}

const EXT_SRC = readFileSync(resolve(__dirname, '../extension.ts'), 'utf8');

// ── Row click ─────────────────────────────────────────────────────────────────

describe('codev.openBuilderRow expands the row in its own view', () => {
  it('an Agents row in the Agents view, a Cockpit row in the Cockpit', async () => {
    const { agents, cockpit, agentsView, cockpitView, hosts } = setup();
    const agentsRow = agents.revealTargetForAgent({ kind: 'builder', id: 'pir-1' }) as InstanceType<typeof BuilderTreeItem>;
    await hosts.expandRow(agentsRow);
    expect(agentsView.reveal).toHaveBeenCalledWith(agentsRow, { expand: true, select: false, focus: false });
    expect(cockpitView.reveal).not.toHaveBeenCalled();

    agentsView.reveal.mockClear();
    const cockpitRow = await cockpitBuilderRow(cockpit, cockpitScope(HERE), 'pir-1');
    await hosts.expandRow(cockpitRow);
    expect(cockpitView.reveal).toHaveBeenCalledWith(cockpitRow, { expand: true, select: false, focus: false });
    expect(agentsView.reveal).not.toHaveBeenCalled();
  });

  it("another workspace's row belongs to no acting host, so nothing expands", async () => {
    const { cockpit, agentsView, cockpitView, hosts } = setup();
    const remote = await cockpitBuilderRow(cockpit, cockpitScope(OTHER), 'pir-1');
    await hosts.expandRow(remote);
    expect(agentsView.reveal).not.toHaveBeenCalled();
    expect(cockpitView.reveal).not.toHaveBeenCalled();
  });

  it('extension.ts routes the click through the hosts', () => {
    expect(EXT_SRC).toMatch(/expandRow: \(\) => hosts\.expandRow\(item\)/);
  });
});

// ── Accordion ─────────────────────────────────────────────────────────────────

describe('the accordion runs per view', () => {
  it("expanding a Cockpit builder re-versions the Cockpit's rows only, and vice versa", async () => {
    const { agents, cockpit, agentsView, cockpitView } = setup();
    const agentsCollapse = vi.spyOn(agents, 'collapseBuildersExcept');
    const cockpitCollapse = vi.spyOn(cockpit, 'collapseBuildersExcept');

    const cockpitRow = await cockpitBuilderRow(cockpit, cockpitScope(HERE), 'pir-1');
    cockpitView.expand(cockpitRow);
    expect(cockpitCollapse).toHaveBeenCalledWith(cockpitRow);
    expect(agentsCollapse).not.toHaveBeenCalled();

    // The same builder in the Agents view: its own gate has not seen it, so it collapses there.
    const agentsRow = agents.revealTargetForAgent({ kind: 'builder', id: 'pir-1' }) as InstanceType<typeof BuilderTreeItem>;
    agentsView.expand(agentsRow);
    expect(agentsCollapse).toHaveBeenCalledWith(agentsRow);
    expect(cockpitCollapse).toHaveBeenCalledTimes(1);

    // Each gate suppresses the re-fire of its own open row.
    cockpitView.expand(cockpitRow);
    agentsView.expand(agentsRow);
    expect(cockpitCollapse).toHaveBeenCalledTimes(1);
    expect(agentsCollapse).toHaveBeenCalledTimes(1);
  });

  it('a row expanded in the wrong view, or a remote row, is ignored', async () => {
    const { agents, cockpit, agentsView, cockpitView } = setup();
    const cockpitCollapse = vi.spyOn(cockpit, 'collapseBuildersExcept');
    const agentsCollapse = vi.spyOn(agents, 'collapseBuildersExcept');
    agentsView.expand(await cockpitBuilderRow(cockpit, cockpitScope(HERE), 'pir-1'));
    cockpitView.expand(await cockpitBuilderRow(cockpit, cockpitScope(OTHER), 'pir-1'));
    expect(cockpitCollapse).not.toHaveBeenCalled();
    expect(agentsCollapse).not.toHaveBeenCalled();
  });

  it('codev.buildersAutoCollapse re-gates both views', async () => {
    const { agents, cockpit, agentsView, cockpitView, hosts } = setup();
    const agentsCollapse = vi.spyOn(agents, 'collapseBuildersExcept');
    const cockpitCollapse = vi.spyOn(cockpit, 'collapseBuildersExcept');
    const agentsRow = agents.revealTargetForAgent({ kind: 'builder', id: 'pir-1' }) as InstanceType<typeof BuilderTreeItem>;
    const cockpitRow = await cockpitBuilderRow(cockpit, cockpitScope(HERE), 'pir-1');

    hosts.setAccordionEnabled(false);
    agentsView.expand(agentsRow);
    cockpitView.expand(cockpitRow);
    expect(agentsCollapse).not.toHaveBeenCalled();
    expect(cockpitCollapse).not.toHaveBeenCalled();

    hosts.setAccordionEnabled(true);
    agentsView.expand(agentsRow);
    cockpitView.expand(cockpitRow);
    expect(agentsCollapse).toHaveBeenCalledTimes(1);
    expect(cockpitCollapse).toHaveBeenCalledTimes(1);
  });

  it('extension.ts wires the accordion and its setting through the hosts', () => {
    expect(EXT_SRC).toMatch(/\.\.\.hosts\.wireAccordion\(\)/);
    expect(EXT_SRC).toMatch(/affectsConfiguration\('codev\.buildersAutoCollapse'\)[\s\S]{0,120}hosts\.setAccordionEnabled\(on\);/);
    expect(EXT_SRC).not.toMatch(/new AccordionGate\(/);
  });
});

// ── Shared settings ───────────────────────────────────────────────────────────

describe('codev.buildersFileViewAsTree redraws both views', () => {
  it('refreshAll fires both providers', () => {
    const { agents, cockpit, hosts } = setup();
    const agentsFired = vi.fn();
    const cockpitFired = vi.fn();
    agents.onDidChangeTreeData(agentsFired);
    cockpit.onDidChangeTreeData(cockpitFired);
    hosts.refreshAll();
    expect(agentsFired).toHaveBeenCalledTimes(1);
    expect(cockpitFired).toHaveBeenCalledTimes(1);
  });

  it('extension.ts calls it from the setting listener', () => {
    expect(EXT_SRC).toMatch(/affectsConfiguration\('codev\.buildersFileViewAsTree'\)[\s\S]{0,300}hosts\.refreshAll\(\);/);
  });
});

// ── Follow-reveals ────────────────────────────────────────────────────────────

describe('active-file and agent-cycle reveals follow the visible view', () => {
  it('only the Cockpit visible: reveal there, not in the hidden Agents view', async () => {
    const { agentsView, cockpitView, hosts } = setup({ cockpitVisible: true });
    await hosts.revealFile('pir-1', 'src/a.ts', () => true);
    await hosts.revealAgent({ kind: 'builder', id: 'pir-2' });
    expect(agentsView.reveal).not.toHaveBeenCalled();
    const revealed = cockpitView.reveal.mock.calls.map(c => (c[0] as vscode.TreeItem).id);
    expect(revealed).toEqual([`${cockpitScope(HERE)}pir-1::src/a.ts`, expect.stringMatching(/^ws:\/work\/codev\|pir-2#\d+$/)]);
  });

  it('both visible: reveal in both', async () => {
    const { agentsView, cockpitView, hosts } = setup({ agentsVisible: true, cockpitVisible: true });
    await hosts.revealAgent({ kind: 'architect', name: 'main' });
    expect((agentsView.reveal.mock.calls[0][0] as vscode.TreeItem).id).toBe('builder-group:main');
    expect((cockpitView.reveal.mock.calls[0][0] as vscode.TreeItem).id).toBe(`${cockpitScope(HERE)}builder-group:main`);
  });

  it('none visible: the Agents view reveals, as before the Cockpit', async () => {
    const { agentsView, cockpitView, hosts } = setup();
    await hosts.revealFile('pir-1', 'src/a.ts', () => true);
    expect((agentsView.reveal.mock.calls[0][0] as vscode.TreeItem).id).toBe('pir-1::src/a.ts');
    expect(cockpitView.reveal).not.toHaveBeenCalled();
  });

  it('a Cockpit with nothing acting here (worktree window) is skipped even when visible', async () => {
    const { agentsView, cockpitView, hosts } = setup({ worktreeWindow: true, cockpitVisible: true });
    await hosts.revealAgent({ kind: 'builder', id: 'pir-1' });
    expect(cockpitView.reveal).not.toHaveBeenCalled();
    expect(agentsView.reveal).toHaveBeenCalledTimes(1);
  });

  it('a newer active editor stops a slow lookup from revealing', async () => {
    const { cockpitView, hosts } = setup({ cockpitVisible: true });
    await hosts.revealFile('pir-1', 'src/a.ts', () => false);
    expect(cockpitView.reveal).not.toHaveBeenCalled();
  });

  it('extension.ts routes both reveals through the hosts', () => {
    expect(EXT_SRC).toMatch(/await hosts\.revealFile\(entry\.builderId, entry\.relPath,/);
    expect(EXT_SRC).toMatch(/await hosts\.revealAgent\(target\);/);
  });
});

// ── builder-active ────────────────────────────────────────────────────────────

describe('selection fires builder-active in either view, for acting rows only', () => {
  it('Agents and Cockpit acting rows fire; another workspace row does not', async () => {
    const { agents, cockpit, agentsView, cockpitView, hosts } = setup();
    const fired = vi.fn();
    hosts.wireSelection(fired);
    agentsView.select(agents.revealTargetForAgent({ kind: 'builder', id: 'pir-1' }));
    cockpitView.select(await cockpitBuilderRow(cockpit, cockpitScope(HERE), 'pir-2'));
    cockpitView.select(await cockpitBuilderRow(cockpit, cockpitScope(OTHER), 'pir-1'));
    cockpitView.select(cockpit.revealTargetForAgent({ kind: 'architect', name: 'main' }));
    expect(fired.mock.calls).toEqual([['pir-1'], ['pir-2']]);
  });
});

// ── Badge ─────────────────────────────────────────────────────────────────────

describe('the activity badge', () => {
  const blocked = { ...DATA, builders: [{ ...builder('pir-9', 'main'), blocked: 'plan review', blockedGate: 'plan-approval' }] } as OverviewData;

  it('is the same value on both views', () => {
    const { agentsView, cockpitView, hosts } = setup();
    const badge = workspaceActivityBadge(blocked, { connected: true, builderWorktreeWindow: false });
    expect(badge).toEqual({ value: 1, tooltip: '1 builder blocked at a human-approval gate' });
    hosts.setBadge(badge);
    expect(agentsView.badge).toBe(badge);
    expect(cockpitView.badge).toBe(badge);
    hosts.setBadge(undefined);
    expect(agentsView.badge).toBeUndefined();
    expect(cockpitView.badge).toBeUndefined();
  });

  it('clears on a disconnect and repaints on reconnect, though the overview keeps its data', () => {
    const { agentsView, cockpitView, hosts } = setup();
    // What extension.ts's `updateActivityBadge` does, driven by the connection state alone.
    let state = 'connected';
    const update = () => hosts.setBadge(workspaceActivityBadge(blocked, { connected: state === 'connected', builderWorktreeWindow: false }));
    update();
    expect(agentsView.badge?.value).toBe(1);
    expect(cockpitView.badge?.value).toBe(1);
    state = 'reconnecting';
    update();
    expect(agentsView.badge).toBeUndefined();
    expect(cockpitView.badge).toBeUndefined();
    state = 'connected';
    update();
    expect(cockpitView.badge?.value).toBe(1);
  });

  it('extension.ts repaints the badge on every connection-state change', () => {
    expect(EXT_SRC).toMatch(/context\.subscriptions\.push\(connectionManager\.onStateChange\(\(\) => updateActivityBadge\(\)\)\);/);
  });

  it('extension.ts gives the Cockpit its connection mode from the policy and codev.autoConnect', () => {
    expect(EXT_SRC).toMatch(/connection: cockpitConnectionMode\(\s*policy\.initializeConnection,\s*vscode\.workspace\.getConfiguration\('codev'\)\.get<boolean>\('autoConnect', true\),\s*\),/);
  });

  it('is suppressed when disconnected, with no data, and in a builder-worktree window', () => {
    expect(workspaceActivityBadge(blocked, { connected: false, builderWorktreeWindow: false })).toBeUndefined();
    expect(workspaceActivityBadge(null, { connected: true, builderWorktreeWindow: false })).toBeUndefined();
    expect(workspaceActivityBadge(blocked, { connected: true, builderWorktreeWindow: true })).toBeUndefined();
  });
});

// ── Periodic overview refresh ─────────────────────────────────────────────────

describe('the periodic overview refresh counts the Cockpit', () => {
  function gate(views: ReturnType<typeof fakeView>[], seconds = 60) {
    const onTick = vi.fn();
    const onResume = vi.fn();
    const g = new OverviewRefreshGate(views, () => seconds, onTick, onResume);
    g.wire();
    return { g, onTick, onResume };
  }

  it('runs with only the Cockpit visible and stops when nothing is', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const agents = fakeView(false);
      const lists = [fakeView(false), fakeView(false), fakeView(false)];
      const cockpit = fakeView(false);
      const { g, onTick, onResume } = gate([agents, ...lists, cockpit]);
      g.reconcile();
      expect(g.isRunning()).toBe(false);

      cockpit.setVisible(true);
      expect(g.isRunning()).toBe(true);
      expect(onResume).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(onTick).toHaveBeenCalledTimes(1);

      cockpit.setVisible(false);
      expect(g.isRunning()).toBe(false);
      vi.advanceTimersByTime(120_000);
      expect(onTick).toHaveBeenCalledTimes(1);
    } finally {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    }
  });

  it('stays off at a 0 s cadence, and restarts at a new cadence', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const view = fakeView(true);
      let seconds = 0;
      const onTick = vi.fn();
      const g = new OverviewRefreshGate([view], () => seconds, onTick, () => {});
      g.reconcile();
      expect(g.isRunning()).toBe(false);
      seconds = 60;
      g.restart();
      expect(g.isRunning()).toBe(true);
      // Changing the cadence while running replaces the 60 s timer with a 10 s one.
      seconds = 10;
      g.restart();
      vi.advanceTimersByTime(10_000);
      expect(onTick).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(50_000);
      expect(onTick).toHaveBeenCalledTimes(6);
      g.dispose();
      expect(g.isRunning()).toBe(false);
    } finally {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    }
  });

  it('extension.ts gates on the four list views and the Cockpit', () => {
    expect(EXT_SRC).toMatch(/new OverviewRefreshGate\(\s*\[buildersView, pullRequestsView, backlogView, recentlyClosedView, cockpitView\],/);
    expect(EXT_SRC).toMatch(/\.\.\.overviewRefreshGate\.wire\(\)/);
  });
});
