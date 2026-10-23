/**
 * Unit tests for the Builders-view accordion + ephemeral group expansion (#913).
 *
 * The accordion collapses the OTHER builder rows when one is expanded, without
 * touching group headers. VSCode has no "collapse this row" API and never forgets
 * a row id it has seen expanded, so `BuildersProvider` collapses a row by
 * re-rendering it under a fresh `<builderId>#<gen>` id (a generation it has never
 * seen → the provider's default Collapsed state applies). The open builder is
 * pinned to its own generation so its id is stable and it stays expanded; group
 * headers carry no suffix and always render Expanded.
 *
 * These tests pin: the generation-suffixed ids, that the open builder's id is
 * stable while every other builder's id churns, that a collapsed builder never
 * reuses a previously-rendered id, that group ids are stable and Expanded, and
 * that the change event fires. Mocks `vscode` per the established `__tests__`
 * pattern (see overview-cache.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A worktree path that does not exist: the review-file probe (existsSync) finds nothing. */
const MISSING_WORKTREE = join(tmpdir(), 'codev-test-missing-worktree');

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
      // Provider reads `buildersGroupBy` (→ 'stage') and `buildersFileViewAsTree`;
      // returning the supplied default for every key is enough here.
      getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
    },
  };
});

// Import AFTER the mock is registered.
const vscode = await import('vscode');
const { BuildersProvider, AccordionRowIds, AccordionGate } = await import('../views/builders.js');
const { BuilderTreeItem, BuilderGroupTreeItem } = await import('../views/builder-tree-item.js');

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

/** Minimal OverviewCache double: a fixed builder list + a no-op change hook. */
function fakeCache(builders: OverviewBuilder[]) {
  const data = { builders, backlog: [], pendingPRs: [], recentlyClosed: [] } as unknown as OverviewData;
  return { getData: () => data, onDidChange: () => ({ dispose() {} }) } as never;
}

const fakeDiffCache = {} as never;

/** Build a provider over three builders that all land in one stage group. */
function makeProvider() {
  const builders = [
    builder({ id: 'a' }),
    builder({ id: 'b' }),
    builder({ id: 'c' }),
  ];
  return new BuildersProvider(fakeCache(builders), fakeDiffCache);
}

/** The builder rows under the (single) group, by builderId → rendered id. */
async function renderRowIds(provider: InstanceType<typeof BuildersProvider>): Promise<Map<string, string>> {
  const groups = await provider.getChildren();
  const group = groups.find((g): g is InstanceType<typeof BuilderGroupTreeItem> => g instanceof BuilderGroupTreeItem)!;
  const rows = await provider.getChildren(group);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r instanceof BuilderTreeItem) { out.set(r.builderId, r.id!); }
  }
  return out;
}

async function rowFor(provider: InstanceType<typeof BuildersProvider>, builderId: string): Promise<InstanceType<typeof BuilderTreeItem>> {
  const groups = await provider.getChildren();
  const group = groups.find((g): g is InstanceType<typeof BuilderGroupTreeItem> => g instanceof BuilderGroupTreeItem)!;
  const rows = await provider.getChildren(group);
  return rows.find((r): r is InstanceType<typeof BuilderTreeItem> => r instanceof BuilderTreeItem && r.builderId === builderId)!;
}

describe('BuildersProvider accordion (#913)', () => {
  it('builder rows render with a generation suffix; initial generation is 0', async () => {
    const provider = makeProvider();
    const ids = await renderRowIds(provider);
    expect(ids.get('a')).toBe('a#0');
    expect(ids.get('b')).toBe('b#0');
    expect(ids.get('c')).toBe('c#0');
  });

  it('collapseBuildersExcept keeps the open builder id stable and churns the rest', async () => {
    const provider = makeProvider();
    const bRow = await rowFor(provider, 'b');
    provider.collapseBuildersExcept(bRow);

    const ids = await renderRowIds(provider);
    expect(ids.get('b')).toBe('b#0');   // open builder pinned — stays expanded
    expect(ids.get('a')).toBe('a#1');   // others get a fresh, never-seen id
    expect(ids.get('c')).toBe('c#1');
  });

  it('group headers keep stable ids and always render Expanded across accordion fires', async () => {
    const provider = makeProvider();
    const groupsBefore = await provider.getChildren();
    const gBefore = groupsBefore.find((g): g is InstanceType<typeof BuilderGroupTreeItem> => g instanceof BuilderGroupTreeItem)!;
    expect(gBefore.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    const groupId = gBefore.id;

    provider.collapseBuildersExcept(await rowFor(provider, 'a'));

    const groupsAfter = await provider.getChildren();
    const gAfter = groupsAfter.find((g): g is InstanceType<typeof BuilderGroupTreeItem> => g instanceof BuilderGroupTreeItem)!;
    expect(gAfter.id).toBe(groupId);                                      // stable id — not re-generationed
    expect(gAfter.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it('when a builder goes from open to collapsed, it never resurrects its old expanded id', async () => {
    // The poisoning hazard: VSCode remembers `X#k` as expanded while X is the
    // open builder. If X later collapses and re-renders at `X#k`, VSCode would
    // pop it back open. The monotonic generation guarantees the collapsing
    // builder always lands on a higher, never-expanded generation.
    const provider = makeProvider();

    // a becomes the open (expanded) builder, holding the id it was clicked at.
    const aOpen = (await rowFor(provider, 'a')).id;
    provider.collapseBuildersExcept(await rowFor(provider, 'a'));
    expect((await renderRowIds(provider)).get('a')).toBe(aOpen); // still open, id held

    // b becomes open → a transitions to collapsed. a must NOT reuse aOpen.
    const bOpen = (await rowFor(provider, 'b')).id;
    provider.collapseBuildersExcept(await rowFor(provider, 'b'));
    expect((await renderRowIds(provider)).get('a')).not.toBe(aOpen);

    // a becomes open again → b transitions to collapsed. b must NOT reuse bOpen.
    provider.collapseBuildersExcept(await rowFor(provider, 'a'));
    expect((await renderRowIds(provider)).get('b')).not.toBe(bOpen);
  });

  it('pins the open generation from the clicked row, not the live counter', async () => {
    const provider = makeProvider();
    // Two fires advance the counter; the second clicks a row rendered at the
    // first fire's generation. The open builder must keep THAT id, not snap to
    // a stale generation.
    provider.collapseBuildersExcept(await rowFor(provider, 'a')); // gen → 1, a pinned at 0
    const cRow = await rowFor(provider, 'c');                     // c rendered at #1
    expect(cRow.id).toBe('c#1');
    provider.collapseBuildersExcept(cRow);                        // gen → 2, c pinned at 1

    const ids = await renderRowIds(provider);
    expect(ids.get('c')).toBe('c#1');   // pinned to its own rendered generation
    expect(ids.get('a')).toBe('a#2');
    expect(ids.get('b')).toBe('b#2');
  });

  it('fires the tree-data change event on each accordion fire', async () => {
    const provider = makeProvider();
    const onChange = vi.fn();
    provider.onDidChangeTreeData(onChange);
    provider.collapseBuildersExcept(await rowFor(provider, 'a'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('AccordionRowIds (#913)', () => {
  it('versions every id from 0 until the first keepOnly', () => {
    const ids = new AccordionRowIds();
    expect(ids.idFor('a')).toBe('a#0');
    expect(ids.idFor('b')).toBe('b#0');
  });

  it('holds the open builder at its clicked id and re-versions the rest', () => {
    const ids = new AccordionRowIds();
    ids.keepOnly('b', 'b#0');
    expect(ids.idFor('b')).toBe('b#0'); // open — verbatim
    expect(ids.idFor('a')).toBe('a#1'); // others — bumped
  });

  it('never reuses a version, so a re-opened builder lands on a fresh id', () => {
    const ids = new AccordionRowIds();
    ids.keepOnly('a', ids.idFor('a')); // a held at a#0, version → 1
    ids.keepOnly('b', ids.idFor('b')); // b held at b#1, version → 2; a now collapsing
    expect(ids.idFor('a')).toBe('a#2'); // not a#0 — its old expanded id is never resurrected
  });

  it('falls back to a versioned id when the open row has no id', () => {
    const ids = new AccordionRowIds();
    ids.keepOnly('a', undefined);
    expect(ids.idFor('a')).toBe('a#1');
  });
});

describe('AccordionGate (#913)', () => {
  it('collapses others on the first expand, but not on a re-expand of the open row', () => {
    const gate = new AccordionGate(true);
    expect(gate.shouldCollapseOthers('a')).toBe(true);  // a becomes open
    expect(gate.shouldCollapseOthers('a')).toBe(false); // re-fire guard
    expect(gate.shouldCollapseOthers('b')).toBe(true);  // switching opens b
  });

  it('never collapses while disabled', () => {
    const gate = new AccordionGate(false);
    expect(gate.shouldCollapseOthers('a')).toBe(false);
    expect(gate.shouldCollapseOthers('b')).toBe(false);
  });

  // Regression for the Codex review finding: toggling the accordion off, opening
  // another builder, then toggling back on must let the NEXT expand collapse the
  // rest — even when that next expand is the builder that was open before the
  // toggle. Without resetting the guard on toggle, re-expanding 'a' was skipped
  // and the other rows stayed open.
  it('re-collapses after disable → open another → re-enable, even on the previously-open row', () => {
    const gate = new AccordionGate(true);
    gate.shouldCollapseOthers('a');     // a open, accordion on
    gate.setEnabled(false);             // toggle off
    gate.shouldCollapseOthers('b');     // user opens b manually (no collapse while off)
    gate.setEnabled(true);              // toggle back on
    expect(gate.shouldCollapseOthers('a')).toBe(true); // re-expanding a collapses the rest
  });
});
