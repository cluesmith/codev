/**
 * Spec 1963 scenarios 5, 6, 17 and 22 (host side): the Work panel.
 * - One panel per window: opening again reveals it; where it is not offered, the command says why.
 * - Its visibility counts toward the periodic overview refresh: with only the Work panel visible
 *   the timer runs, and with it hidden or closed the timer stops.
 * - The overview is pushed from the cache on `ready`, on every overview change and on every
 *   connection change: loading, last-known-good, and the not-connected notice.
 * - Each kept dashboard action does what the spec's mapping table says; a refused artifact path, a
 *   non-http(s) URL and an unknown builder are not acted on; a malformed message is ignored.
 * - Nothing is posted after the panel closed. A reload restores the panel through its serializer.
 * - No message the host posts carries the Tower key, Tower's URL or its port.
 * - The bundle is inline in the document, read from `dist/webview`; the webview may load nothing
 *   from the extension. A bundle that cannot be read fails the open, naming the file.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';

type Listener<T> = (event: T) => void;

class FakeEmitter<T> {
  private listeners: Array<Listener<T>> = [];
  readonly event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(event: T) { for (const l of [...this.listeners]) { l(event); } }
  get count() { return this.listeners.length; }
}

class FakePanel {
  visible = true;
  disposed = false;
  viewColumn: number | undefined = undefined;
  readonly posted: unknown[] = [];
  readonly received = new FakeEmitter<unknown>();
  readonly viewState = new FakeEmitter<void>();
  readonly disposal = new FakeEmitter<void>();
  readonly reveal = vi.fn();
  readonly webview = {
    html: '',
    options: {} as unknown,
    cspSource: 'https://webview.vscode-cdn.net',
    asWebviewUri: (uri: { path: string }) => ({ toString: () => `https://webview.vscode-cdn.net${uri.path}` }),
    postMessage: vi.fn(async (message: unknown) => {
      if (this.disposed) { throw new Error('Webview is disposed'); }
      this.posted.push(message);
      return true;
    }),
    onDidReceiveMessage: this.received.event,
  };
  readonly onDidChangeViewState = this.viewState.event;
  readonly onDidDispose = this.disposal.event;
  dispose() {
    if (this.disposed) { return; }
    this.disposed = true;
    this.disposal.fire();
  }
  /** The webview posts `message` to the host; resolves once the host has handled it. */
  async send(message: unknown) {
    this.received.fire(message);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.viewState.fire();
  }
}

const panels: FakePanel[] = [];
const createWebviewPanel = vi.fn((_viewType: string, _title: string, _column: number, _options: unknown) => {
  const panel = new FakePanel();
  panels.push(panel);
  return panel;
});
const showInformationMessage = vi.fn();
const openExternal = vi.fn(async (_uri: unknown) => true);
class TabInputWebview { constructor(readonly viewType: string) {} }
class TabInputText { constructor(readonly uri: string) {} }
/** The editor area's tabs, by group; empty unless a test puts a restored tab there. */
const tabGroups = {
  all: [] as Array<{ viewColumn: number; tabs: unknown[] }>,
  close: vi.fn(async (_tab: unknown) => true),
};

vi.mock('vscode', () => ({
  EventEmitter: class extends FakeEmitter<void> { dispose() {} },
  window: { createWebviewPanel, showInformationMessage, tabGroups },
  env: { openExternal },
  ViewColumn: { Active: -1 },
  TabInputWebview,
  Uri: {
    parse: (value: string) => ({ toString: () => value }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path, ...parts].join('/');
      return { path, fsPath: path };
    },
  },
}));

const { WorkPanels, workOverviewState } = await import('../workspace-views/work-panel.js');
const { OverviewRefreshGate } = await import('../views/overview-refresh-gate.js');
const { NOT_CONNECTED_MESSAGE } = await import('../workspace-views/decisions-bridge.js');
const { TowerClient } = await import('@cluesmith/codev-sdk/tower-client');
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** An extension directory holding the Work bundle's two files. */
const EXTENSION_DIR = mkdtempSync(join(tmpdir(), 'codev-work-panel-ext-'));
const BUNDLE_SCRIPT = '/* the work bundle */ window.workMounted = true;';
const BUNDLE_STYLE = '.work-view { outline: none; }';
mkdirSync(join(EXTENSION_DIR, 'dist', 'webview'), { recursive: true });
writeFileSync(join(EXTENSION_DIR, 'dist', 'webview', 'work.js'), BUNDLE_SCRIPT);
writeFileSync(join(EXTENSION_DIR, 'dist', 'webview', 'work.css'), BUNDLE_STYLE);
afterAll(() => rmSync(EXTENSION_DIR, { recursive: true, force: true }));
const EXTENSION = { path: EXTENSION_DIR };

function builder(id: string): OverviewBuilder {
  return {
    id,
    issueId: id.replace(/\D/g, '') || null,
    issueTitle: `Builder ${id}`,
    phase: 'implement',
    mode: 'strict',
    gates: {},
    worktreePath: `/work/codev/.builders/${id}`,
    protocol: 'spir',
    planPhases: [],
    progress: 40,
    blocked: null,
    startedAt: null,
    idleMs: 0,
  } as unknown as OverviewBuilder;
}

function overviewOf(...builders: OverviewBuilder[]): OverviewData {
  return { builders, pendingPRs: [], backlog: [], recentlyClosed: [] } as unknown as OverviewData;
}

function setup(opts: { reason?: string | null; data?: OverviewData | null; state?: ConnectionState; root?: string | null; extensionDir?: string } = {}) {
  const overviewChanged = new FakeEmitter<void>();
  const stateChanged = new FakeEmitter<ConnectionState>();
  const cache = { data: opts.data === undefined ? overviewOf(builder('spir-1963')) : opts.data };
  const connection = { state: opts.state ?? 'connected' as ConnectionState };
  const calls: string[] = [];
  const client = { refreshOverview: vi.fn(async () => { calls.push('tower refresh'); return true; }) };
  const overview = {
    getData: () => cache.data,
    onDidChange: overviewChanged.event,
    refresh: vi.fn(async () => { calls.push('cache refresh'); }),
  };
  const actions = {
    openBuilder: vi.fn(async (_id: string) => 'spir-1963'),
    newShell: vi.fn(async () => undefined),
    openFile: vi.fn(async (_path: string) => undefined),
    warn: vi.fn(),
  };
  const log = vi.fn();
  const reason = { value: opts.reason ?? null };
  const manager = new WorkPanels({
    extensionUri: (opts.extensionDir ? { path: opts.extensionDir } : EXTENSION) as never,
    overview,
    connection: {
      getState: () => connection.state,
      onStateChange: stateChanged.event,
      getClient: () => client,
    },
    actions,
    workspacePath: () => (opts.root === undefined ? '/work/codev' : opts.root),
    unavailableReason: () => reason.value,
    log,
  });
  return {
    manager, cache, connection, client, overview, actions, log, reason, calls,
    setData(data: OverviewData | null) { cache.data = data; overviewChanged.fire(); },
    setState(state: ConnectionState) { connection.state = state; stateChanged.fire(state); },
    overviewChanged, stateChanged,
  };
}

beforeEach(() => {
  panels.length = 0;
  tabGroups.all = [];
  tabGroups.close.mockClear();
  createWebviewPanel.mockClear();
  showInformationMessage.mockClear();
  openExternal.mockClear();
});

describe('opening the panel', () => {
  it('creates one retained, script-enabled panel in the active group, the Work bundle inline and nothing loadable from the extension', () => {
    const { manager } = setup();
    manager.show();
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(createWebviewPanel).toHaveBeenCalledWith('codev.work', 'Work', -1, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [],
    });
    const { html } = panels[0].webview;
    expect(html).toMatch(/<script nonce="[^"]+">/);
    expect(html).toContain(`">${BUNDLE_SCRIPT}</script>`);
    expect(html).toContain(`<style>${BUNDLE_STYLE}</style>`);
    expect(html).not.toMatch(/\bsrc=|\bhref=|webview\.vscode-cdn\.net/);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('connect-src');
    expect(manager.panel).toBe(panels[0]);
  });

  it('reveals the open panel instead of creating a second one, and never reloads it', () => {
    const { manager } = setup();
    manager.show();
    const html = panels[0].webview.html;
    manager.show();
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panels[0].reveal).toHaveBeenCalledTimes(1);
    expect(panels[0].webview.html).toBe(html);
  });

  it('a bundle that cannot be read fails the open loudly, naming the file, and leaves no panel', () => {
    const empty = mkdtempSync(join(tmpdir(), 'codev-work-nobundle-'));
    try {
      const { manager, log } = setup({ extensionDir: empty });
      expect(() => manager.show()).toThrow(`the Work panel cannot open: its bundle ${empty}/dist/webview/work.js could not be read`);
      expect(createWebviewPanel).not.toHaveBeenCalled();
      expect(manager.panel).toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`${empty}/dist/webview/work.js`));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('with a placement (Arrange Cockpit), opens the panel in that group, or moves the open one there, without taking focus', () => {
    const { manager } = setup();
    manager.show({ viewColumn: 2, preserveFocus: true });
    expect(createWebviewPanel).toHaveBeenCalledWith('codev.work', 'Work', { viewColumn: 2, preserveFocus: true }, expect.anything());
    const html = panels[0].webview.html;

    manager.show({ viewColumn: 3, preserveFocus: true });

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panels[0].reveal).toHaveBeenCalledWith(3, true);
    expect(panels[0].webview.html).toBe(html);
  });

  it('says why, and opens nothing, where Work is not offered', () => {
    const { manager } = setup({ reason: 'Codev: Work is not offered in a builder-worktree window.' });
    manager.show();
    expect(createWebviewPanel).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith('Codev: Work is not offered in a builder-worktree window.');
  });
});

describe("a canary for VS Code's spelling of webview tab types (integration review)", () => {
  const warning = (log: ReturnType<typeof vi.fn>) => log.mock.calls.filter(([line]) => String(line).includes('no editor tab matches'));
  const tabsOf = (...viewTypes: string[]) => {
    const group = { viewColumn: 1, tabs: [] as unknown[] };
    group.tabs = viewTypes.map(viewType => ({ input: new TabInputWebview(viewType), group }));
    tabGroups.all = [group];
  };

  it('logs once when the panel is on screen and no tab matches its type', () => {
    const { manager, log } = setup();
    manager.show();
    tabsOf('mainThreadWebviewPanel-codev.work');
    panels[0].setVisible(true);
    panels[0].setVisible(true);
    expect(warning(log)).toHaveLength(1);
    expect(String(warning(log)[0][0])).toContain('"codev.work"');
  });

  it('stays quiet when a tab matches, in either spelling, or while the panel is hidden', () => {
    const { manager, log } = setup();
    manager.show();
    tabsOf('mainThreadWebview-codev.work');
    panels[0].setVisible(true);
    tabsOf('codev.work');
    panels[0].setVisible(true);
    tabsOf();
    panels[0].setVisible(false);
    expect(warning(log)).toHaveLength(0);
  });
});

describe('the periodic overview refresh counts the Work panel (scenario 5)', () => {
  it("disposing the manager drops the open panel's listeners, as closing the panel does (claude review)", () => {
    const { manager } = setup();
    manager.show();
    expect(panels[0].viewState.count).toBe(1);
    expect(panels[0].disposal.count).toBeGreaterThan(0);
    const disposalBefore = panels[0].disposal.count;
    manager.dispose();
    expect(panels[0].viewState.count).toBe(0);
    // The manager's own close listener is gone; the panel session's own may remain until the panel closes.
    expect(panels[0].disposal.count).toBe(disposalBefore - 1);
  });

  it('reports its visibility, and fires on open, show, hide and close', () => {
    const { manager } = setup();
    const fired = vi.fn();
    manager.onDidChangeVisibility(fired);
    expect(manager.visible).toBe(false);
    manager.show();
    expect(manager.visible).toBe(true);
    expect(fired).toHaveBeenCalledTimes(1);
    panels[0].setVisible(false);
    expect(manager.visible).toBe(false);
    panels[0].setVisible(true);
    panels[0].dispose();
    expect(manager.visible).toBe(false);
    expect(fired).toHaveBeenCalledTimes(4);
  });

  it('runs the timer with only the Work panel visible, and stops it when hidden or closed', () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup();
      const tick = vi.fn();
      const resume = vi.fn();
      const hiddenTree = { visible: false, onDidChangeVisibility: new FakeEmitter<unknown>().event };
      const gate = new OverviewRefreshGate([hiddenTree, manager], () => 60, tick, resume);
      gate.wire();
      gate.reconcile();
      expect(gate.isRunning()).toBe(false);

      manager.show();
      expect(gate.isRunning()).toBe(true);
      expect(resume).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(120_000);
      expect(tick).toHaveBeenCalledTimes(2);

      panels[0].setVisible(false);
      expect(gate.isRunning()).toBe(false);
      panels[0].setVisible(true);
      expect(gate.isRunning()).toBe(true);
      panels[0].dispose();
      expect(gate.isRunning()).toBe(false);
      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the Work view is shown', () => {
  const DATA = overviewOf(builder('spir-1963'));

  it.each<[string, OverviewData | null, ConnectionState, unknown]>([
    ['loading while connecting', null, 'connecting', null],
    ['loading while connected, before the first overview', null, 'connected', null],
    // With nothing to keep, the view shows the notice over sections that say they are loading.
    ['the notice, nothing kept, while disconnected', null, 'disconnected', { data: null, error: NOT_CONNECTED_MESSAGE }],
    ['the notice, nothing kept, while reconnecting', null, 'reconnecting', { data: null, error: NOT_CONNECTED_MESSAGE }],
    ['the overview while connected', DATA, 'connected', { data: DATA, error: null }],
    ['the last overview under the notice while reconnecting', DATA, 'reconnecting', { data: DATA, error: NOT_CONNECTED_MESSAGE }],
    ['the last overview under the notice while disconnected', DATA, 'disconnected', { data: DATA, error: NOT_CONNECTED_MESSAGE }],
    ['the last overview under the notice while connecting again', DATA, 'connecting', { data: DATA, error: NOT_CONNECTED_MESSAGE }],
  ])('%s', (_label, data, state, expected) => {
    expect(workOverviewState(data, state)).toEqual(expected);
  });

  it('is pushed on ready, on every overview change and on every connection change', async () => {
    const harness = setup({ data: null, state: 'connecting' });
    harness.manager.show();
    const panel = panels[0];
    await panel.send({ type: 'ready' });
    harness.setState('connected');
    harness.setData(DATA);
    harness.setState('reconnecting');
    harness.setState('connected');
    expect(panel.posted).toEqual([
      { type: 'work/overview', overview: null },
      { type: 'work/overview', overview: null },
      { type: 'work/overview', overview: { data: DATA, error: null } },
      { type: 'work/overview', overview: { data: DATA, error: NOT_CONNECTED_MESSAGE } },
      { type: 'work/overview', overview: { data: DATA, error: null } },
    ]);
  });

  it('posts nothing after the panel closed, and stops listening', async () => {
    const harness = setup();
    harness.manager.show();
    const panel = panels[0];
    panel.dispose();
    harness.setData(DATA);
    harness.setState('reconnecting');
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
    expect(harness.overviewChanged.count).toBe(0);
    expect(harness.stateChanged.count).toBe(0);
    expect(panel.received.count).toBe(0);
    expect(panel.viewState.count).toBe(0);
  });
});

describe('the mapped actions (scenario 17)', () => {
  it("Open opens the builder's terminal", async () => {
    const { manager, actions } = setup();
    manager.show();
    await panels[0].send({ type: 'work/open-builder', builderId: 'spir-1963' });
    expect(actions.openBuilder).toHaveBeenCalledWith('spir-1963');
  });

  it('Open does nothing for a builder the overview does not show', async () => {
    const { manager, actions, log } = setup();
    manager.show();
    await panels[0].send({ type: 'work/open-builder', builderId: 'main' });
    expect(actions.openBuilder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not open builder main'));
  });

  it('+ Shell runs New Shell', async () => {
    const { manager, actions } = setup();
    manager.show();
    await panels[0].send({ type: 'work/new-shell' });
    expect(actions.newShell).toHaveBeenCalledTimes(1);
  });

  it("Refresh drops Tower's overview cache, then re-reads this window's overview", async () => {
    const { manager, calls } = setup();
    manager.show();
    await panels[0].send({ type: 'work/refresh' });
    expect(calls).toEqual(['tower refresh', 'cache refresh']);
  });

  it('Refresh asks nothing of Tower while not connected', async () => {
    const { manager, client, overview } = setup({ state: 'reconnecting' });
    manager.show();
    await panels[0].send({ type: 'work/refresh' });
    expect(client.refreshOverview).not.toHaveBeenCalled();
    expect(overview.refresh).toHaveBeenCalledTimes(1);
  });

  it('opens http(s) links in the browser and refuses every other scheme', async () => {
    const { manager, log } = setup();
    manager.show();
    await panels[0].send({ type: 'open-external', url: 'https://github.com/cluesmith/codev/issues/1963' });
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://cluesmith.codev-vscode/x', 'command:workbench.action.reloadWindow']) {
      await panels[0].send({ type: 'open-external', url });
    }
    expect(openExternal.mock.calls.map(([uri]) => String(uri))).toEqual(['https://github.com/cluesmith/codev/issues/1963']);
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('ignores a malformed message, saying so in the log', async () => {
    const { manager, actions, overview, log } = setup();
    manager.show();
    for (const bad of [null, 'refresh', { type: 'work/open-builder' }, { type: 'work/open-builder', builderId: '' },
      { type: 'work/open-artifact', path: 'a\0b' }, { type: 'work/open-artifact', path: 'x'.repeat(5000) }, { type: 'work/delete' }]) {
      await panels[0].send(bad);
    }
    expect(actions.openBuilder).not.toHaveBeenCalled();
    expect(actions.openFile).not.toHaveBeenCalled();
    expect(overview.refresh).not.toHaveBeenCalled();
    expect(panels[0].posted).toEqual([]);
    expect(log).toHaveBeenCalledTimes(7);
  });
});

describe('artifact links open a workspace file, and nothing outside it', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'codev-work-panel-')));
    root = join(base, 'ws');
    mkdirSync(join(root, 'codev', 'specs'), { recursive: true });
    writeFileSync(join(root, 'codev', 'specs', '1963-cockpit.md'), '# spec');
    writeFileSync(join(base, 'outside.md'), '# outside');
    symlinkSync(join(base, 'outside.md'), join(root, 'codev', 'specs', 'escape.md'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // These resolve real paths (fs.promises.realpath, on libuv's thread pool), so they wait for the
  // outcome: one turn of the event loop is not always enough under a loaded full-suite run.

  it('opens a spec by its workspace-relative path, at its canonical location', async () => {
    const { manager, actions } = setup({ root });
    manager.show();
    await panels[0].send({ type: 'work/open-artifact', path: 'codev/specs/1963-cockpit.md' });
    await vi.waitFor(() => expect(actions.openFile).toHaveBeenCalledWith(join(root, 'codev', 'specs', '1963-cockpit.md')));
    expect(actions.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a .. escape', '../outside.md'],
    ['an absolute path outside', 'OUTSIDE'],
    ['a symlink that leads outside', 'codev/specs/escape.md'],
  ])('refuses %s, and says so', async (_label, requested) => {
    const path = requested === 'OUTSIDE' ? join(base, 'outside.md') : requested;
    const { manager, actions } = setup({ root });
    manager.show();
    await panels[0].send({ type: 'work/open-artifact', path });
    await vi.waitFor(() => expect(actions.warn).toHaveBeenCalledWith(`Codev: ${path} was not opened: it is outside this workspace.`));
    expect(actions.openFile).not.toHaveBeenCalled();
  });

  it('drops a refusal that lands after the panel closed: no toast', async () => {
    const { manager, actions, log } = setup({ root });
    manager.show();
    const sent = panels[0].send({ type: 'work/open-artifact', path: '../outside.md' });
    panels[0].dispose();
    await sent;
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('did not open ../outside.md: outside-workspace.')));
    expect(actions.warn).not.toHaveBeenCalled();
    expect(actions.openFile).not.toHaveBeenCalled();
  });

  it('logs an editor that would not open, rather than leaving an unhandled rejection', async () => {
    const { manager, actions, log } = setup({ root });
    actions.openFile.mockRejectedValueOnce(new Error('the file went away'));
    manager.show();
    await panels[0].send({ type: 'work/open-artifact', path: 'codev/specs/1963-cockpit.md' });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Work panel: a message from its webview failed: the file went away'));
  });

  it('says a missing file was not found', async () => {
    const { manager, actions } = setup({ root });
    manager.show();
    await panels[0].send({ type: 'work/open-artifact', path: 'codev/specs/gone.md' });
    await vi.waitFor(() => expect(actions.warn).toHaveBeenCalledWith('Codev: codev/specs/gone.md was not found in this workspace.'));
    expect(actions.openFile).not.toHaveBeenCalled();
  });
});

describe('restore after a window reload', () => {
  it('adopts the restored panel: it renders the view and answers its webview', async () => {
    const { manager } = setup();
    const restored = new FakePanel();
    await manager.deserializeWebviewPanel(restored as never);
    expect(restored.webview.options).toEqual({ enableScripts: true, localResourceRoots: [] });
    expect(restored.webview.html).toContain(BUNDLE_SCRIPT);
    await restored.send({ type: 'ready' });
    expect(restored.posted).toHaveLength(1);
    expect(manager.visible).toBe(true);
    manager.show();
    expect(createWebviewPanel).not.toHaveBeenCalled();
    expect(restored.reveal).toHaveBeenCalledTimes(1);
  });

  it('closes a second restored panel, and one restored where Work is not offered', async () => {
    const { manager, reason } = setup();
    const first = new FakePanel();
    const second = new FakePanel();
    await manager.deserializeWebviewPanel(first as never);
    await manager.deserializeWebviewPanel(second as never);
    expect(first.disposed).toBe(false);
    expect(second.disposed).toBe(true);

    first.dispose();
    reason.value = 'Codev: Work needs a Codev workspace, and this window has none.';
    const third = new FakePanel();
    await manager.deserializeWebviewPanel(third as never);
    expect(third.disposed).toBe(true);
  });
});

describe('a tab restored by a reload that VS Code has not revived yet', () => {
  /** Put tabs in editor groups, each tab knowing its group, as `vscode.window.tabGroups` does. */
  function seedTabs(...groups: Array<{ viewColumn: number; inputs: unknown[] }>) {
    tabGroups.all = groups.map(({ viewColumn, inputs }) => {
      const group = { viewColumn, tabs: [] as unknown[] };
      group.tabs = inputs.map(input => ({ input, group }));
      return group;
    });
    return tabGroups.all.map(group => group.tabs);
  }

  it('opening Work puts the live panel in that tab\'s group, then closes the restored tab: never two, nothing else closed', () => {
    const [[text, decisions], [restored]] = seedTabs(
      { viewColumn: 1, inputs: [new TabInputText('a.ts'), new TabInputWebview('mainThreadWebview-codev.decisions')] },
      { viewColumn: 2, inputs: [new TabInputWebview('mainThreadWebview-codev.work')] },
    );
    const { manager } = setup();

    manager.show();

    expect(createWebviewPanel).toHaveBeenCalledWith('codev.work', 'Work', 2, expect.anything());
    expect(tabGroups.close).toHaveBeenCalledTimes(1);
    expect(tabGroups.close).toHaveBeenCalledWith(restored);
    expect(tabGroups.close).not.toHaveBeenCalledWith(text);
    expect(tabGroups.close).not.toHaveBeenCalledWith(decisions);
    // Closed after the new panel opened in its group, so the group is never left empty and closed.
    expect(createWebviewPanel.mock.invocationCallOrder[0]).toBeLessThan(tabGroups.close.mock.invocationCallOrder[0]);
  });

  it('with a placement (Arrange Cockpit) the live panel opens at the placement, and the restored tab is closed', () => {
    const [[restored]] = seedTabs({ viewColumn: 1, inputs: [new TabInputWebview('codev.work')] });
    const { manager } = setup();

    manager.show({ viewColumn: 2, preserveFocus: true });

    expect(createWebviewPanel).toHaveBeenCalledWith('codev.work', 'Work', { viewColumn: 2, preserveFocus: true }, expect.anything());
    expect(tabGroups.close).toHaveBeenCalledWith(restored);
  });

  it('`tab` is the open panel\'s own tab, in its group', () => {
    const { manager } = setup();
    expect(manager.tab).toBeUndefined();
    manager.show();
    panels[0].viewColumn = 2;
    const [, [own]] = seedTabs(
      { viewColumn: 1, inputs: [new TabInputWebview('mainThreadWebview-codev.decisions')] },
      { viewColumn: 2, inputs: [new TabInputWebview('mainThreadWebview-codev.work')] },
    );
    expect(manager.tab).toBe(own);
  });
});

describe('the Tower key, URL and port never reach the webview (scenario 22, state)', () => {
  it('across a refresh and the overview it pushes', async () => {
    const KEY = 'tower-key-1963-do-not-leak';
    const PORT = 18764;
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string> });
      const text = JSON.stringify({ ok: true });
      return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), text: async () => text, json: async () => ({ ok: true }) } as unknown as Response;
    });
    const client = new TowerClient({ port: PORT, getAuthKey: () => KEY, fetchFn: fetchFn as never });
    const changed = new FakeEmitter<void>();
    const data = overviewOf(builder('spir-1963'));
    const manager = new WorkPanels({
      extensionUri: EXTENSION as never,
      overview: { getData: () => data, onDidChange: changed.event, refresh: async () => { changed.fire(); } },
      connection: { getState: () => 'connected', onStateChange: new FakeEmitter<ConnectionState>().event, getClient: () => client },
      actions: { openBuilder: vi.fn(), newShell: vi.fn(), openFile: vi.fn(), warn: vi.fn() },
      workspacePath: () => '/work/codev',
      unavailableReason: () => null,
      log: vi.fn(),
    });
    manager.show();
    const panel = panels[0];
    await panel.send({ type: 'ready' });
    await panel.send({ type: 'work/refresh' });

    // The host did make a keyed request to Tower's port...
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`http://localhost:${PORT}/api/overview/refresh`);
    expect(requests[0].headers['codev-tower-key']).toBe(KEY);
    // ...and none of it reached the webview.
    expect(panel.posted.map(m => (m as { type: string }).type)).toEqual(['work/overview', 'work/overview']);
    const everything = JSON.stringify(panel.posted) + panel.webview.html;
    for (const secret of [KEY, 'codev-tower-key', `localhost:${PORT}`, String(PORT)]) {
      expect(everything, secret).not.toContain(secret);
    }
  });
});
