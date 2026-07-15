/**
 * Issue 1182 — under the architect axis, idle **sibling** architects (zero
 * builders, never `main`) roll up under a single collapsed "Idle Architects"
 * container, but only when ≥ 2 are idle. This follows #1174 (childless
 * architects stay visible): with several quiet siblings, each childless row
 * displaced actual builder work, so they now fold into one collapsible node.
 *
 * These tests pin, through the provider:
 *  - 0 idle siblings → no container;
 *  - 1 idle sibling → its own top-level row (skip the container);
 *  - ≥ 2 idle siblings → a collapsed "Idle Architects (N)" container with a
 *    neutral idle glyph and NO command (header click only toggles), whose
 *    children are the individual architect rows (each opening its own terminal);
 *  - `main` is always its own row (populated or idle), never inside the group;
 *  - populated siblings stay their own top-level rows; ordering is
 *    main → populated siblings → idle container (bottom);
 *  - transitions (a builder appearing / disappearing) move an architect between
 *    the group and its own row on the next render;
 *  - stage/area axes are unaffected.
 *
 * Mocks `vscode` per the established `__tests__` pattern.
 */

import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ArchitectState, OverviewBuilder, OverviewData } from '@cluesmith/codev-types';

/** Per-test config overrides the mocked `workspace.getConfiguration` reads. */
const configValues: Record<string, unknown> = {};

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire = vi.fn((e: T) => { this.listeners.forEach((l) => l(e)); });
  }
  class TreeItem {
    id?: string;
    tooltip?: string;
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
    workspace: {
      getConfiguration: () => ({
        get: (key: string, def: unknown) => (key in configValues ? configValues[key] : def),
      }),
    },
  };
});

const { BuildersProvider } = await import('../views/builders.js');
const { BuilderGroupTreeItem, IdleArchitectsGroupTreeItem } = await import('../views/builder-tree-item.js');

function builder(overrides: Partial<OverviewBuilder>): OverviewBuilder {
  return {
    id: 'pir-1', issueId: '1', issueTitle: 't', phase: 'implement', protocolPhase: 'implement',
    mode: 'strict', gates: {}, worktreePath: '/tmp/wt', roleId: null, protocol: 'pir',
    planPhases: [], progress: 0, blocked: null, blockedGate: null, blockedSince: null,
    startedAt: null, idleMs: 0, lastDataAt: null, spawnedByArchitect: null,
    area: 'Uncategorized', prReady: false,
    ...overrides,
  } as OverviewBuilder;
}

function architect(name: string): ArchitectState {
  return { name, port: 0, pid: 0 } as ArchitectState;
}

function fakeCache(builders: OverviewBuilder[], architects: ArchitectState[]) {
  const data = { builders, architects, backlog: [], pendingPRs: [], recentlyClosed: [] } as unknown as OverviewData;
  return { getData: () => data, onDidChange: () => ({ dispose() {} }) } as never;
}

const fakeDiffCache = {} as never;

type Group = InstanceType<typeof BuilderGroupTreeItem>;
type IdleGroup = InstanceType<typeof IdleArchitectsGroupTreeItem>;
type ThemeIconLike = { id: string; color?: { id: string } };

/** Architect axis over the given builders/roster; returns the root rows. */
async function roots(builders: OverviewBuilder[], architects: ArchitectState[]) {
  configValues['buildersGroupBy'] = 'architect';
  try {
    const provider = new BuildersProvider(fakeCache(builders, architects), fakeDiffCache);
    return { provider, rows: await provider.getChildren() };
  } finally {
    delete configValues['buildersGroupBy'];
  }
}

function architectRows(rows: vscode.TreeItem[]): Group[] {
  return rows.filter(r => r instanceof BuilderGroupTreeItem) as Group[];
}

function idleContainer(rows: vscode.TreeItem[]): IdleGroup | undefined {
  return rows.find(r => r instanceof IdleArchitectsGroupTreeItem) as IdleGroup | undefined;
}

describe('idle-architects grouping under the architect axis (Issue 1182)', () => {
  it('fresh workspace (main only, no siblings): MAIN renders, no idle container', async () => {
    const { rows } = await roots([], [architect('main')]);
    expect(idleContainer(rows)).toBeUndefined();
    const groups = architectRows(rows);
    expect(groups.map(g => g.groupName)).toEqual(['main']);
    expect(groups[0].label).toContain('(0)');
  });

  it('1 idle sibling: renders as its own top-level row, no container', async () => {
    const { rows } = await roots(
      [builder({ id: 'a', spawnedByArchitect: 'main' })],
      [architect('main'), architect('reviewer')],
    );
    expect(idleContainer(rows)).toBeUndefined();
    const groups = architectRows(rows);
    expect(groups.map(g => g.groupName)).toEqual(['main', 'reviewer']);
    expect(groups.find(g => g.groupName === 'reviewer')!.collapsibleState).toBe(0); // None
  });

  it('2 idle siblings: folds into a collapsed "Idle Architects (2)" container', async () => {
    const { rows } = await roots(
      [builder({ id: 'a', spawnedByArchitect: 'main' })],
      [architect('main'), architect('reviewer'), architect('demos')],
    );
    // MAIN stays its own row; the two idle siblings are NOT top-level rows.
    const groups = architectRows(rows);
    expect(groups.map(g => g.groupName)).toEqual(['main']);
    const container = idleContainer(rows);
    expect(container).toBeDefined();
    expect(container!.label).toBe('Idle Architects (2)');
    expect(container!.collapsibleState).toBe(1); // Collapsed by default
  });

  it('4 idle siblings, everyone idle: MAIN own row + "Idle Architects (4)"', async () => {
    const { rows } = await roots(
      [],
      [architect('main'), architect('reviewer'), architect('demos'), architect('ide'), architect('mobile')],
    );
    const groups = architectRows(rows);
    expect(groups.map(g => g.groupName)).toEqual(['main']);
    expect(groups[0].label).toContain('(0)');
    expect(idleContainer(rows)!.label).toBe('Idle Architects (4)');
  });

  it('main is always its own row, never inside the idle container, even at zero builders', async () => {
    const { rows } = await roots(
      [],
      [architect('main'), architect('reviewer'), architect('demos')],
    );
    const groups = architectRows(rows);
    expect(groups.map(g => g.groupName)).toEqual(['main']);
    expect(idleContainer(rows)!.label).toBe('Idle Architects (2)');
  });

  it('ordering: main, then populated siblings, then the idle container at the bottom', async () => {
    const { rows } = await roots(
      [
        builder({ id: 'm', spawnedByArchitect: 'main' }),
        builder({ id: 'v', spawnedByArchitect: 'vscode' }),
      ],
      [architect('main'), architect('vscode'), architect('reviewer'), architect('demos')],
    );
    // Row order: MAIN (populated) → VSCODE (populated sibling) → Idle Architects (2).
    const kinds = rows.map(r => {
      if (r instanceof IdleArchitectsGroupTreeItem) { return 'idle-group'; }
      if (r instanceof BuilderGroupTreeItem) { return r.groupName; }
      return 'other';
    });
    expect(kinds).toEqual(['main', 'vscode', 'idle-group']);
  });

  it('the idle container has a neutral idle glyph and NO command (header click only toggles)', async () => {
    const { rows } = await roots(
      [],
      [architect('main'), architect('reviewer'), architect('demos')],
    );
    const container = idleContainer(rows)!;
    const icon = container.iconPath as ThemeIconLike;
    expect(icon.id).toBe('circle-outline');
    expect(icon.color?.id).toBe('disabledForeground');
    expect(container.command).toBeUndefined();
    expect(container.contextValue).toBe('group-idle-architects');
  });

  it('expanding the container yields the individual idle architect rows, each opening its terminal', async () => {
    // The container's children are recomputed from the cache on expansion, so the
    // axis config must stay set across BOTH getChildren calls (roots() restores it
    // in its finally, so drive the provider directly here).
    configValues['buildersGroupBy'] = 'architect';
    try {
      const provider = new BuildersProvider(
        fakeCache([], [architect('main'), architect('reviewer'), architect('demos')]),
        fakeDiffCache,
      );
      const container = idleContainer(await provider.getChildren())!;
      const children = architectRows(await provider.getChildren(container));
      // reviewer + demos, sorted alphabetically (main is excluded — it is its own row).
      expect(children.map(c => c.groupName).sort()).toEqual(['demos', 'reviewer']);
      for (const c of children) {
        expect(c.collapsibleState).toBe(0); // None — leaf-like, no empty accordion
        expect(c.command).toEqual({
          command: 'codev.openArchitectTerminal',
          title: 'Open Architect Terminal',
          arguments: [c.groupName],
        });
      }
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('transition — a sibling gaining a builder graduates out of the idle container into its own row', async () => {
    // reviewer is populated; demos + ide idle → only 2 idle siblings → container of 2.
    const { rows } = await roots(
      [
        builder({ id: 'a', spawnedByArchitect: 'main' }),
        builder({ id: 'r', spawnedByArchitect: 'reviewer' }),
      ],
      [architect('main'), architect('reviewer'), architect('demos'), architect('ide')],
    );
    const groups = architectRows(rows);
    // main + reviewer are populated top-level rows; demos + ide fold into the container.
    expect(groups.map(g => g.groupName)).toEqual(['main', 'reviewer']);
    expect(idleContainer(rows)!.label).toBe('Idle Architects (2)');
  });

  it('transition — dropping to 1 idle sibling dissolves the container back to a lone row', async () => {
    // demos populated, ide populated → only reviewer idle → 1 idle sibling → no container.
    const { rows } = await roots(
      [
        builder({ id: 'd', spawnedByArchitect: 'demos' }),
        builder({ id: 'i', spawnedByArchitect: 'ide' }),
      ],
      [architect('main'), architect('reviewer'), architect('demos'), architect('ide')],
    );
    expect(idleContainer(rows)).toBeUndefined();
    const groups = architectRows(rows);
    expect(groups.map(g => g.groupName)).toEqual(['main', 'demos', 'ide', 'reviewer']);
    expect(groups.find(g => g.groupName === 'reviewer')!.collapsibleState).toBe(0); // None
  });

  it('stage axis is unaffected — no idle container regardless of idle architects', async () => {
    configValues['buildersGroupBy'] = 'stage';
    try {
      const provider = new BuildersProvider(
        fakeCache(
          [builder({ id: 'a', spawnedByArchitect: 'main', protocolPhase: 'implement' })],
          [architect('main'), architect('reviewer'), architect('demos')],
        ),
        fakeDiffCache,
      );
      const rows = await provider.getChildren();
      expect(idleContainer(rows)).toBeUndefined();
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });
});
