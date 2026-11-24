/**
 * Spec 1963 × #1144: a dormant window (guest mode, no Codev workspace) stays exactly as inert as if
 * Codev never activated, even with the Codev Cockpit shown. Architect ruling at Phase 4: the Cockpit
 * shows the *Not connected to Tower* row (with its reason and *Open Folder*) and never initialises
 * the connection.
 *
 * The window is assembled from the real objects `activate()` builds for it — `ConnectionManager`
 * (never initialised: the dormant policy's `initializeConnection` is false), `OverviewCache`,
 * `TowerFleetCache`, `CockpitProvider` and the `OverviewRefreshGate` that counts the Cockpit. Every
 * route to Tower is a recording mock: the SDK's `TowerClient`, the SSE client, the Tower auto-starter
 * and global `fetch`. Showing the Cockpit, rendering it, running its Refresh and letting every poll
 * timer fire must record nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { recorded } = vi.hoisted(() => ({
  recorded: { clients: 0, clientCalls: [] as string[], sse: 0, autoStart: 0 },
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(e: T) { for (const l of this.listeners) { l(e); } }
    dispose() {}
  }
  class TreeItem {
    id?: string;
    tooltip?: string;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    constructor(public label: string, public collapsibleState?: number) {}
  }
  class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
  class ThemeColor { constructor(public id: string) {} }
  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: { showErrorMessage: vi.fn() },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback }),
    },
  };
});

vi.mock('@cluesmith/codev-sdk/tower-client', () => ({
  TowerClient: class {
    constructor() {
      recorded.clients++;
      return new Proxy({}, {
        get: (_target, method) => (...args: unknown[]) => {
          recorded.clientCalls.push(`${String(method)}(${JSON.stringify(args)})`);
          return Promise.resolve(null);
        },
      });
    }
  },
}));
vi.mock('../tower-starter.js', () => ({
  autoStartTower: vi.fn(async () => { recorded.autoStart++; return false; }),
}));
vi.mock('../sse-client.js', () => ({
  SSEClient: class {
    constructor() { recorded.sse++; }
    onEvent() { return { dispose: () => {} }; }
    connect() {}
    dispose() {}
  },
}));
vi.mock('../auth-wrapper.js', () => ({
  AuthWrapper: class {
    initialize = vi.fn(async () => {});
    getKeySync = () => null;
  },
}));

const { ConnectionManager } = await import('../connection-manager.js');
const { OverviewCache } = await import('../views/overview-data.js');
const { TowerFleetCache } = await import('../views/tower-cache.js');
const { CockpitProvider, cockpitConnectionMode } = await import('../views/cockpit.js');
const { loadWorktreeConfig } = await import('../load-worktree-config.js');
const { OverviewRefreshGate } = await import('../views/overview-refresh-gate.js');
const { activationPolicy, decideActivationTier } = await import('../ide-mode.js');

const fetchSpy = vi.fn(async () => { throw new Error('a dormant window must not fetch'); });

beforeEach(() => {
  recorded.clients = 0;
  recorded.clientCalls = [];
  recorded.sse = 0;
  recorded.autoStart = 0;
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fakeView() {
  const listeners: Array<(e: unknown) => void> = [];
  const view = {
    visible: false,
    onDidChangeVisibility: (l: (e: unknown) => void) => { listeners.push(l); return { dispose() {} }; },
    show: () => { view.visible = true; listeners.forEach(l => l({ visible: true })); },
  };
  return view;
}

describe('a dormant window with the Cockpit shown (#1144)', () => {
  it('makes no Tower request: no client, no SSE, no auto-start, no fetch', async () => {
    const tier = decideActivationTier({ ideMode: false, hasCodevWorkspace: false });
    expect(tier).toBe('dormant');
    const policy = activationPolicy(tier);
    expect(policy.initializeConnection).toBe(false);

    // What activate() builds; `connectionManager.initialize()` is never called for this policy.
    const connectionManager = new ConnectionManager({ secrets: {} } as never, { appendLine: vi.fn() } as never);
    const overviewCache = new OverviewCache(connectionManager);
    const towerCache = new TowerFleetCache(connectionManager);
    const cockpit = new CockpitProvider({
      connectionManager,
      terminalManager: { listDevTerminals: () => [], onDidChangeDevTerminals: () => ({ dispose() {} }) },
      // The real loader: it must make no request in a window that never connects.
      loadWorktreeConfig: () => loadWorktreeConfig(connectionManager),
      towerCache,
      overviewCache,
      diffCache: { getDiff: async () => { throw new Error('no diff in a dormant window'); } } as never,
      builderWorktreeWindow: false,
      connection: cockpitConnectionMode(policy.initializeConnection, true),
    });
    const cockpitView = fakeView();
    const gate = new OverviewRefreshGate(
      [cockpitView],
      () => 60,
      () => { if (connectionManager.getState() === 'connected') { void overviewCache.refresh(); } },
      () => { void overviewCache.refresh(); },
    );
    gate.wire();
    gate.reconcile();

    // The user opens the Cockpit: the refresh gate starts and resumes with an immediate refresh.
    cockpitView.show();
    expect(gate.isRunning()).toBe(true);

    // VS Code renders it.
    const [root] = await cockpit.getChildren();
    const rows = (await cockpit.getChildren(root)).map(n => cockpit.getTreeItem(n));
    expect(rows.map(r => r.label)).toEqual(['Not connected to Tower']);
    expect(rows[0].command).toEqual({ command: 'workbench.action.files.openFolder', title: 'Open Folder' });

    // The title-bar Refresh (`codev.cockpit.refresh`), then every poll timer, several times over.
    await Promise.all([overviewCache.refresh(), towerCache.refresh()]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(connectionManager.getState()).toBe('disconnected');
    expect(connectionManager.getClient()).toBeNull();
    expect(recorded).toEqual({ clients: 0, clientCalls: [], sse: 0, autoStart: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(towerCache.isLoaded()).toBe(false);
    expect(overviewCache.getData()).toBeNull();

    gate.dispose();
    towerCache.dispose();
    overviewCache.dispose();
    cockpit.dispose();
  });

  it('the recording mocks do see a window that connects (the control)', async () => {
    const connectionManager = new ConnectionManager({ secrets: {} } as never, { appendLine: vi.fn() } as never);
    const initializing = connectionManager.initialize();
    await vi.advanceTimersByTimeAsync(0);
    await initializing;
    expect(recorded.clients).toBe(1);
    expect(recorded.clientCalls.some(call => call.startsWith('getHealth('))).toBe(true);
    connectionManager.dispose();
  });
});
