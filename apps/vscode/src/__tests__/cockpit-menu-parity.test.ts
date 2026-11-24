/**
 * Spec 1963 Phase 5: the Cockpit's menu parity. `views/cockpit-menu-map.ts` is the checked-in oracle:
 * one record per source-view menu entry, Workspace-view row click and `viewsWelcome` entry. This test
 * holds `package.json` and the providers to it. It fails when:
 * - a source entry has no record, or differs from its record's snapshot;
 * - a mapped Cockpit entry is missing from `package.json` (or a Cockpit entry maps to no record);
 * - a navigate-only value (`cockpit-remote-*`, another workspace's `tower-workspace-*`) or this
 *   window's workspace row value matches a builder or architect entry's `viewItem`;
 * - the builder-worktree parent row could reach Spawn Builder, New Shell or Add Architect;
 * - *Remove Architect*'s `when` matches `cockpit-architect-main`;
 * - a Workspace-view row click or a welcome entry has no record.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OverviewData } from '@cluesmith/codev-types';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { ResolvedWorktreeConfig } from '../load-worktree-config.js';

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
    constructor(public label: string, public collapsibleState?: number) {}
  }
  class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
  class ThemeColor { constructor(public id: string) {} }
  return {
    EventEmitter: FakeEventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    workspace: { getConfiguration: () => ({ get: (_key: string, def: unknown) => def }) },
  };
});

const { MENU_RECORDS, ROW_CLICK_RECORDS, WELCOME_RECORDS, COCKPIT_ENTRIES } = await import('../views/cockpit-menu-map.js');
const { CockpitProvider, cockpitWorkspaceContext, DEV_SLOT_KINDS } = await import('../views/cockpit.js');
const { WorkspaceProvider } = await import('../views/workspace.js');
const { REMOTE_CONTEXT } = await import('../views/architect-tree.js');

type MenuEntry = (typeof MENU_RECORDS)[number]['source'];
type CockpitProviderType = InstanceType<typeof CockpitProvider>;

const PKG = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
const LOCATIONS = ['view/item/context', 'view/title'] as const;
const ALL_ENTRIES: MenuEntry[] = LOCATIONS.flatMap(location =>
  (PKG.contributes.menus[location] as Array<Omit<MenuEntry, 'location'>>).map(e => ({ location, ...e })));
// Anywhere in the clause, not only leading: an entry written `codev.hasFoo && view == codev.agents`
// must not escape the oracle.
const SOURCE_VIEW = /\bview == codev\.(workspace|agents|tower)( |\)|$)/;
const SOURCE_ENTRIES = ALL_ENTRIES.filter(e => SOURCE_VIEW.test(e.when));
const COCKPIT_MENU = ALL_ENTRIES.filter(e => /\bview == codev\.cockpit( |\)|$)/.test(e.when));

const key = (e: MenuEntry) => JSON.stringify([e.location, e.command, e.when, e.group ?? null]);
const COCKPIT_KEYS = new Set(COCKPIT_MENU.map(key));

/** The Cockpit entry a `same` record names: the source entry at the Cockpit's view. */
function sameAtCockpit(source: MenuEntry): MenuEntry {
  return { ...source, when: source.when.replace(SOURCE_VIEW, 'view == codev.cockpit$2') };
}

/** Whether a `when` clause's `viewItem` condition accepts `value` (`false` when it has none). */
function viewItemMatches(when: string, value: string): boolean {
  const regex = when.match(/viewItem =~ \/(.+?)\/(?: |$)/);
  if (regex) { return new RegExp(regex[1]).test(value); }
  const exact = when.match(/viewItem == (\S+)/);
  if (exact) { return exact[1] === value; }
  return false;
}

// Every contextValue a Cockpit row can carry, by who owns the row.
const ROLES = ['current', 'parent'] as const;
const ownValues = (role: (typeof ROLES)[number]) =>
  DEV_SLOT_KINDS.flatMap(slot => [false, true].map(urls => cockpitWorkspaceContext(role, slot, urls)));
const CURRENT_VALUES = ownValues('current');
const PARENT_VALUES = ownValues('parent');
const OTHER_WORKSPACE_VALUES = ['tower-workspace-active', 'tower-workspace-dormant'];
const NAVIGATE_VALUES = Object.values(REMOTE_CONTEXT);

/** Cockpit entries that act on this window's builder or architect rows. */
const AGENT_ROW_ENTRIES = [
  ...MENU_RECORDS.filter(r => r.source.when.startsWith('view == codev.agents') && r.source.location === 'view/item/context')
    .map(r => sameAtCockpit(r.source)),
  COCKPIT_ENTRIES.removeArchitect,
];

// ── Menu entries ─────────────────────────────────────────────────────────────

describe('every source-view menu entry has exactly one record, and matches its snapshot', () => {
  it('a source view is recognised anywhere in a when clause, and only that view', () => {
    expect(SOURCE_VIEW.test('codev.hasFoo && view == codev.agents')).toBe(true);
    expect(SOURCE_VIEW.test('(view == codev.tower)')).toBe(true);
    expect(SOURCE_VIEW.test('view == codev.agentsExtra')).toBe(false);
    expect(SOURCE_VIEW.test('view == codev.cockpit')).toBe(false);
  });

  it('27 source entries today: 18 row entries and 9 title-bar entries', () => {
    expect(SOURCE_ENTRIES.filter(e => e.location === 'view/item/context')).toHaveLength(18);
    expect(SOURCE_ENTRIES.filter(e => e.location === 'view/title')).toHaveLength(9);
    expect(MENU_RECORDS).toHaveLength(27);
  });

  for (const entry of SOURCE_ENTRIES) {
    it(`${entry.location} ${entry.command} (${entry.group})`, () => {
      const records = MENU_RECORDS.filter(r => key(r.source) === key(entry));
      expect(records, 'no record for this entry, or it differs from its record\'s snapshot').toHaveLength(1);
    });
  }

  it('no record names an entry that package.json no longer has', () => {
    const live = new Set(SOURCE_ENTRIES.map(key));
    expect(MENU_RECORDS.filter(r => !live.has(key(r.source))).map(r => r.source)).toEqual([]);
  });
});

describe("every record's Cockpit placement is in package.json", () => {
  for (const record of MENU_RECORDS) {
    const { source, cockpit } = record;
    if ('same' in cockpit) {
      it(`same: ${source.command} (${source.group}) at ${cockpit.same}`, () => {
        const expected = sameAtCockpit(source);
        expect(COCKPIT_KEYS.has(key(expected)), `missing ${JSON.stringify(expected)}`).toBe(true);
        expect(expected.when).toContain(cockpit.same);
      });
    } else if ('relocated' in cockpit) {
      it(`relocated: ${source.command} (${source.group})`, () => {
        for (const target of cockpit.relocated) {
          expect(COCKPIT_KEYS.has(key(target)), `missing ${JSON.stringify(target)}`).toBe(true);
        }
      });
    }
  }

  it('only the three group-by cycle buttons are excluded, each with its reason', () => {
    const excluded = MENU_RECORDS.filter(r => 'excluded' in r.cockpit);
    expect(excluded.map(r => r.source.command).sort()).toEqual([
      'codev.agentsCycleGroupFromArchitect', 'codev.agentsCycleGroupFromArea', 'codev.agentsCycleGroupFromStage',
    ]);
    for (const r of excluded) { expect((r.cockpit as { excluded: string }).excluded.length).toBeGreaterThan(20); }
  });

  it('every Cockpit menu entry is one some record maps to (no unrecorded additions)', () => {
    const mapped = new Set<string>();
    for (const { source, cockpit } of MENU_RECORDS) {
      if ('same' in cockpit) { mapped.add(key(sameAtCockpit(source))); }
      if ('relocated' in cockpit) { cockpit.relocated.forEach(e => mapped.add(key(e))); }
    }
    for (const { cockpit } of ROW_CLICK_RECORDS) {
      if ('relocated' in cockpit) { cockpit.relocated.forEach(e => mapped.add(key(e))); }
    }
    expect(COCKPIT_MENU.filter(e => !mapped.has(key(e)))).toEqual([]);
  });
});

// ── contextValues: nothing attaches where it must not ────────────────────────

describe('context values: menus attach only to the rows they belong to', () => {
  it('no navigate-only row or workspace row matches a builder or architect entry', () => {
    const forbidden = [...NAVIGATE_VALUES, ...OTHER_WORKSPACE_VALUES, ...CURRENT_VALUES, ...PARENT_VALUES];
    const hits = AGENT_ROW_ENTRIES.flatMap(e => forbidden.filter(v => viewItemMatches(e.when, v)).map(v => `${e.command} ← ${v}`));
    expect(hits).toEqual([]);
  });

  it("the builder-worktree parent row reaches no spawn, shell or architect action; other workspaces' rows no own-row action", () => {
    const ownOnly = [COCKPIT_ENTRIES.spawnInline, COCKPIT_ENTRIES.shellInline, COCKPIT_ENTRIES.addArchitectInline,
      COCKPIT_ENTRIES.spawn, COCKPIT_ENTRIES.shell, COCKPIT_ENTRIES.addArchitect];
    const parentHits = ownOnly.flatMap(e => PARENT_VALUES.filter(v => viewItemMatches(e.when, v)).map(v => `${e.command} ← ${v}`));
    expect(parentHits).toEqual([]);
    const workspaceRowEntries = [...ownOnly, COCKPIT_ENTRIES.openWebInterface, COCKPIT_ENTRIES.startDev,
      COCKPIT_ENTRIES.stopDev, COCKPIT_ENTRIES.stopOtherDev, COCKPIT_ENTRIES.openDevUrl];
    const remoteHits = workspaceRowEntries.flatMap(e =>
      [...NAVIGATE_VALUES, ...OTHER_WORKSPACE_VALUES].filter(v => viewItemMatches(e.when, v)).map(v => `${e.command} ← ${v}`));
    expect(remoteHits).toEqual([]);
  });

  it("Remove Architect attaches to a sibling architect row, never to main's", () => {
    expect(viewItemMatches(COCKPIT_ENTRIES.removeArchitect.when, 'cockpit-architect-sibling')).toBe(true);
    expect(viewItemMatches(COCKPIT_ENTRIES.removeArchitect.when, 'cockpit-architect-main')).toBe(false);
    for (const entry of COCKPIT_MENU.filter(e => e.command === 'codev.removeArchitect')) {
      expect(viewItemMatches(entry.when, 'cockpit-architect-main')).toBe(false);
    }
  });

  it("this window's row offers exactly what the Workspace view offers for its dev slot and dev URLs", () => {
    const rowEntries = {
      spawn: COCKPIT_ENTRIES.spawn, shell: COCKPIT_ENTRIES.shell, addArchitect: COCKPIT_ENTRIES.addArchitect,
      web: COCKPIT_ENTRIES.openWebInterface, start: COCKPIT_ENTRIES.startDev, stop: COCKPIT_ENTRIES.stopDev,
      'stop-other': COCKPIT_ENTRIES.stopOtherDev, urls: COCKPIT_ENTRIES.openDevUrl,
    };
    for (const role of ROLES) {
      for (const slot of DEV_SLOT_KINDS) {
        for (const urls of [false, true]) {
          const value = cockpitWorkspaceContext(role, slot, urls);
          const offered = Object.entries(rowEntries).filter(([, e]) => viewItemMatches(e.when, value)).map(([name]) => name).sort();
          const expected = ['web'];
          if (role === 'current') { expected.push('spawn', 'shell', 'addArchitect'); }
          if (slot !== 'none') { expected.push(slot); }
          if (urls) { expected.push('urls'); }
          expect(offered, value).toEqual(expected.sort());
        }
      }
    }
  });
});

// ── Workspace-view row clicks ────────────────────────────────────────────────

const HERE = '/work/codev';
const noEvent = () => ({ dispose() {} });
const ALL_ON: ResolvedWorktreeConfig = {
  symlinks: [], postSpawn: [], devCommand: 'pnpm dev',
  devUrls: [{ label: 'App', url: 'http://localhost:3000' }, { label: 'Admin', url: 'http://localhost:3001' }],
};

/** Every row the Workspace view renders with `devs` running, Architects expanded. */
async function workspaceViewRows(devs: string[]) {
  const connectionManager = {
    getState: () => 'connected',
    getWorkspacePath: () => HERE,
    getWindowRoot: () => HERE,
    getBuilderWorktree: () => null,
    getClient: () => ({
      getWorktreeConfig: async () => ALL_ON,
      getWorkspaceStatus: async () => ({
        terminals: [{ type: 'architect', architectName: 'main' }, { type: 'architect', architectName: 'web' }],
      }),
    }),
    onStateChange: noEvent,
    onSSEEvent: noEvent,
  };
  const terminalManager = {
    listDevTerminals: () => devs.map((builderId, i) => ({ builderId, terminalId: `t${i}` })),
    onDidChangeDevTerminals: noEvent,
  };
  const view = new WorkspaceProvider(connectionManager as never, terminalManager as never);
  const top = await view.getChildren();
  const architects = await view.getChildren(top.find(r => r.id === 'workspace-architects-root'));
  return [...top, ...architects];
}

/** A Cockpit over one active workspace (this window's) whose overview lists `main` and a sibling. */
function cockpitWith(opts: { fleetLoaded?: boolean; connection?: 'auto' | 'manual' | 'none'; state?: string } = {}): CockpitProviderType {
  const data = { builders: [], architects: [{ name: 'main' }, { name: 'web' }], backlog: [], pendingPRs: [], recentlyClosed: [] } as unknown as OverviewData;
  return new CockpitProvider({
    connectionManager: {
      getState: () => opts.state ?? 'connected',
      getWorkspacePath: () => HERE,
      getWindowRoot: () => HERE,
      onStateChange: noEvent,
      onSSEEvent: noEvent,
    } as never,
    terminalManager: { listDevTerminals: () => [], onDidChangeDevTerminals: noEvent },
    loadWorktreeConfig: async () => null,
    towerCache: {
      getFleet: () => [{ workspace: { path: HERE, name: 'codev', active: true, proxyUrl: '', terminals: 1 }, attention: deriveAttention(data), overview: data }],
      isLoaded: () => opts.fleetLoaded ?? true,
      getOverview: () => data,
      onDidChange: noEvent,
    } as never,
    overviewCache: { getData: () => data, onDidChange: noEvent } as never,
    diffCache: {} as never,
    builderWorktreeWindow: false,
    connection: opts.connection ?? 'auto',
  });
}

describe('every Workspace-view row click has a record', () => {
  it('across the three dev states, every clickable row and its command is recorded', async () => {
    const seen = new Map<string, string>();
    for (const devs of [[], ['main'], ['spir-10']]) {
      for (const row of await workspaceViewRows(devs)) {
        const command = (row.command as { command?: string } | undefined)?.command;
        if (command && row.contextValue) { seen.set(row.contextValue, command); }
      }
    }
    expect([...seen.entries()].sort()).toEqual(ROW_CLICK_RECORDS.map(r => [r.row, r.command]).sort());
  });

  it("architect rows' click moves onto the Cockpit's architect rows, main and sibling", async () => {
    const cockpit = cockpitWith();
    const [root] = await cockpit.getChildren();
    const [ws] = await cockpit.getChildren(root);
    const architects = (await cockpit.getChildren(ws)).map(n => cockpit.getTreeItem(n));
    for (const record of ROW_CLICK_RECORDS) {
      if (!('rowClick' in record.cockpit)) { continue; }
      const { contextValue, command } = record.cockpit.rowClick;
      const rows = architects.filter(r => contextValue.test(r.contextValue ?? ''));
      expect(rows.length, `${record.row} → a Cockpit row matching ${contextValue}`).toBeGreaterThan(0);
      for (const row of rows) { expect((row.command as { command: string }).command).toBe(command); }
    }
  });
});

// ── viewsWelcome ─────────────────────────────────────────────────────────────

describe("every viewsWelcome entry of the three views has a record", () => {
  it('the records snapshot exactly the welcome entries package.json declares for them', () => {
    const welcome = (PKG.contributes.viewsWelcome as Array<{ view: string; contents: string; when: string }>)
      .filter(w => /^codev\.(workspace|agents|tower)$/.test(w.view));
    expect(welcome).toEqual(WELCOME_RECORDS.map(r => r.source));
  });

  it("each mapped welcome is a state row the Cockpit's Tower root shows in that kind of window", async () => {
    for (const { cockpit } of WELCOME_RECORDS) {
      if (!('stateRow' in cockpit)) {
        expect('excluded' in cockpit && cockpit.excluded.length > 20).toBe(true);
        continue;
      }
      const { window, label, command } = cockpit.stateRow;
      const provider = window === 'dormant'
        ? cockpitWith({ fleetLoaded: false, connection: 'none', state: 'disconnected' })
        : cockpitWith({ fleetLoaded: false, connection: 'auto', state: 'connecting' });
      const [root] = await provider.getChildren();
      const [row] = (await provider.getChildren(root)).map(n => provider.getTreeItem(n));
      expect(row.label).toBe(label);
      if (command) { expect((row.command as { command: string }).command).toBe(command); }
    }
  });
});

describe('the Cockpit-only command stays out of the palette', () => {
  // The Workspace view's Open Web Interface row is not a palette command either; this command
  // exists only to give that row a Cockpit menu entry.
  it('codev.cockpit.openWebInterface is contributed and hidden from the command palette', () => {
    const commands = PKG.contributes.commands as Array<{ command: string }>;
    expect(commands.some(c => c.command === 'codev.cockpit.openWebInterface')).toBe(true);
    const palette = PKG.contributes.menus.commandPalette as Array<{ command: string; when?: string }>;
    expect(palette.filter(e => e.command === 'codev.cockpit.openWebInterface')).toEqual([
      { command: 'codev.cockpit.openWebInterface', when: 'false' },
    ]);
  });
});
