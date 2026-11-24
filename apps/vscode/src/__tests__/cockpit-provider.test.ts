/**
 * Spec 1963 Phase 4: the Codev Cockpit's single hierarchy (`views/cockpit.ts`),
 * Tower → workspaces → architects → builders → (this window's workspace only) changed files.
 *
 * Fake caches stand in for `ConnectionManager`, `TowerFleetCache` and `OverviewCache`; the row
 * building underneath is the real `ArchitectTreeBuilder` and the real `TowerProvider` row code, so
 * the comparisons below are against what the Agents and Tower views actually render.
 *
 * Mocks `vscode` per the established `__tests__` pattern (see architect-tree.test.ts).
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import type { ArchitectState, OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import type { TowerWorkspace } from '@cluesmith/codev-sdk/tower-client';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { FleetEntry } from '../views/tower-cache.js';
import type { BuilderFileChange } from '../views/builder-diff-cache.js';
import type { ResolvedWorktreeConfig } from '../load-worktree-config.js';
import type { AgentTarget } from '../views/architect-tree.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MISSING_WORKTREE = join(tmpdir(), 'codev-test-missing-worktree');
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

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

const { CockpitProvider, COCKPIT_IDS, cockpitScope, cockpitConnectionMode, cockpitWorkspaceContext } = await import('../views/cockpit.js');
const { TowerProvider, OPEN_WORKSPACE_COMMAND } = await import('../views/tower.js');
const { BuildersProvider } = await import('../views/builders.js');
const { REMOTE_CONTEXT } = await import('../views/architect-tree.js');
const { BuilderTreeItem, BuilderGroupTreeItem, IdleArchitectsGroupTreeItem } = await import('../views/builder-tree-item.js');
const { BuilderFileTreeItem } = await import('../views/builder-file-tree-item.js');
const { BuilderFolderTreeItem } = await import('../views/builder-folder-tree-item.js');

type Provider = InstanceType<typeof CockpitProvider>;
type Node = Parameters<Provider['getTreeItem']>[0];

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { for (const key of Object.keys(configValues)) { delete configValues[key]; } });

// ── Fixtures ──────────────────────────────────────────────────────────────────

function builder(overrides: Partial<OverviewBuilder>): OverviewBuilder {
  return {
    id: 'pir-1', issueId: '1', issueTitle: 't', phase: 'implement', protocolPhase: 'implement',
    mode: 'strict', gates: {}, worktreePath: MISSING_WORKTREE, roleId: null, protocol: 'pir',
    planPhases: [], progress: 0, blocked: null, blockedGate: null, blockedSince: null,
    startedAt: null, idleMs: 0, lastDataAt: null, spawnedByArchitect: null,
    area: 'Uncategorized', prReady: false,
    ...overrides,
  } as OverviewBuilder;
}

function servedState(state: string, since: string) {
  return { state, since, source: 'harness', alive: state !== 'dead', activity: null, activityAt: since, backgroundWork: false };
}

function architect(name: string, state?: string, since = ago(7)): ArchitectState {
  if (!state) { return { name, port: 0, pid: 0 } as ArchitectState; }
  return { name, port: 0, pid: 0, terminalId: 't', lastDataAt: since, agentState: servedState(state, since) } as unknown as ArchitectState;
}

function overview(builders: OverviewBuilder[], architects: ArchitectState[], extra: Partial<OverviewData> = {}): OverviewData {
  return {
    builders, architects, backlog: [], pendingPRs: [], recentlyClosed: [],
    heldCount: 0, mailboxEscalated: false, queuedFeedback: {},
    ...extra,
  } as unknown as OverviewData;
}

function mk(relPath: string): BuilderFileChange {
  return {
    change: { status: 'M', oldPath: null, path: relPath },
    plan: { resourcePath: relPath, left: { kind: 'base', path: relPath }, right: { kind: 'file', path: relPath } },
  } as BuilderFileChange;
}

const DIFFS = {
  getDiff: async (builderId: string) => {
    const files: Record<string, BuilderFileChange[]> = {
      'spir-10': [mk('README.md'), mk('src/views/a.ts'), mk('src/views/b.ts')],
      'pir-1': [mk('src/only.ts')],
      'bugfix-12': [mk('packages/x/y.ts')],
    };
    return { baseRef: 'main', files: files[builderId] ?? [] };
  },
} as never;

/**
 * N>1: a gated builder of `main`, a null-owner builder (folds into `main`), a sibling `web` with a
 * held + queued builder and a silent one, a builder of a non-live architect `ghost`, and two idle
 * siblings (`demos`, `reviewer`) that roll up into *Idle Architects*.
 */
const MANY = overview(
  [
    builder({ id: 'spir-10', issueId: '10', issueTitle: 'gated', protocol: 'spir', protocolPhase: 'plan',
      spawnedByArchitect: 'main', blocked: 'plan review', blockedGate: 'plan-approval', blockedSince: ago(120) }),
    builder({ id: 'air-11', issueId: '11', issueTitle: 'orphan', protocol: 'air', spawnedByArchitect: null,
      agentState: servedState('idle', ago(30)) as never }),
    builder({ id: 'bugfix-12', issueId: '12', issueTitle: 'busy', protocol: 'bugfix', protocolPhase: 'pr',
      spawnedByArchitect: 'web', heldCount: 2 }),
    builder({ id: 'pir-13', issueId: '13', issueTitle: 'asks', protocol: 'pir', spawnedByArchitect: 'ghost',
      worktreePath: '', agentState: servedState('needs-input', ago(5)) as never }),
    builder({ id: 'aspir-14', issueId: '14', issueTitle: 'quiet', protocol: 'aspir', spawnedByArchitect: 'web',
      lastDataAt: ago(600) }),
  ],
  [architect('main'), architect('web'), architect('demos'), architect('reviewer')],
  { heldCount: 3, queuedFeedback: { 'bugfix-12': 4 } },
);
const ONE = overview([builder({ id: 'pir-1', issueTitle: 'solo', spawnedByArchitect: 'main' })], [architect('main'), architect('reviewer')]);
const NONE = overview([], [architect('main')]);
const QUIET = overview([], [architect('main')]);

function wsRow(path: string, name: string, active: boolean): TowerWorkspace {
  return { path, name, active, proxyUrl: `http://localhost/${name}`, terminals: active ? 1 : 0 };
}

function entry(ws: TowerWorkspace, data: OverviewData | null): FleetEntry {
  return { workspace: ws, attention: deriveAttention(data), overview: data };
}

const HERE = '/work/codev';
const OTHER = '/work/market';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface WorldOptions {
  fleet?: FleetEntry[];
  loaded?: boolean;
  here?: OverviewData | null;
  windowPath?: string | null;
  state?: ConnectionState;
  worktreeWindow?: boolean;
  connection?: 'auto' | 'manual' | 'none';
  /** The folder this window is rooted at (a worktree's own path in a builder-worktree window). */
  windowRoot?: string | null;
  config?: ResolvedWorktreeConfig | null;
  devs?: Array<{ builderId: string; terminalId: string }>;
}

/** The mutable state the fakes read, and the events the Cockpit subscribes to. */
interface World {
  fleet: FleetEntry[];
  loaded: boolean;
  here: OverviewData | null;
  windowPath: string | null;
  state: ConnectionState;
  /** What the next `loadWorktreeConfig` resolves to. */
  config: ResolvedWorktreeConfig | null;
  /** The dev terminals running now. */
  devs: Array<{ builderId: string; terminalId: string }>;
  loadWorktreeConfig: ReturnType<typeof vi.fn>;
  /** How many times the Cockpit asked its view to redraw. */
  redraws(): number;
  fireFleet(): void;
  fireOverview(): void;
  setState(state: ConnectionState): void;
  /** Deliver one SSE envelope of this `type`, as Tower sends it (JSON in `data`, no event name). */
  fireSSE(type: string): void;
  /** Deliver one SSE event with this raw `data`. */
  fireRawSSE(data: string): void;
  fireDevTerminals(): void;
  provider: Provider;
}

/** A Cockpit over fake caches whose state a test can change. */
function world(opts: WorldOptions = {}): World {
  const listeners = {
    fleet: [] as Array<() => void>,
    overview: [] as Array<() => void>,
    state: [] as Array<(s: string) => void>,
    sse: [] as Array<(e: { type: string; data: string }) => void>,
    devs: [] as Array<() => void>,
  };
  const sub = <T>(list: T[], l: T) => { list.push(l); return { dispose() { list.splice(list.indexOf(l), 1); } }; };
  const w: World = {
    fleet: opts.fleet ?? [],
    loaded: opts.loaded ?? true,
    here: opts.here === undefined ? null : opts.here,
    windowPath: opts.windowPath === undefined ? HERE : opts.windowPath,
    state: opts.state ?? 'connected',
    config: opts.config ?? null,
    devs: opts.devs ?? [],
    loadWorktreeConfig: vi.fn(async () => w.config),
    redraws: () => redraws,
    fireFleet: () => listeners.fleet.forEach(l => l()),
    fireOverview: () => listeners.overview.forEach(l => l()),
    setState: (s: ConnectionState) => { w.state = s; listeners.state.forEach(l => l(s)); },
    fireSSE: (type: string) => w.fireRawSSE(JSON.stringify({ type })),
    fireRawSSE: (data: string) => listeners.sse.forEach(l => l({ type: '', data })),
    fireDevTerminals: () => listeners.devs.forEach(l => l()),
    provider: undefined as unknown as Provider,
  };
  let redraws = 0;
  w.provider = new CockpitProvider({
    connectionManager: {
      getState: () => w.state,
      getWorkspacePath: () => w.windowPath,
      getWindowRoot: () => (opts.windowRoot === undefined ? w.windowPath : opts.windowRoot),
      onStateChange: (l: (s: string) => void) => sub(listeners.state, l),
      onSSEEvent: (l: (e: { type: string; data: string }) => void) => sub(listeners.sse, l),
    } as never,
    terminalManager: {
      listDevTerminals: () => w.devs,
      onDidChangeDevTerminals: (l: () => void) => sub(listeners.devs, l),
    },
    loadWorktreeConfig: w.loadWorktreeConfig as never,
    towerCache: {
      getFleet: () => w.fleet,
      isLoaded: () => w.loaded,
      getOverview: (path: string) => w.fleet.find(e => e.workspace.path === path)?.overview ?? null,
      onDidChange: (l: () => void) => sub(listeners.fleet, l),
    } as never,
    overviewCache: {
      getData: () => w.here,
      onDidChange: (l: () => void) => sub(listeners.overview, l),
    } as never,
    diffCache: DIFFS,
    builderWorktreeWindow: opts.worktreeWindow ?? false,
    connection: opts.connection ?? 'auto',
  });
  w.provider.onDidChangeTreeData(() => { redraws += 1; });
  return w;
}

// ── Walk helpers ──────────────────────────────────────────────────────────────

const item = (p: Provider, n: Node) => p.getTreeItem(n);
const labelOf = (p: Provider, n: Node) => String(item(p, n).label);

async function towerRows(p: Provider): Promise<Node[]> {
  const [root] = await p.getChildren();
  return p.getChildren(root);
}

/** The workspace node with this label, among the Tower root's (and Dormant's) children. */
async function workspaceNode(p: Provider, label: string): Promise<Node> {
  for (const n of await towerRows(p)) {
    if (labelOf(p, n) === label) { return n; }
    if (item(p, n).id === COCKPIT_IDS.dormant) {
      const inside = (await p.getChildren(n)).find(d => labelOf(p, d) === label);
      if (inside) { return inside; }
    }
  }
  throw new Error(`no workspace row '${label}'`);
}

/** Every row under `node`, depth-first, expanding everything with a chevron. */
async function subtree(p: Provider, node: Node): Promise<Array<{ node: Node; depth: number }>> {
  const rows: Array<{ node: Node; depth: number }> = [];
  const visit = async (n: Node, depth: number): Promise<void> => {
    for (const child of await p.getChildren(n)) {
      rows.push({ node: child, depth });
      if (item(p, child).collapsibleState) { await visit(child, depth + 1); }
    }
  };
  await visit(node, 0);
  return rows;
}

/** The whole tree, depth-first, as items. */
async function wholeTree(p: Provider): Promise<vscode.TreeItem[]> {
  const [root] = await p.getChildren();
  return [item(p, root), ...(await subtree(p, root)).map(r => item(p, r.node))];
}

/**
 * What VS Code's `TreeView.reveal` does with a provider: walk `getParent` to the root, then
 * descend from the root matching each ancestor among its parent's children by id. Returns the id
 * path, or throws where the chain breaks.
 */
async function revealPath(p: Provider, element: Node): Promise<string[]> {
  const chain: Node[] = [];
  let current: Node = element;
  for (;;) {
    const parent = await p.getParent(current);
    if (!parent) { break; }
    chain.unshift(parent);
    current = parent;
  }
  const path: string[] = [];
  let level = await p.getChildren();
  for (const node of [...chain, element]) {
    const id = item(p, node).id;
    const match = level.find(n => item(p, n).id === id);
    if (!id || !match) {
      throw new Error(`reveal: '${id}' is not among the children of '${path.at(-1) ?? 'root'}' (${level.map(n => item(p, n).id).join(', ')})`);
    }
    path.push(id);
    level = await p.getChildren(match);
  }
  return path;
}

function stripScope(id: string | undefined, scope: string): string | undefined {
  if (id === undefined) { return undefined; }
  expect(id.startsWith(scope)).toBe(true);
  return id.slice(scope.length);
}

/**
 * A row's rendered shape, minus what the Cockpit's `attention` option may change on purpose: the
 * description (attention counts) on every row, and an architect row's icon (a waiting architect
 * shows its wait glyph, `applyArchitectAttention`). Builder and file rows keep the Agents icon.
 */
function shape(row: vscode.TreeItem, scope: string) {
  const command = row.command as { command: string; arguments?: unknown[] } | undefined;
  let icon: vscode.TreeItem['iconPath'] | '<architect attention>' = row.iconPath;
  if (row instanceof BuilderGroupTreeItem) { icon = '<architect attention>'; }
  return {
    id: stripScope(row.id, scope),
    label: row.label,
    state: row.collapsibleState,
    icon,
    tooltip: row.tooltip,
    command: command?.command,
    commandArgs: command?.arguments?.map(a => (a === row ? '<self>' : a)),
  };
}

/** A workspace's rows below its architects: asserts the last is its Decisions entry, and drops it. */
function withoutDecisions(rows: vscode.TreeItem[], path: string): vscode.TreeItem[] {
  expect(rows.at(-1)?.id).toBe(COCKPIT_IDS.decisions(path));
  return rows.slice(0, -1);
}

// ── Tower root ────────────────────────────────────────────────────────────────

describe('Tower root and its state rows', () => {
  it('is one expanded Tower row with a stable id', async () => {
    const w = world({ fleet: [], loaded: true });
    const roots = await w.provider.getChildren();
    expect(roots).toHaveLength(1);
    const root = item(w.provider, roots[0]);
    expect(root).toMatchObject({ label: 'Tower', id: COCKPIT_IDS.tower, collapsibleState: 2 });
    expect(await w.provider.getParent(roots[0])).toBeUndefined();
  });

  it('says Connecting… during the first attempt, and while connected before the fleet loads', async () => {
    const w = world({ loaded: false, state: 'disconnected' });
    expect((await towerRows(w.provider)).map(n => labelOf(w.provider, n))).toEqual(['Connecting to Tower…']);
    w.setState('connecting');
    expect(labelOf(w.provider, (await towerRows(w.provider))[0])).toBe('Connecting to Tower…');
    w.setState('connected');
    expect(labelOf(w.provider, (await towerRows(w.provider))[0])).toBe('Connecting to Tower…');
  });

  it('says Not connected once an attempt fails, with Reconnect on click, and keeps saying it while retrying', async () => {
    const w = world({ loaded: false, state: 'connecting' });
    w.setState('disconnected');
    const [row] = await towerRows(w.provider);
    expect(item(w.provider, row)).toMatchObject({
      label: 'Not connected to Tower',
      command: { command: 'codev.reconnect', title: 'Reconnect to Tower' },
    });
    w.setState('reconnecting');
    expect(labelOf(w.provider, (await towerRows(w.provider))[0])).toBe('Not connected to Tower');
    // A backoff retry is another attempt, not the first: the row does not flip back.
    w.setState('connecting');
    expect(labelOf(w.provider, (await towerRows(w.provider))[0])).toBe('Not connected to Tower');
    expect(await w.provider.getParent(row)).toEqual({ kind: 'tower-root' });
    // Connected again, before the fleet's first load lands: connecting, not "not connected".
    w.setState('connected');
    expect(labelOf(w.provider, (await towerRows(w.provider))[0])).toBe('Connecting to Tower…');
  });

  it('knows an attempt already failed when created while reconnecting', async () => {
    const w = world({ loaded: false, state: 'reconnecting' });
    expect(labelOf(w.provider, (await towerRows(w.provider))[0])).toBe('Not connected to Tower');
  });

  it('says Not connected, with the reason and Open Folder instead of a dead Reconnect, in a window that never connects', async () => {
    const w = world({ loaded: false, state: 'disconnected', connection: 'none' });
    const row = item(w.provider, (await towerRows(w.provider))[0]);
    expect(row.label).toBe('Not connected to Tower');
    expect(row.tooltip).toMatch(/^This window has no Codev workspace, so it does not connect to Tower\./);
    expect(row.command).toEqual({ command: 'workbench.action.files.openFolder', title: 'Open Folder' });
  });

  it('with codev.autoConnect off, says Not connected with Reconnect until an attempt runs, then Connecting…', async () => {
    const w = world({ loaded: false, state: 'disconnected', connection: 'manual' });
    const row = async () => item(w.provider, (await towerRows(w.provider))[0]);
    expect(await row()).toMatchObject({
      label: 'Not connected to Tower',
      tooltip: 'Automatic connection is off (codev.autoConnect). Click to connect to Tower.',
      command: { command: 'codev.reconnect', title: 'Reconnect to Tower' },
    });
    // Reconnect runs: ConnectionManager goes disconnected → connecting.
    w.setState('connecting');
    expect((await row()).label).toBe('Connecting to Tower…');
    // That attempt fails: the ordinary not-connected row, retrying in the background.
    w.setState('disconnected');
    expect(await row()).toMatchObject({
      label: 'Not connected to Tower',
      tooltip: 'Click to reconnect to Tower now. Codev keeps retrying in the background.',
      command: { command: 'codev.reconnect', title: 'Reconnect to Tower' },
    });
  });

  it('derives the connection mode from the activation policy and codev.autoConnect', () => {
    expect(cockpitConnectionMode(true, true)).toBe('auto');
    expect(cockpitConnectionMode(true, false)).toBe('manual');
    expect(cockpitConnectionMode(false, true)).toBe('none');
    expect(cockpitConnectionMode(false, false)).toBe('none');
  });

  it('says No workspaces registered when Tower lists none', async () => {
    const w = world({ fleet: [], loaded: true });
    expect((await towerRows(w.provider)).map(n => labelOf(w.provider, n))).toEqual(['No workspaces registered']);
  });

  it('lists workspaces, not a state row, once the fleet is loaded, even if the connection drops', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE)], here: ONE });
    w.setState('disconnected');
    expect((await towerRows(w.provider)).map(n => labelOf(w.provider, n))).toEqual(['codev']);
  });
});

// ── Workspaces ────────────────────────────────────────────────────────────────

const FLEET = [
  entry(wsRow('/work/zeta', 'zeta', true), QUIET),
  entry(wsRow(OTHER, 'marketmaker', true), overview([], [], { heldCount: 2 })),
  entry(wsRow(HERE, 'codev', true), ONE),
  entry(wsRow('/work/old', 'old', false), null),
  entry(wsRow('/work/older', 'older', false), null),
  entry(wsRow('/elsewhere/codev', 'codev', true), QUIET),
];

describe('workspace rows', () => {
  it('match the Tower view: order, labels, current marker, icons, descriptions, tooltips and the Dormant group', async () => {
    const w = world({ fleet: FLEET, here: ONE });
    const tower = new TowerProvider(
      { getFleet: () => FLEET, isLoaded: () => true, onDidChange: () => ({ dispose() {} }) } as never,
      { getWorkspacePath: () => HERE } as never,
    );
    const towerTop = tower.getChildren().map(n => tower.getTreeItem(n));
    const cockpitTop = (await towerRows(w.provider)).map(n => item(w.provider, n));
    const visible = (row: vscode.TreeItem) => ({
      label: row.label, description: row.description, icon: row.iconPath, tooltip: row.tooltip, contextValue: row.contextValue,
    });
    // Every row matches, except that this window's own row carries the Cockpit's own value (Phase 5:
    // its menu offers this window's workspace actions; the Tower view's current row has none).
    const towerShown = towerTop.map(visible);
    towerShown[2] = { ...towerShown[2], contextValue: 'cockpit-workspace-current' };
    expect(towerTop[2].contextValue).toBe('tower-workspace-active-current');
    expect(cockpitTop.map(visible)).toEqual(towerShown);
    // Disambiguated labels, as in the Tower view, and the current marker on this window's own.
    expect(cockpitTop.map(r => r.label)).toEqual(['marketmaker', 'elsewhere/codev', 'work/codev', 'zeta', 'Dormant (2)']);
    expect(cockpitTop[2].description).toBe('current');

    const towerDormant = tower.getChildren(tower.getChildren().at(-1)).map(n => tower.getTreeItem(n));
    const cockpitDormant = (await w.provider.getChildren((await towerRows(w.provider)).at(-1))).map(n => item(w.provider, n));
    expect(cockpitDormant.map(visible)).toEqual(towerDormant.map(visible));
  });

  it('give the Tower root, workspace rows and the Dormant group stable ids', async () => {
    const w = world({ fleet: FLEET, here: ONE });
    const top = (await towerRows(w.provider)).map(n => item(w.provider, n).id);
    expect(top).toEqual([
      COCKPIT_IDS.workspace(OTHER), COCKPIT_IDS.workspace('/elsewhere/codev'), COCKPIT_IDS.workspace(HERE),
      COCKPIT_IDS.workspace('/work/zeta'), COCKPIT_IDS.dormant,
    ]);
    expect(COCKPIT_IDS.workspace(HERE)).toBe('cockpit-ws:/work/codev');
    const dormant = await w.provider.getChildren((await towerRows(w.provider)).at(-1));
    expect(dormant.map(n => item(w.provider, n).id)).toEqual([COCKPIT_IDS.workspace('/work/old'), COCKPIT_IDS.workspace('/work/older')]);
  });

  it('start expanded for this window and for any that needs attention, collapsed when quiet', async () => {
    const w = world({ fleet: FLEET, here: ONE });
    const state = async (label: string) => item(w.provider, await workspaceNode(w.provider, label)).collapsibleState;
    expect(await state('work/codev')).toBe(2);
    expect(await state('marketmaker')).toBe(2);
    expect(await state('zeta')).toBe(1);
    expect(await state('elsewhere/codev')).toBe(1);
  });

  it('toggle on click when active (no command), open on click when dormant', async () => {
    const w = world({ fleet: FLEET, here: ONE });
    for (const label of ['work/codev', 'marketmaker', 'zeta']) {
      expect(item(w.provider, await workspaceNode(w.provider, label)).command).toBeUndefined();
    }
    const old = item(w.provider, await workspaceNode(w.provider, 'old'));
    expect(old.collapsibleState).toBe(0);
    expect(old.command).toEqual({
      command: OPEN_WORKSPACE_COMMAND, title: 'Open Workspace',
      arguments: [{ path: '/work/old', active: false, name: 'old', isCurrent: false }],
    });
    expect(await w.provider.getChildren(await workspaceNode(w.provider, 'old'))).toEqual([]);
  });

  it('show Loading… until a workspace overview is available', async () => {
    const w = world({
      fleet: [entry(wsRow(HERE, 'codev', true), ONE), entry(wsRow(OTHER, 'marketmaker', true), null)],
      here: null,
    });
    for (const label of ['codev', 'marketmaker']) {
      const ws = await workspaceNode(w.provider, label);
      const children = await w.provider.getChildren(ws);
      expect(children.map(n => labelOf(w.provider, n))).toEqual(['Loading…']);
      expect(await w.provider.getParent(children[0])).toEqual(ws);
      expect(item(w.provider, children[0]).collapsibleState).toBeUndefined();
    }
    w.here = ONE;
    w.fireOverview();
    const here = await w.provider.getChildren(await workspaceNode(w.provider, 'codev'));
    expect(here.map(n => labelOf(w.provider, n))).toEqual(['MAIN (1)', 'REVIEWER (0)', 'Decisions']);
  });
});

// ── This window's workspace ───────────────────────────────────────────────────

describe("this window's workspace: the Agents view's architect-axis rows", () => {
  const scope = cockpitScope(HERE);

  for (const [name, data] of [['N=0', NONE], ['N=1', ONE], ['N>1', MANY]] as const) {
    for (const asTree of [false, true]) {
      it(`${name}, ${asTree ? 'tree' : 'flat'} files: same rows as Agents (architect axis), scoped ids`, async () => {
        Object.assign(configValues, { buildersGroupBy: 'architect', buildersFileViewAsTree: asTree });
        const agents = new BuildersProvider({ getData: () => data, onDidChange: () => ({ dispose() {} }) } as never, DIFFS);
        const agentRows: vscode.TreeItem[] = [];
        const visitAgents = async (el?: vscode.TreeItem) => {
          for (const child of await agents.getChildren(el)) {
            agentRows.push(child);
            if (child.collapsibleState) { await visitAgents(child); }
          }
        };
        await visitAgents();

        const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), data)], here: data });
        const cockpitRows = withoutDecisions(
          (await subtree(w.provider, await workspaceNode(w.provider, 'codev'))).map(r => item(w.provider, r.node)), HERE);

        expect(cockpitRows.map(r => shape(r, scope))).toEqual(agentRows.map(r => shape(r, '')));
        // Context values match, except that architect rows name main vs a sibling.
        const contexts = (rows: vscode.TreeItem[]) => rows.map(r => r.contextValue);
        expect(contexts(cockpitRows)).toEqual(agentRows.map((r) => {
          if (!(r instanceof BuilderGroupTreeItem)) { return r.contextValue; }
          return r.groupName === 'main' ? 'cockpit-architect-main' : 'cockpit-architect-sibling';
        }));
        for (const row of cockpitRows) {
          if (row.id) { expect(row.id.startsWith(scope)).toBe(true); }
        }
      });
    }
  }

  it('folds a null owner into main, keeps a non-live owner, rolls up idle siblings and leaves a childless main a leaf', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), MANY)], here: MANY });
    const top = await w.provider.getChildren(await workspaceNode(w.provider, 'codev'));
    expect(top.map(n => labelOf(w.provider, n))).toEqual(['MAIN (2)', 'GHOST (1)', 'WEB (2)', 'Idle Architects (2)', 'Decisions']);
    const mainRows = await w.provider.getChildren(top[0]);
    expect(mainRows.map(n => (n as InstanceType<typeof BuilderTreeItem>).builderId)).toEqual(['spir-10', 'air-11']);
    expect(item(w.provider, top[1]).command).toEqual({ command: 'codev.openArchitectTerminal', title: 'Open Architect Terminal', arguments: ['ghost'] });
    const idle = await w.provider.getChildren(top[3]);
    expect(idle.map(n => labelOf(w.provider, n))).toEqual(['DEMOS (0)', 'REVIEWER (0)']);

    const w0 = world({ fleet: [entry(wsRow(HERE, 'codev', true), NONE)], here: NONE });
    const [main] = await w0.provider.getChildren(await workspaceNode(w0.provider, 'codev'));
    expect(item(w0.provider, main)).toMatchObject({ label: 'MAIN (0)', collapsibleState: 0 });
  });

  it('reads OverviewCache, not the lagging fleet copy', async () => {
    const stale = overview([], [architect('main')]);
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), stale)], here: ONE });
    const top = await w.provider.getChildren(await workspaceNode(w.provider, 'codev'));
    expect(top.map(n => labelOf(w.provider, n))).toEqual(['MAIN (1)', 'REVIEWER (0)', 'Decisions']);
  });

  it('matches the window to its Tower row with isSameWorkspacePath (Windows drive-letter case)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const w = world({ fleet: [entry(wsRow('C:\\work\\codev', 'codev', true), QUIET)], here: ONE, windowPath: 'c:\\work\\codev' });
      const ws = item(w.provider, await workspaceNode(w.provider, 'codev'));
      expect(ws.description).toBe('current');
      expect(w.provider.actingScope()).toBe(cockpitScope('C:\\work\\codev'));
      const top = await w.provider.getChildren(await workspaceNode(w.provider, 'codev'));
      expect(top.map(n => labelOf(w.provider, n))).toEqual(['MAIN (1)', 'REVIEWER (0)', 'Decisions']);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('ignores codev.buildersGroupBy: stage and area render the same tree as architect', async () => {
    const render = async (axis: string) => {
      Object.assign(configValues, { buildersGroupBy: axis });
      const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), MANY), entry(wsRow(OTHER, 'marketmaker', true), ONE)], here: MANY });
      return (await wholeTree(w.provider)).map(r => [r.id, r.label, r.contextValue, r.description]);
    };
    const architect = await render('architect');
    expect(await render('stage')).toEqual(architect);
    expect(await render('area')).toEqual(architect);
  });
});

// ── Other workspaces ──────────────────────────────────────────────────────────

describe('other workspaces: state and navigate only', () => {
  const target = { path: OTHER, active: true, name: 'marketmaker', isCurrent: false };

  it('render the same architect / builder shape from the fleet overview, every row opening that workspace', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE), entry(wsRow(OTHER, 'marketmaker', true), MANY)], here: ONE });
    const rows = (await subtree(w.provider, await workspaceNode(w.provider, 'marketmaker'))).map(r => item(w.provider, r.node));
    expect(rows.map(r => r.label)).toEqual([
      'MAIN (2)', expect.stringContaining('#10'), expect.stringContaining('#11'), 'GHOST (1)', expect.stringContaining('#13'),
      'WEB (2)', expect.stringContaining('#14'), expect.stringContaining('#12'), 'Idle Architects (2)', 'DEMOS (0)', 'REVIEWER (0)',
      'Decisions',
    ]);
    for (const row of rows) {
      expect(Object.values(REMOTE_CONTEXT)).toContain(row.contextValue);
      if (row instanceof IdleArchitectsGroupTreeItem) { expect(row.command).toBeUndefined(); continue; }
      expect(row.command).toEqual({ command: OPEN_WORKSPACE_COMMAND, title: 'Open Workspace', arguments: [target] });
      expect(String(row.tooltip)).toContain('In workspace marketmaker. Click to open its window');
    }
    // Builder rows are leaves: no changed-files expansion.
    for (const row of rows.filter(r => r instanceof BuilderTreeItem)) {
      expect(row.collapsibleState).toBe(0);
      expect(await w.provider.getChildren(row)).toEqual([]);
    }
    expect(rows.some(r => r instanceof BuilderFileTreeItem || r instanceof BuilderFolderTreeItem)).toBe(false);
  });

  it('act on nothing here: the Cockpit acts only for its own workspace scope', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE), entry(wsRow(OTHER, 'marketmaker', true), MANY)], here: ONE });
    expect(w.provider.actingScope()).toBe(cockpitScope(HERE));
    expect(w.provider.revealTargetForAgent({ kind: 'builder', id: 'spir-10' })).toBeUndefined();
  });

  it('keep two workspaces apart: shared architect names and a shared builder id never collide', async () => {
    const shared = overview([builder({ id: 'pir-1', spawnedByArchitect: 'main' })], [architect('main'), architect('web')]);
    const w = world({
      fleet: [entry(wsRow(HERE, 'codev', true), shared), entry(wsRow(OTHER, 'marketmaker', true), shared), entry(wsRow('/work/zeta', 'zeta', true), shared)],
      here: shared,
    });
    // Expand every builder row of this window (changed files included) and walk everything.
    const ids = (await wholeTree(w.provider)).map(r => r.id).filter((id): id is string => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id.endsWith('builder-group:main'))).toHaveLength(3);
    expect(ids.filter(id => /pir-1#\d+$/.test(id))).toHaveLength(3);
  });

  it('drop their row builders when the workspace leaves the fleet', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE), entry(wsRow(OTHER, 'marketmaker', true), MANY)], here: ONE });
    // The cache itself is the requirement (one builder per active workspace, pruned on leave).
    const scopes = () => [...(w.provider as unknown as { trees: Map<string, unknown> }).trees.keys()].sort();
    const [main] = await w.provider.getChildren(await workspaceNode(w.provider, 'marketmaker'));
    await w.provider.getChildren(await workspaceNode(w.provider, 'codev'));
    expect(scopes()).toEqual([cockpitScope(HERE), cockpitScope(OTHER)].sort());
    expect(await w.provider.getChildren(main)).toHaveLength(2);
    w.fleet = [entry(wsRow(HERE, 'codev', true), ONE), entry(wsRow(OTHER, 'marketmaker', false), null)];
    w.fireFleet();
    await towerRows(w.provider);
    expect(scopes()).toEqual([cockpitScope(HERE)]);
    expect(await w.provider.getChildren(main)).toEqual([]);
    expect(await w.provider.getParent(main)).toBeUndefined();
  });
});

// ── The Decisions entry ───────────────────────────────────────────────────────

describe('the Decisions entry', () => {
  const OLD = '/work/old';
  const fleet = () => [
    entry(wsRow(HERE, 'codev', true), ONE),
    entry(wsRow(OTHER, 'marketmaker', true), NONE),
    entry(wsRow(OLD, 'old', false), null),
  ];
  const decisionsOf = async (p: Provider, label: string) => {
    const children = await p.getChildren(await workspaceNode(p, label));
    return { node: children.at(-1)!, row: item(p, children.at(-1)!), labels: children.map(n => labelOf(p, n)) };
  };
  const navigate = (path: string, name: string) => ({
    command: OPEN_WORKSPACE_COMMAND, title: 'Open Workspace', arguments: [{ path, active: true, name, isCurrent: false }],
  });

  it('follows the architects under every active workspace, as a leaf with no count; none under a dormant one', async () => {
    const w = world({ fleet: fleet(), here: ONE });
    expect((await decisionsOf(w.provider, 'codev')).labels).toEqual(['MAIN (1)', 'REVIEWER (0)', 'Decisions']);
    expect((await decisionsOf(w.provider, 'marketmaker')).labels).toEqual(['MAIN (0)', 'Decisions']);
    for (const label of ['codev', 'marketmaker']) {
      const { node, row } = await decisionsOf(w.provider, label);
      expect(row).toMatchObject({ label: 'Decisions', collapsibleState: 0 });
      expect(row.description).toBeUndefined();
      expect(row.iconPath).toMatchObject({ id: 'law' });
      expect(await w.provider.getChildren(node)).toEqual([]);
    }
    expect(await w.provider.getChildren(await workspaceNode(w.provider, 'old'))).toEqual([]);
  });

  it('is not shown while a workspace is still loading: only Loading… is', async () => {
    const w = world({ fleet: fleet(), here: null });
    expect((await decisionsOf(w.provider, 'codev')).labels).toEqual(['Loading…']);
  });

  it("under this window's workspace opens the Decisions panel; under another, opens that workspace's window", async () => {
    const w = world({ fleet: fleet(), here: ONE });
    const here = (await decisionsOf(w.provider, 'codev')).row;
    expect(here.contextValue).toBe('cockpit-decisions');
    expect(here.command).toEqual({ command: 'codev.openDecisions', title: 'Open Decisions' });
    expect(String(here.tooltip)).toContain('Click to open the Decisions panel.');

    const there = (await decisionsOf(w.provider, 'marketmaker')).row;
    expect(there.contextValue).toBe(REMOTE_CONTEXT.decisions);
    expect(there.command).toEqual(navigate(OTHER, 'marketmaker'));
    expect(String(there.tooltip)).toContain('In workspace marketmaker. Click to open its window');
  });

  it("navigates in a builder-worktree window (the parent's window) and in a no-workspace window", async () => {
    const worktree = world({ fleet: fleet(), here: ONE, worktreeWindow: true });
    const parent = (await decisionsOf(worktree.provider, 'codev')).row;
    expect(parent.contextValue).toBe(REMOTE_CONTEXT.decisions);
    expect(parent.command).toEqual(navigate(HERE, 'codev'));

    const none = world({ fleet: fleet(), here: null, windowPath: null });
    for (const [label, path] of [['codev', HERE], ['marketmaker', OTHER]] as const) {
      const row = (await decisionsOf(none.provider, label)).row;
      expect(row.contextValue).toBe(REMOTE_CONTEXT.decisions);
      expect(row.command).toEqual(navigate(path, label));
    }
  });

  it('has a per-workspace id, and reveal walks it to the Tower root', async () => {
    const w = world({ fleet: fleet(), here: ONE });
    const here = await decisionsOf(w.provider, 'codev');
    const there = await decisionsOf(w.provider, 'marketmaker');
    expect(here.row.id).toBe(COCKPIT_IDS.decisions(HERE));
    expect(there.row.id).toBe(COCKPIT_IDS.decisions(OTHER));
    expect(await revealPath(w.provider, here.node)).toEqual([COCKPIT_IDS.tower, COCKPIT_IDS.workspace(HERE), COCKPIT_IDS.decisions(HERE)]);
    expect(await revealPath(w.provider, there.node)).toEqual([COCKPIT_IDS.tower, COCKPIT_IDS.workspace(OTHER), COCKPIT_IDS.decisions(OTHER)]);
  });
});

// ── Degraded windows ──────────────────────────────────────────────────────────

describe('degraded windows', () => {
  it("builder-worktree window: the parent is marked current but navigates, opening the parent's window", async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE)], here: ONE, worktreeWindow: true });
    const ws = await workspaceNode(w.provider, 'codev');
    expect(item(w.provider, ws).description).toBe('current');
    expect(item(w.provider, ws).collapsibleState).toBe(2);
    const rows = (await subtree(w.provider, ws)).map(r => item(w.provider, r.node));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.values(REMOTE_CONTEXT)).toContain(row.contextValue);
      if (row.command) {
        expect(row.command).toEqual({
          command: OPEN_WORKSPACE_COMMAND, title: 'Open Workspace',
          arguments: [{ path: HERE, active: true, name: 'codev', isCurrent: false }],
        });
      }
    }
    expect(w.provider.actingScope()).toBeUndefined();
  });

  it('no-workspace window: nothing is current and every workspace navigates', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE), entry(wsRow(OTHER, 'marketmaker', true), MANY)], here: null, windowPath: null });
    const rows = await wholeTree(w.provider);
    expect(rows.some(r => String(r.description).includes('current'))).toBe(false);
    for (const row of rows.filter(r => r instanceof BuilderTreeItem || r instanceof BuilderGroupTreeItem)) {
      expect(Object.values(REMOTE_CONTEXT)).toContain(row.contextValue);
    }
    expect(w.provider.actingScope()).toBeUndefined();
  });
});

// ── Attention on rows ─────────────────────────────────────────────────────────

describe('every attention signal lands on the row it concerns', () => {
  const ATTENTION = overview(
    [
      builder({ id: 'spir-20', issueId: '20', protocol: 'spir', spawnedByArchitect: 'main',
        blocked: 'plan review', blockedGate: 'plan-approval', blockedSince: ago(9) }),
      builder({ id: 'air-21', issueId: '21', protocol: 'air', spawnedByArchitect: 'main',
        agentState: servedState('needs-input', ago(4)) as never }),
      builder({ id: 'bugfix-22', issueId: '22', protocol: 'bugfix', spawnedByArchitect: 'web',
        agentState: servedState('dead', ago(3)) as never, heldCount: 2 }),
      builder({ id: 'pir-23', issueId: '23', protocol: 'pir', spawnedByArchitect: 'web' }),
    ],
    [architect('main', 'needs-input', ago(6)), architect('web', 'dead', ago(2)), architect('ops')],
    { heldCount: 5, mailboxEscalated: true, queuedFeedback: { 'pir-23': 3 } },
  );

  const cases: Array<[string, string, WorldOptions]> = [
    ['this window', 'codev', { fleet: [entry(wsRow(HERE, 'codev', true), ATTENTION)], here: ATTENTION }],
    ['another workspace', 'marketmaker', { fleet: [entry(wsRow(HERE, 'codev', true), QUIET), entry(wsRow(OTHER, 'marketmaker', true), ATTENTION)], here: QUIET }],
  ];
  for (const [where, label, setup] of cases) {
    it(where, async () => {
      const w = world(setup);
      const ws = await workspaceNode(w.provider, label);
      const rows = (await subtree(w.provider, ws)).map(r => item(w.provider, r.node));
      const row = (match: (r: vscode.TreeItem) => boolean) => {
        const found = rows.find(match);
        if (!found) { throw new Error('row not found'); }
        return found;
      };
      const builderRow = (id: string) => row(r => r instanceof BuilderTreeItem && r.builderId === id);
      const architectRow = (name: string) => row(r => r instanceof BuilderGroupTreeItem && r.groupName === name);
      const icon = (r: vscode.TreeItem) => r.iconPath as { id: string; color?: { id: string } };

      // Pending gate: the blocked builder's gate glyph and wait time.
      expect(icon(builderRow('spir-20')).id).toBe('checklist');
      expect(String(builderRow('spir-20').label)).toContain('9m');
      // Waits: the builder row's state glyph.
      expect(icon(builderRow('air-21')).id).toBe('question');
      expect(icon(builderRow('bugfix-22')).id).toBe('debug-disconnect');
      // Architect at a prompt / agent dead: its own row's wait text and glyph.
      expect(architectRow('main').description).toBe('needs input · 6m');
      expect(icon(architectRow('main'))).toEqual({ id: 'question', color: { id: 'list.warningForeground' } });
      expect(architectRow('web').description).toBe('agent exited · 2m');
      expect(icon(architectRow('web'))).toEqual({ id: 'debug-disconnect', color: { id: 'list.errorForeground' } });
      expect(architectRow('ops').description).toBeUndefined();
      // Held mail per builder, queued feedback per builder.
      expect(builderRow('bugfix-22').description).toBe('2 held');
      expect(builderRow('pir-23').description).toBe('3 queued');
      // The workspace row keeps the Tower view's summary: its most urgent signal.
      expect(item(w.provider, ws).description).toContain('plan review · 9m');
    });
  }

  it('unattributed held mail and escalation read on the workspace row', async () => {
    const heldOnly = overview([], [architect('main')], { heldCount: 4, mailboxEscalated: true });
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), QUIET), entry(wsRow(OTHER, 'marketmaker', true), heldOnly)], here: QUIET });
    expect(item(w.provider, await workspaceNode(w.provider, 'marketmaker')).description).toBe('4 held · escalated');
  });
});

// ── getParent and reveal ──────────────────────────────────────────────────────

describe('getParent reaches the Tower root from every row, and reveal finds the row', () => {
  const fleet = [entry(wsRow(HERE, 'codev', true), MANY), entry(wsRow(OTHER, 'marketmaker', true), MANY), entry(wsRow('/work/old', 'old', false), null)];
  const scope = cockpitScope(HERE);

  for (const asTree of [false, true]) {
    it(`a changed-file row of this window (${asTree ? 'tree' : 'flat'} mode), with nothing expanded yet`, async () => {
      Object.assign(configValues, { buildersFileViewAsTree: asTree });
      const w = world({ fleet, here: MANY });
      // A fresh provider: VS Code has never asked for the workspace's children.
      const file = await w.provider.findFileItem('spir-10', 'src/views/a.ts');
      expect(file).toBeDefined();
      const path = await revealPath(w.provider, file!);
      expect(path[0]).toBe(COCKPIT_IDS.tower);
      expect(path[1]).toBe(COCKPIT_IDS.workspace(HERE));
      expect(path[2]).toBe(`${scope}builder-group:main`);
      expect(path[3]).toMatch(new RegExp(`^${scope.replace(/[|/]/g, '\\$&')}spir-10#\\d+$`));
      if (asTree) { expect(path[4]).toBe(`${scope}spir-10::folder::src/views`); }
      expect(path.at(-1)).toBe(`${scope}spir-10::src/views/a.ts`);
    });
  }

  it('a builder row and an architect row (agent-cycle targets), with nothing expanded yet', async () => {
    const w = world({ fleet, here: MANY });
    const builderRow = w.provider.revealTargetForAgent({ kind: 'builder', id: 'bugfix-12' })!;
    expect(await revealPath(w.provider, builderRow)).toEqual([
      COCKPIT_IDS.tower, COCKPIT_IDS.workspace(HERE), `${scope}builder-group:web`, builderRow.id,
    ]);
    const architectRow = w.provider.revealTargetForAgent({ kind: 'architect', name: 'web' })!;
    expect(await revealPath(w.provider, architectRow)).toEqual([COCKPIT_IDS.tower, COCKPIT_IDS.workspace(HERE), `${scope}builder-group:web`]);
  });

  it('an idle sibling folded into Idle Architects', async () => {
    const w = world({ fleet, here: MANY });
    const idle = w.provider.revealTargetForAgent({ kind: 'architect', name: 'demos' })!;
    expect(await revealPath(w.provider, idle)).toEqual([
      COCKPIT_IDS.tower, COCKPIT_IDS.workspace(HERE), `${scope}idle-architects-group`, `${scope}builder-group:demos`,
    ]);
  });

  it("another workspace's rows and a dormant workspace", async () => {
    const w = world({ fleet, here: MANY });
    const rows = await subtree(w.provider, await workspaceNode(w.provider, 'marketmaker'));
    for (const { node } of rows) {
      const path = await revealPath(w.provider, node);
      expect(path.slice(0, 2)).toEqual([COCKPIT_IDS.tower, COCKPIT_IDS.workspace(OTHER)]);
    }
    const old = await workspaceNode(w.provider, 'old');
    expect(await revealPath(w.provider, old)).toEqual([COCKPIT_IDS.tower, COCKPIT_IDS.dormant, COCKPIT_IDS.workspace('/work/old')]);
  });

  it('every rendered row walks to the Tower root', async () => {
    const w = world({ fleet, here: MANY });
    const [root] = await w.provider.getChildren();
    for (const { node } of await subtree(w.provider, root)) {
      if (item(w.provider, node).id === undefined) { continue; } // placeholders and messages are never revealed
      expect((await revealPath(w.provider, node))[0]).toBe(COCKPIT_IDS.tower);
    }
  });
});

// ── Re-render and the accordion ───────────────────────────────────────────────

describe('re-render signals and per-view accordion state', () => {
  it('redraws on an overview change, a fleet change and a connection-state change', () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE)], here: ONE });
    const fired = vi.fn();
    w.provider.onDidChangeTreeData(fired);
    w.fireOverview();
    w.fireFleet();
    w.setState('reconnecting');
    expect(fired).toHaveBeenCalledTimes(3);
  });

  it("collapseBuildersExcept re-versions only this window's builder rows and redraws", async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), MANY), entry(wsRow(OTHER, 'marketmaker', true), MANY)], here: MANY });
    const idsOf = async (label: string) => (await subtree(w.provider, await workspaceNode(w.provider, label)))
      .map(r => item(w.provider, r.node)).filter(r => r instanceof BuilderTreeItem).map(r => r.id);
    const before = await idsOf('codev');
    const otherBefore = await idsOf('marketmaker');
    const fired = vi.fn();
    w.provider.onDidChangeTreeData(fired);
    const open = w.provider.revealTargetForAgent({ kind: 'builder', id: 'spir-10' }) as InstanceType<typeof BuilderTreeItem>;
    w.provider.collapseBuildersExcept(open);
    expect(fired).toHaveBeenCalledTimes(1);
    const after = await idsOf('codev');
    expect(after.find(id => id!.includes('spir-10#'))).toBe(open.id);
    expect(after.filter(id => !id!.includes('spir-10#')).every(id => !before.includes(id))).toBe(true);
    expect(await idsOf('marketmaker')).toEqual(otherBefore);
  });

  it('a row with no workspace scope is a routing bug and throws', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), ONE)], here: ONE });
    const stray = new BuilderTreeItem('pir-1', 'x');
    await expect(w.provider.getChildren(stray)).rejects.toThrow(/carries no workspace scope/);
  });
});

// ── Phase 5: this window's workspace row, its held config and its signals ─────

function config(overrides: Partial<ResolvedWorktreeConfig> = {}): ResolvedWorktreeConfig {
  return { symlinks: [], postSpawn: [], devCommand: null, devUrls: [], ...overrides };
}

const WITH_DEV = config({ devCommand: 'pnpm dev' });
const WITH_URLS = config({ devCommand: 'pnpm dev', devUrls: [{ label: 'App', url: 'http://localhost:3000' }] });
const WORKTREE_ROOT = `${HERE}/.builders/spir-7`;

/** The `contextValue` of every top-level workspace row, by label (Dormant's rows included). */
async function workspaceContexts(p: Provider): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const n of await towerRows(p)) {
    const row = item(p, n);
    if (row.id === COCKPIT_IDS.dormant) {
      for (const d of await p.getChildren(n)) { out[labelOf(p, d)] = item(p, d).contextValue; }
      continue;
    }
    out[String(row.label)] = row.contextValue;
  }
  return out;
}

const TWO = [entry(wsRow(HERE, 'codev', true), ONE), entry(wsRow(OTHER, 'marketmaker', true), MANY), entry(wsRow('/work/old', 'old', false), null)];

describe("this window's workspace row: what the Workspace view decides for this window", () => {
  it('encodes role, dev slot and dev URLs in its context value', () => {
    expect(cockpitWorkspaceContext('current', 'none', false)).toBe('cockpit-workspace-current');
    expect(cockpitWorkspaceContext('current', 'start', false)).toBe('cockpit-workspace-current-dev-start');
    expect(cockpitWorkspaceContext('current', 'stop', true)).toBe('cockpit-workspace-current-dev-stop-devurls');
    expect(cockpitWorkspaceContext('parent', 'stop-other', false)).toBe('cockpit-workspace-parent-dev-stop-other');
    expect(cockpitWorkspaceContext('parent', 'none', true)).toBe('cockpit-workspace-parent-devurls');
  });

  it('current row: no dev command, a runnable one, dev URLs; other rows keep the Tower values', async () => {
    const bare = world({ fleet: TWO, here: ONE });
    expect(await workspaceContexts(bare.provider)).toEqual({
      codev: 'cockpit-workspace-current', marketmaker: 'tower-workspace-active', old: 'tower-workspace-dormant',
    });
    const dev = world({ fleet: TWO, here: ONE, config: WITH_DEV });
    expect((await workspaceContexts(dev.provider)).codev).toBe('cockpit-workspace-current-dev-start');
    const urls = world({ fleet: TWO, here: ONE, config: WITH_URLS });
    expect((await workspaceContexts(urls.provider)).codev).toBe('cockpit-workspace-current-dev-start-devurls');
    // `"devCommand": ""` is no dev command, as in the Workspace view.
    const blank = world({ fleet: TWO, here: ONE, config: config({ devCommand: '  ' }) });
    expect((await workspaceContexts(blank.provider)).codev).toBe('cockpit-workspace-current');
  });

  it("current row: Stop Dev for this window's own dev, the other-target Stop Dev for anyone else's", async () => {
    const own = world({ fleet: TWO, here: ONE, config: WITH_DEV, devs: [{ builderId: 'main', terminalId: 't1' }] });
    expect((await workspaceContexts(own.provider)).codev).toBe('cockpit-workspace-current-dev-stop');
    const other = world({ fleet: TWO, here: ONE, config: WITH_URLS, devs: [{ builderId: 'spir-10', terminalId: 't2' }] });
    expect((await workspaceContexts(other.provider)).codev).toBe('cockpit-workspace-current-dev-stop-other-devurls');
  });

  it("builder-worktree window: the parent row is `parent`, with the worktree's own dev slot", async () => {
    const start = world({ fleet: TWO, here: ONE, worktreeWindow: true, windowRoot: WORKTREE_ROOT, config: WITH_URLS });
    expect(await workspaceContexts(start.provider)).toEqual({
      codev: 'cockpit-workspace-parent-dev-start-devurls', marketmaker: 'tower-workspace-active', old: 'tower-workspace-dormant',
    });
    // The worktree's dev (target = the builder id) is this window's own.
    const stop = world({
      fleet: TWO, here: ONE, worktreeWindow: true, windowRoot: WORKTREE_ROOT, config: WITH_DEV,
      devs: [{ builderId: 'spir-7', terminalId: 't3' }],
    });
    expect((await workspaceContexts(stop.provider)).codev).toBe('cockpit-workspace-parent-dev-stop');
  });

  it('no-workspace window: no row is this window\'s, so none carries an own value', async () => {
    const w = world({ fleet: TWO, here: null, windowPath: null, windowRoot: null, config: WITH_URLS });
    expect(await workspaceContexts(w.provider)).toEqual({
      codev: 'tower-workspace-active', marketmaker: 'tower-workspace-active', old: 'tower-workspace-dormant',
    });
  });

  it('a dormant own workspace keeps the Tower value (nothing acts on it here)', async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', false), null)], here: null, config: WITH_URLS });
    expect(await workspaceContexts(w.provider)).toEqual({ codev: 'tower-workspace-dormant' });
  });
});

describe('the held worktree config: fetched once, dropped only on its own signals', () => {
  it('N fleet and overview changes fetch nothing more; one codev-config-updated fetches exactly once', async () => {
    const w = world({ fleet: TWO, here: ONE, config: WITH_DEV });
    await workspaceContexts(w.provider);
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i += 1) {
      w.fireFleet();
      w.fireOverview();
      await workspaceContexts(w.provider);
    }
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(1);

    w.config = WITH_URLS;
    w.fireSSE('codev-config-updated');
    await workspaceContexts(w.provider);
    await workspaceContexts(w.provider);
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(2);
    expect((await workspaceContexts(w.provider)).codev).toBe('cockpit-workspace-current-dev-start-devurls');
  });

  it('a connection-state change drops it; so does a different workspace path', async () => {
    const w = world({ fleet: TWO, here: ONE, config: WITH_DEV });
    await workspaceContexts(w.provider);
    w.setState('reconnecting');
    w.setState('connected');
    await workspaceContexts(w.provider);
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(2);
    w.windowPath = OTHER;
    await workspaceContexts(w.provider);
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(3);
  });

  it('other envelopes, and malformed ones, fetch nothing', async () => {
    const w = world({ fleet: TWO, here: ONE, config: WITH_DEV });
    await workspaceContexts(w.provider);
    w.fireSSE('architects-updated');
    w.fireSSE('overview-changed');
    w.fireRawSSE('{not json');
    await workspaceContexts(w.provider);
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(1);
  });

  it('concurrent renders share one request', async () => {
    const w = world({ fleet: TWO, here: ONE, config: WITH_DEV });
    await Promise.all([workspaceContexts(w.provider), workspaceContexts(w.provider), workspaceContexts(w.provider)]);
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(1);
  });
});

describe("re-renders on the Workspace view's own signals", () => {
  it('redraws on a dev-terminal change and on codev-config-updated and architects-updated envelopes', () => {
    const w = world({ fleet: TWO, here: ONE });
    const before = w.redraws();
    w.fireDevTerminals();
    expect(w.redraws()).toBe(before + 1);
    w.fireSSE('codev-config-updated');
    expect(w.redraws()).toBe(before + 2);
    w.fireSSE('architects-updated');
    expect(w.redraws()).toBe(before + 3);
  });

  it('ignores any other envelope and a malformed one', () => {
    const w = world({ fleet: TWO, here: ONE });
    const before = w.redraws();
    w.fireSSE('overview-changed');
    w.fireRawSSE('not json');
    expect(w.redraws()).toBe(before);
  });

  it("Stop Dev replaces Start Dev once a dev starts from a builder's menu", async () => {
    const w = world({ fleet: TWO, here: ONE, config: WITH_DEV });
    expect((await workspaceContexts(w.provider)).codev).toBe('cockpit-workspace-current-dev-start');
    const before = w.redraws();
    w.devs = [{ builderId: 'spir-10', terminalId: 't9' }];
    w.fireDevTerminals();
    expect(w.redraws()).toBe(before + 1);
    expect((await workspaceContexts(w.provider)).codev).toBe('cockpit-workspace-current-dev-stop-other');
    // Stopped: back to Start, with no config fetch for any of it.
    w.devs = [];
    w.fireDevTerminals();
    expect((await workspaceContexts(w.provider)).codev).toBe('cockpit-workspace-current-dev-start');
    expect(w.loadWorktreeConfig).toHaveBeenCalledTimes(1);
  });
});

describe('the agent-cycle roster in the Cockpit\'s own order', () => {
  it("is this window's architects, each followed by its builders, never another workspace's", async () => {
    const w = world({ fleet: [entry(wsRow(HERE, 'codev', true), MANY), entry(wsRow(OTHER, 'marketmaker', true), ONE)], here: MANY });
    // The rendered order of this workspace's agent rows, top to bottom (Idle Architects expanded).
    const rendered = (await subtree(w.provider, await workspaceNode(w.provider, 'codev'))).flatMap(({ node }): AgentTarget[] => {
      if (node instanceof BuilderTreeItem) { return [{ kind: 'builder', id: node.builderId }]; }
      if (node instanceof BuilderGroupTreeItem) { return [{ kind: 'architect', name: node.groupName }]; }
      return [];
    });
    expect(rendered.map(t => (t.kind === 'architect' ? t.name : t.id))).toEqual([
      'main', 'spir-10', 'air-11', 'ghost', 'pir-13', 'web', 'aspir-14', 'bugfix-12', 'demos', 'reviewer',
    ]);
    expect(w.provider.agentCycleOrder()).toEqual(rendered);
  });

  it('is empty where nothing acts here: a builder-worktree window, and before Tower lists this workspace', () => {
    const worktree = world({ fleet: [entry(wsRow(HERE, 'codev', true), MANY)], here: MANY, worktreeWindow: true });
    expect(worktree.provider.agentCycleOrder()).toEqual([]);
    const unlisted = world({ fleet: [entry(wsRow(OTHER, 'marketmaker', true), MANY)], here: MANY });
    expect(unlisted.provider.agentCycleOrder()).toEqual([]);
  });
});
