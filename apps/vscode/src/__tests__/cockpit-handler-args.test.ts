/**
 * Spec 1963 Phase 5: every command a Cockpit menu entry runs handles the Cockpit tree element VS Code
 * passes it. A `view/item/context` entry passes the clicked element, and the Cockpit's elements are
 * not the source views' (its workspace rows are `{ kind: 'workspace' }` nodes, its architect rows
 * group rows labelled `WEB (0)`). Each command is given the real node its entry attaches to, taken
 * from a real `CockpitProvider`, and must act on that node's target. Handlers registered inline in
 * `extension.ts` are held to their argument resolver at the source level; the resolvers themselves
 * run here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';

const ui = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  openExternal: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire = (e: T) => { this.listeners.forEach(l => l(e)); };
    dispose = () => {};
  }
  class TreeItem {
    id?: string;
    tooltip?: string;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    resourceUri?: unknown;
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
    Uri: { parse: (s: string) => ({ url: s }), from: (parts: object) => parts },
    window: { showQuickPick: ui.showQuickPick, showWarningMessage: ui.showWarningMessage },
    env: { openExternal: ui.openExternal },
    workspace: { getConfiguration: () => ({ get: (_key: string, def: unknown) => def }) },
  };
});

const { CockpitProvider } = await import('../views/cockpit.js');
const { BuilderTreeItem, BuilderGroupTreeItem } = await import('../views/builder-tree-item.js');
const { MENU_RECORDS, COCKPIT_ENTRIES } = await import('../views/cockpit-menu-map.js');
const { architectNameFromArg, extractBuilderId, extractIssueId } = await import('../commands/command-args.js');
const { openDevUrl } = await import('../commands/open-dev-url.js');
const { toWorkspaceTarget } = await import('../views/tower.js');

const EXT_SRC = readFileSync(resolve(__dirname, '../extension.ts'), 'utf8');
const SWITCH_SRC = readFileSync(resolve(__dirname, '../commands/switch-workspace.ts'), 'utf8');

const HERE = '/work/codev';
const OTHER = '/work/market';
const noEvent = () => ({ dispose() {} });

function builder(id: string, architect: string): OverviewBuilder {
  return {
    id, issueId: id.split('-')[1], issueTitle: id, phase: 'implement', protocolPhase: 'implement', mode: 'strict',
    gates: {}, worktreePath: '', roleId: null, protocol: id.split('-')[0], planPhases: [], progress: 0,
    blocked: null, blockedGate: null, blockedSince: null, startedAt: null, idleMs: 0, lastDataAt: null,
    spawnedByArchitect: architect, area: 'Uncategorized', prReady: false,
  } as unknown as OverviewBuilder;
}

const DATA = {
  builders: [builder('spir-10', 'main'), builder('air-11', 'web')],
  architects: [{ name: 'main' }, { name: 'web' }],
  backlog: [], pendingPRs: [], recentlyClosed: [], heldCount: 0, mailboxEscalated: false, queuedFeedback: {},
} as unknown as OverviewData;

const fleet = [
  { workspace: { path: HERE, name: 'codev', active: true, proxyUrl: '', terminals: 1 }, attention: deriveAttention(DATA), overview: DATA },
  { workspace: { path: OTHER, name: 'marketmaker', active: true, proxyUrl: '', terminals: 1 }, attention: deriveAttention(DATA), overview: DATA },
];

const cockpit = new CockpitProvider({
  connectionManager: {
    getState: () => 'connected', getWorkspacePath: () => HERE, getWindowRoot: () => HERE, onStateChange: noEvent, onSSEEvent: noEvent,
  } as never,
  terminalManager: { listDevTerminals: () => [], onDidChangeDevTerminals: noEvent },
  loadWorktreeConfig: async () => null,
  towerCache: { getFleet: () => fleet, isLoaded: () => true, getOverview: () => DATA, onDidChange: noEvent } as never,
  overviewCache: { getData: () => DATA, onDidChange: noEvent } as never,
  diffCache: { getDiff: async () => ({ baseRef: 'main', files: [] }) } as never,
  builderWorktreeWindow: false,
  connection: 'auto',
});

/** The Cockpit's nodes: this window's workspace node, another's, and this window's agent rows. */
async function nodes() {
  const [root] = await cockpit.getChildren();
  const workspaces = await cockpit.getChildren(root);
  const own = workspaces.find(n => cockpit.getTreeItem(n).contextValue?.startsWith('cockpit-workspace-current'));
  const other = workspaces.find(n => cockpit.getTreeItem(n).contextValue === 'tower-workspace-active');
  const architects = await cockpit.getChildren(own);
  const sibling = architects.find(n => cockpit.getTreeItem(n).contextValue === 'cockpit-architect-sibling');
  const main = architects.find(n => cockpit.getTreeItem(n).contextValue === 'cockpit-architect-main');
  const [builderRow] = await cockpit.getChildren(main);
  if (!own || !other || !sibling || !main || !(builderRow instanceof BuilderTreeItem) || !(sibling instanceof BuilderGroupTreeItem)) {
    throw new Error('fixture: a Cockpit node is missing');
  }
  return { own, other, sibling, builderRow };
}

/** The text of one command's registration in `src`, from its id to the next registration. */
function registration(src: string, command: string): string {
  const start = src.search(new RegExp(`reg(?:Cli)?\\('${command.replace(/\./g, '\\.')}'`));
  if (start < 0) { throw new Error(`no registration for ${command}`); }
  const rest = src.slice(start + 1);
  const next = rest.search(/\n\t\treg(?:Cli)?\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

beforeEach(() => {
  ui.showQuickPick.mockReset();
  ui.openExternal.mockReset();
  ui.showWarningMessage.mockReset();
});

describe("this window's builder rows: the Agents commands, identical", () => {
  const builderCommands = [...new Set(MENU_RECORDS
    .filter(r => 'same' in r.cockpit && r.source.when.startsWith('view == codev.agents'))
    .map(r => r.source.command))];

  it('cover every Agents builder-row command', () => {
    expect(builderCommands.sort()).toEqual([
      'codev.approveGate', 'codev.openBuilderById', 'codev.openWorktreeFolder', 'codev.openWorktreeWindow',
      'codev.runWorktreeDev', 'codev.runWorktreeSetup', 'codev.stopWorktreeDev', 'codev.viewDiff',
      'codev.viewPlanFile', 'codev.viewReviewFile', 'codev.viewSpecFile',
    ]);
  });

  for (const command of builderCommands) {
    it(`${command} resolves a Cockpit builder row to its builder id (or ignores it)`, async () => {
      const { builderRow } = await nodes();
      const handler = registration(EXT_SRC, command);
      if (command === 'codev.stopWorktreeDev') {
        // Stops the single dev slot, whichever row asked.
        expect(handler).toMatch(/^[^(]*\(\s*'codev\.stopWorktreeDev', \(\) =>/);
        return;
      }
      expect(handler).toMatch(/extractBuilderId\(arg\)/);
      // The Cockpit row's id is workspace-scoped; the resolver reads the builder id, not the row id.
      expect(builderRow.id).toMatch(/^ws:\/work\/codev\|/);
      expect(extractBuilderId(builderRow)).toBe('spir-10');
    });
  }
});

describe('relocated commands, given the Cockpit node their entry attaches to', () => {
  it('Remove Architect resolves the name from the Cockpit sibling row, not from its label', async () => {
    const { sibling } = await nodes();
    expect(cockpit.getTreeItem(sibling).label).toBe('WEB (1)');
    expect(architectNameFromArg(sibling)).toBe('web');
    expect(registration(EXT_SRC, 'codev.removeArchitect')).toMatch(/async \(arg: unknown\) => \{[^]*?const name = architectNameFromArg\(arg\);/);
  });

  it('Open Dev URL… falls through to its QuickPick for the workspace row (or opens the only URL)', async () => {
    const { own } = await nodes();
    const two = [{ label: 'App', url: 'http://localhost:3000' }, { label: 'Admin', url: 'http://localhost:3001' }];
    const manager = (devUrls: typeof two) => ({
      getClient: () => ({ getWorktreeConfig: async () => ({ symlinks: [], postSpawn: [], devCommand: null, devUrls }) }),
      getWorkspacePath: () => HERE,
      getState: () => 'connected',
    }) as never;

    ui.showQuickPick.mockResolvedValue({ url: 'http://localhost:3001' });
    await openDevUrl(manager(two), own);
    expect(ui.showQuickPick).toHaveBeenCalledWith(
      [{ label: 'App', description: 'http://localhost:3000', url: 'http://localhost:3000' },
        { label: 'Admin', description: 'http://localhost:3001', url: 'http://localhost:3001' }],
      { placeHolder: 'Open which dev URL?' },
    );
    expect(ui.openExternal).toHaveBeenCalledWith({ url: 'http://localhost:3001' });

    ui.openExternal.mockReset();
    await openDevUrl(manager([two[0]]), own);
    expect(ui.openExternal).toHaveBeenCalledWith({ url: 'http://localhost:3000' });

    // The registration hands the raw argument over; a dev-URL row's string still opens directly.
    expect(registration(EXT_SRC, 'codev.openDevUrl')).toMatch(/\(urlArg\?: unknown\) => openDevUrl\(connectionManager!, urlArg\)/);
    ui.openExternal.mockReset();
    await openDevUrl(manager(two), 'http://localhost:4000');
    expect(ui.openExternal).toHaveBeenCalledWith({ url: 'http://localhost:4000' });
  });

  it("Spawn Builder's extractIssueId yields no id from a workspace node, so the full picker opens", async () => {
    const { own } = await nodes();
    expect(extractIssueId(own)).toBeUndefined();
    expect(registration(EXT_SRC, 'codev.spawnBuilder')).toMatch(/spawnBuilder\(extractIssueId\(arg\)\)/);
  });

  it("Add Architect, New Shell, Start Dev, Stop Dev and Open Web Interface ignore the argument (this window's workspace)", () => {
    for (const command of ['codev.addArchitect', 'codev.newShell', 'codev.runWorkspaceDev', 'codev.stopWorkspaceDev',
      'codev.stopWorktreeDev', 'codev.cockpit.openWebInterface']) {
      expect(registration(EXT_SRC, command), command).toMatch(new RegExp(`^[^(]*\\(\\s*'${command.replace(/\./g, '\\.')}', (async )?\\(\\) =>`));
    }
  });

  it("Open and Deactivate act on the Cockpit workspace node's own workspace", async () => {
    const { other } = await nodes();
    expect(toWorkspaceTarget(other)).toEqual({ path: OTHER, active: true, name: 'marketmaker', isCurrent: false });
    for (const command of ['OPEN_WORKSPACE_COMMAND', "'codev.tower.deactivateWorkspace'"]) {
      const start = SWITCH_SRC.indexOf(`regCli(${command}`);
      expect(start, command).toBeGreaterThan(-1);
      expect(SWITCH_SRC.slice(start, start + 200)).toMatch(/\(arg: unknown\) => \{\s*const target = toWorkspaceTarget\(arg\);/);
    }
  });

  it('every relocated row entry runs one of the commands checked above (title-bar entries pass no element)', () => {
    const checked = new Set(['codev.removeArchitect', 'codev.openDevUrl', 'codev.spawnBuilder', 'codev.addArchitect', 'codev.newShell',
      'codev.runWorkspaceDev', 'codev.stopWorkspaceDev', 'codev.stopWorktreeDev', 'codev.cockpit.openWebInterface']);
    const rowEntries = Object.values(COCKPIT_ENTRIES).filter(e => e.location === 'view/item/context');
    expect(rowEntries.map(e => e.command).filter(c => !checked.has(c))).toEqual([]);
  });
});
