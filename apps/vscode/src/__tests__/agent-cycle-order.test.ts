/**
 * Issue 1563 — the agent-terminal cycle roster (`agentCycleOrder`) that
 * `codev.focusNext/PreviousAgentTerminal` walk. These tests pin, through the
 * provider and the shared pure helper:
 *
 *  - the roster mirrors the Agents-view rendered order and is grouping-aware:
 *    stage/area axes cycle builders only (architects render no rows there);
 *    the architect axis interleaves architect headers with their builders,
 *    main-first, then populated siblings, then idle siblings last;
 *  - `orderForDisplay` is applied before grouping, so a blocked builder sorts
 *    ahead of an active one within the same architect;
 *  - the lone-`Uncategorized` area flatten yields builders only;
 *  - `partitionArchitectGroups` splits groups the same way both the renderer and
 *    the roster consume, so they cannot drift (#818);
 *  - anti-drift: the architect-kind entries of the roster equal the architect
 *    names the tree actually renders top-to-bottom (headers + idle-container
 *    children), the durable enforcement the #818 lesson prescribes.
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

const { BuildersProvider, partitionArchitectGroups, agentTargetIsFocused } = await import('../views/builders.js');
const { BuilderGroupTreeItem, IdleArchitectsGroupTreeItem, BuilderTreeItem } = await import('../views/builder-tree-item.js');
import type { AgentTarget } from '../views/builders.js';
import type { BuilderGroup } from '../views/builder-grouping.js';

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

/** Build a provider under `axis`, run `fn`, and restore the config. */
async function withAxis<T>(
  axis: 'stage' | 'area' | 'architect',
  builders: OverviewBuilder[],
  architects: ArchitectState[],
  fn: (provider: InstanceType<typeof BuildersProvider>) => T | Promise<T>,
): Promise<T> {
  configValues['buildersGroupBy'] = axis;
  try {
    return await fn(new BuildersProvider(fakeCache(builders, architects), fakeDiffCache));
  } finally {
    delete configValues['buildersGroupBy'];
  }
}

/** Compact roster notation for readable assertions: `A:name` / `B:id`. */
function label(t: AgentTarget): string {
  return t.kind === 'architect' ? `A:${t.name}` : `B:${t.id}`;
}

describe('partitionArchitectGroups (Issue 1563)', () => {
  const grp = (key: string, ids: string[]): BuilderGroup => ({
    key,
    items: ids.map(id => builder({ id })),
  });

  it('main with zero builders is top-level, never an idle sibling', () => {
    const { topLevel, idleSiblings } = partitionArchitectGroups([grp('main', [])]);
    expect(topLevel.map(g => g.key)).toEqual(['main']);
    expect(idleSiblings).toEqual([]);
  });

  it('peels zero-builder siblings into idle, keeps populated + main top-level in order', () => {
    const { topLevel, idleSiblings } = partitionArchitectGroups([
      grp('main', ['m']),
      grp('vscode', ['v']),
      grp('reviewer', []),
      grp('demos', []),
    ]);
    expect(topLevel.map(g => g.key)).toEqual(['main', 'vscode']);
    expect(idleSiblings.map(g => g.key)).toEqual(['reviewer', 'demos']);
  });
});

describe('agentCycleOrder (Issue 1563)', () => {
  it('empty workspace → empty roster', async () => {
    const order = await withAxis('stage', [], [architect('main')], p => p.agentCycleOrder());
    expect(order).toEqual([]);
  });

  it('stage axis: builders only (architects render no rows, so not cycled)', async () => {
    const order = await withAxis(
      'stage',
      [builder({ id: 'a', protocolPhase: 'implement' }), builder({ id: 'b', protocolPhase: 'implement' })],
      [architect('main')],
      p => p.agentCycleOrder(),
    );
    expect(order.every(t => t.kind === 'builder')).toBe(true);
    expect(order.map(label)).toEqual(['B:a', 'B:b']);
  });

  it('single builder → roster length 1 (the command no-ops on this)', async () => {
    const order = await withAxis('stage', [builder({ id: 'solo' })], [architect('main')], p => p.agentCycleOrder());
    expect(order.map(label)).toEqual(['B:solo']);
  });

  it('orderForDisplay is applied before grouping: a blocked builder sorts ahead of an active one', async () => {
    const order = await withAxis(
      'stage',
      [
        builder({ id: 'active', protocolPhase: 'implement' }),
        builder({ id: 'blkd', protocolPhase: 'implement', blocked: 'plan-approval', blockedGate: 'plan-approval' }),
      ],
      [architect('main')],
      p => p.agentCycleOrder(),
    );
    // Blocked bucket first (builders.ts orderForDisplay), regardless of input order.
    expect(order.map(label)).toEqual(['B:blkd', 'B:active']);
  });

  it('lone-Uncategorized area flatten: builders only, no architect entries', async () => {
    const order = await withAxis(
      'area',
      [builder({ id: 'a', area: 'Uncategorized' }), builder({ id: 'b', area: 'Uncategorized' })],
      [architect('main')],
      p => p.agentCycleOrder(),
    );
    expect(order.map(label)).toEqual(['B:a', 'B:b']);
  });

  it('architect axis: architect headers interleaved with their builders, main-first then populated siblings', async () => {
    const order = await withAxis(
      'architect',
      [
        builder({ id: 'm', spawnedByArchitect: 'main' }),
        builder({ id: 'v', spawnedByArchitect: 'vscode' }),
      ],
      [architect('main'), architect('vscode')],
      p => p.agentCycleOrder(),
    );
    expect(order.map(label)).toEqual(['A:main', 'B:m', 'A:vscode', 'B:v']);
  });

  it('architect axis: childless main + idle siblings appear as architect entries, idle last (alphabetical)', async () => {
    const order = await withAxis(
      'architect',
      [builder({ id: 'm', spawnedByArchitect: 'main' })],
      [architect('main'), architect('reviewer'), architect('demos')],
      p => p.agentCycleOrder(),
    );
    // main (+ its builder) first; the two idle siblings (0 builders) come last, alphabetical.
    expect(order.map(label)).toEqual(['A:main', 'B:m', 'A:demos', 'A:reviewer']);
  });
});

describe('agentTargetIsFocused — bridging the builder id spaces (Issue 1563 regression)', () => {
  const b = (id: string): AgentTarget => ({ kind: 'builder', id });
  const a = (name: string): AgentTarget => ({ kind: 'architect', name });

  it('matches the sidebar bare id against the terminal canonical id (the cycle-collapse bug)', () => {
    // Roster carries OverviewBuilder.id ('3816'); getActiveBuilderId reports Tower's
    // canonical id ('bugfix-3816'). A plain === misses, collapsing the cycle to index 0.
    expect(agentTargetIsFocused(b('3816'), 'bugfix-3816', null)).toBe(true);
  });

  it('matches the reverse direction (canonical roster id vs bare active id)', () => {
    expect(agentTargetIsFocused(b('bugfix-3816'), '3816', null)).toBe(true);
  });

  it('matches an exact id and rejects a different builder', () => {
    expect(agentTargetIsFocused(b('pir-1563'), 'pir-1563', null)).toBe(true);
    expect(agentTargetIsFocused(b('3816'), 'bugfix-1330', null)).toBe(false);
  });

  it('a builder target never matches when no builder terminal is focused', () => {
    expect(agentTargetIsFocused(b('3816'), null, 'main')).toBe(false);
  });

  it('architect targets match by exact name, and never against a null focus', () => {
    expect(agentTargetIsFocused(a('app'), null, 'app')).toBe(true);
    expect(agentTargetIsFocused(a('app'), null, 'main')).toBe(false);
    expect(agentTargetIsFocused(a('app'), 'bugfix-3816', null)).toBe(false);
  });
});

describe('revealTargetForAgent — sidebar selection follows the cycle (Issue 1563)', () => {
  it('a builder target yields the builder row (matches the rendered row for reveal)', async () => {
    await withAxis(
      'architect',
      [builder({ id: 'm', spawnedByArchitect: 'main' })],
      [architect('main')],
      (provider) => {
        const item = provider.revealTargetForAgent({ kind: 'builder', id: 'm' });
        expect(item).toBeInstanceOf(BuilderTreeItem);
        expect((item as InstanceType<typeof BuilderTreeItem>).builderId).toBe('m');
        expect(item!.id).toBeTruthy(); // a versioned id, so reveal can match it
      },
    );
  });

  it('an architect target yields a header carrying the stable builder-group id', async () => {
    await withAxis(
      'architect',
      [],
      [architect('main'), architect('app')],
      (provider) => {
        const item = provider.revealTargetForAgent({ kind: 'architect', name: 'app' });
        expect(item).toBeInstanceOf(BuilderGroupTreeItem);
        expect(item!.id).toBe('builder-group:app'); // matches the rendered header's id
      },
    );
  });

  it('returns undefined for a builder no longer in the cache', async () => {
    await withAxis('stage', [], [architect('main')], (provider) => {
      expect(provider.revealTargetForAgent({ kind: 'builder', id: 'gone' })).toBeUndefined();
    });
  });

  it('an idle-sibling architect (≥2 idle) parents to the "Idle Architects" container so reveal expands it', async () => {
    await withAxis(
      'architect',
      [],
      [architect('main'), architect('reviewer'), architect('brand')],
      async (provider) => {
        const item = provider.revealTargetForAgent({ kind: 'architect', name: 'brand' })!;
        const parent = await provider.getParent(item);
        expect(parent).toBeInstanceOf(IdleArchitectsGroupTreeItem);
        expect((parent as vscode.TreeItem).id).toBe('idle-architects-group'); // matches the rendered container
      },
    );
  });

  it('a top-level architect header has no parent (root)', async () => {
    await withAxis(
      'architect',
      [builder({ id: 'm', spawnedByArchitect: 'main' })],
      [architect('main')],
      async (provider) => {
        const item = provider.revealTargetForAgent({ kind: 'architect', name: 'main' })!;
        expect(await provider.getParent(item)).toBeUndefined();
      },
    );
  });

  it('a lone idle sibling renders top-level (no container), so it has no parent', async () => {
    await withAxis(
      'architect',
      [builder({ id: 'm', spawnedByArchitect: 'main' })],
      [architect('main'), architect('reviewer')], // reviewer is the only idle sibling
      async (provider) => {
        const item = provider.revealTargetForAgent({ kind: 'architect', name: 'reviewer' })!;
        expect(await provider.getParent(item)).toBeUndefined();
      },
    );
  });
});

describe('anti-drift: roster architect order equals the rendered architect order (#818)', () => {
  /** Architect names as the tree renders them top-to-bottom: top-level headers,
   *  then any idle-container children in render order. */
  async function renderedArchitectNames(
    provider: InstanceType<typeof BuildersProvider>,
  ): Promise<string[]> {
    const rows = await provider.getChildren();
    const names: string[] = [];
    for (const row of rows) {
      if (row instanceof BuilderGroupTreeItem) {
        names.push(row.groupName);
      } else if (row instanceof IdleArchitectsGroupTreeItem) {
        const children = await provider.getChildren(row);
        for (const c of children) {
          if (c instanceof BuilderGroupTreeItem) { names.push(c.groupName); }
        }
      }
    }
    return names;
  }

  it('matches with populated + a single idle sibling (lone row, no container)', async () => {
    await withAxis(
      'architect',
      [builder({ id: 'm', spawnedByArchitect: 'main' }), builder({ id: 'v', spawnedByArchitect: 'vscode' })],
      [architect('main'), architect('vscode'), architect('reviewer')],
      async (provider) => {
        const rendered = await renderedArchitectNames(provider);
        const rosterArchitects = provider.agentCycleOrder()
          .filter((t): t is Extract<AgentTarget, { kind: 'architect' }> => t.kind === 'architect')
          .map(t => t.name);
        expect(rosterArchitects).toEqual(rendered);
      },
    );
  });

  it('matches with an idle-architects container (≥2 idle siblings)', async () => {
    await withAxis(
      'architect',
      [builder({ id: 'm', spawnedByArchitect: 'main' })],
      [architect('main'), architect('reviewer'), architect('demos'), architect('ide')],
      async (provider) => {
        const rendered = await renderedArchitectNames(provider);
        const rosterArchitects = provider.agentCycleOrder()
          .filter((t): t is Extract<AgentTarget, { kind: 'architect' }> => t.kind === 'architect')
          .map(t => t.name);
        expect(rosterArchitects).toEqual(rendered);
      },
    );
  });
});
