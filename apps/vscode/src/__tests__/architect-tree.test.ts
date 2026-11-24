/**
 * Spec 1963 Phase 3: the Agents view's row building, moved out of `BuildersProvider` into the
 * reusable, workspace-scoped `ArchitectTreeBuilder` (`views/architect-tree.ts`).
 *
 * The equivalence block walks the whole Agents tree — every row, its parent, and the agent-cycle
 * roster — over N=0/1/>1 builders, on all three grouping axes, in flat and tree file modes. Its
 * snapshot (`__snapshots__/architect-tree.test.ts.snap`) was recorded from the pre-refactor
 * `BuildersProvider` in the same commit, so any change to an id, label, contextValue, command or
 * parent the Agents view renders fails here.
 *
 * Mocks `vscode` per the established `__tests__` pattern (see builders-autoreveal.test.ts).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type * as vscode from 'vscode';
import type { ArchitectState, OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import type { BuilderFileChange } from '../views/builder-diff-cache.js';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** A worktree path that does not exist: the review-file probe (existsSync) finds nothing. */
const MISSING_WORKTREE = join(tmpdir(), 'codev-test-missing-worktree');

/** Fixed clock, so wait-time suffixes in labels are deterministic. */
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

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

const { BuildersProvider } = await import('../views/builders.js');
const { ArchitectTreeBuilder, REMOTE_CONTEXT } = await import('../views/architect-tree.js');
const { architectGrouping } = await import('../views/builder-grouping.js');
const { BuilderTreeItem, BuilderGroupTreeItem, IdleArchitectsGroupTreeItem } = await import('../views/builder-tree-item.js');
const { BuilderFileTreeItem } = await import('../views/builder-file-tree-item.js');
const { BuilderFolderTreeItem } = await import('../views/builder-folder-tree-item.js');

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

function architect(name: string): ArchitectState {
  return { name, port: 0, pid: 0 } as ArchitectState;
}

function overview(
  builders: OverviewBuilder[],
  architects: ArchitectState[],
  extra: Partial<OverviewData> = {},
): OverviewData {
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

/** Diff cache double: a fixed file list per builder id, or an error. */
function fakeDiffCache(filesById: Record<string, BuilderFileChange[] | Error>) {
  return {
    getDiff: async (builderId: string) => {
      const files = filesById[builderId];
      if (files instanceof Error) { return { baseRef: 'main', files: [], error: files.message }; }
      return { baseRef: 'main', files: files ?? [] };
    },
  } as never;
}

const DIFFS = fakeDiffCache({
  'spir-10': [mk('README.md'), mk('src/views/a.ts'), mk('src/views/b.ts'), mk('src/extension.ts')],
  'air-11': new Error('git failed'),
  'bugfix-12': [mk('packages/x/y.ts')],
  'pir-1': [mk('src/only.ts')],
});

/**
 * N>1: every row kind the Agents tree renders.
 * - `spir-10`: blocked at a gate, owned by `main`.
 * - `air-11`: null owner (folds into `main`), served idle; its diff errors.
 * - `bugfix-12`: owned by sibling `web`, active, with held mail and queued feedback.
 * - `pir-13`: owned by `ghost`, an architect that is not live; needs input; no worktree.
 * - `aspir-14`: owned by `web`, PTY-silent past the threshold.
 * - roster: `main`, `web`, and two idle siblings (`demos`, `reviewer`) → the Idle Architects roll-up.
 */
const MANY = overview(
  [
    builder({ id: 'spir-10', issueId: '10', issueTitle: 'gated', protocol: 'spir', protocolPhase: 'plan',
      spawnedByArchitect: 'main', area: 'vscode', blocked: 'plan review', blockedGate: 'plan-approval',
      blockedSince: ago(120) }),
    builder({ id: 'air-11', issueId: '11', issueTitle: 'orphan', protocol: 'air', protocolPhase: 'implement',
      spawnedByArchitect: null, area: 'porch',
      agentState: { state: 'idle', since: ago(30), source: 'harness', alive: true, activity: null,
        activityAt: null, backgroundWork: false } }),
    builder({ id: 'bugfix-12', issueId: '12', issueTitle: 'busy', protocol: 'bugfix', protocolPhase: 'pr',
      spawnedByArchitect: 'web', area: 'vscode', heldCount: 2 }),
    builder({ id: 'pir-13', issueId: '13', issueTitle: 'asks', protocol: 'pir', protocolPhase: 'review',
      spawnedByArchitect: 'ghost', worktreePath: '',
      agentState: { state: 'needs-input', since: ago(5), source: 'harness', alive: true,
        activity: 'needs-input', activityAt: ago(5), backgroundWork: false,
        needsInput: { kind: 'question' } } as never }),
    builder({ id: 'aspir-14', issueId: '14', issueTitle: 'quiet', protocol: 'aspir', protocolPhase: 'specify',
      spawnedByArchitect: 'web', area: 'tower', lastDataAt: ago(600) }),
  ],
  [architect('main'), architect('web'), architect('demos'), architect('reviewer')],
  { heldCount: 3, queuedFeedback: { 'bugfix-12': 4 } },
);

const ONE = overview(
  [builder({ id: 'pir-1', issueId: '1', issueTitle: 'solo', spawnedByArchitect: 'main' })],
  [architect('main'), architect('reviewer')],
);

const NONE = overview([], [architect('main')]);

const SCENARIOS: Array<[string, OverviewData]> = [['N=0', NONE], ['N=1', ONE], ['N>1', MANY]];
const AXES = ['stage', 'area', 'architect'] as const;
const FILE_MODES: Array<[string, boolean]> = [['flat', false], ['tree', true]];

// ── Tree walk ─────────────────────────────────────────────────────────────────

interface TreeSource {
  getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]>;
  getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem>;
}

/** One line per rendered field, so a snapshot diff names exactly what moved. */
function describeRow(item: vscode.TreeItem): string {
  const icon = item.iconPath as { id: string; color?: { id: string } } | undefined;
  const command = item.command as { command: string; arguments?: unknown[] } | undefined;
  let commandText = '-';
  if (command) {
    const args = (command.arguments ?? []).map(a => (a === item ? '<self>' : JSON.stringify(a)));
    commandText = `${command.command}(${args.join(', ')})`;
  }
  return [
    `id=${item.id ?? '-'}`,
    `label=${String(item.label)}`,
    `desc=${item.description ?? '-'}`,
    `ctx=${item.contextValue ?? '-'}`,
    `state=${item.collapsibleState ?? '-'}`,
    `icon=${icon ? `${icon.id}/${icon.color?.id ?? '-'}` : '-'}`,
    `cmd=${commandText}`,
    `tip=${JSON.stringify(item.tooltip ?? null)}`,
  ].join(' | ');
}

/**
 * Every row of the tree, depth-first, each with the id `getParent` answers for it. Expands every
 * row that has a chevron (collapsed builder rows included), so changed-file rows are walked too.
 */
async function walk(source: TreeSource): Promise<string[]> {
  const lines: string[] = [];
  const visit = async (element: vscode.TreeItem | undefined, depth: number): Promise<void> => {
    for (const child of await source.getChildren(element)) {
      const parent = (await source.getParent(child)) as vscode.TreeItem | undefined;
      lines.push(`${'  '.repeat(depth)}${describeRow(child)} | parent=${parent?.id ?? 'root'}`);
      if (child.collapsibleState) { await visit(child, depth + 1); }
    }
  };
  await visit(undefined, 0);
  return lines;
}

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

function withConfig<T>(values: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  Object.assign(configValues, values);
  return run().finally(() => { for (const key of Object.keys(values)) { delete configValues[key]; } });
}

function agentsProvider(data: OverviewData) {
  const cache = { getData: () => data, onDidChange: () => ({ dispose() {} }) } as never;
  return new BuildersProvider(cache, DIFFS);
}

// ── Equivalence with the pre-refactor Agents view ─────────────────────────────

describe('Agents view rows are unchanged by the refactor (snapshot from the pre-refactor provider)', () => {
  for (const [scenario, data] of SCENARIOS) {
    for (const axis of AXES) {
      for (const [fileMode, asTree] of FILE_MODES) {
        it(`${scenario} · ${axis} axis · ${fileMode} files`, async () => {
          const rendered = await withConfig(
            { buildersGroupBy: axis, buildersFileViewAsTree: asTree },
            async () => {
              const provider = agentsProvider(data);
              return {
                rows: await walk(provider),
                cycle: provider.agentCycleOrder().map(t => (t.kind === 'builder' ? `builder:${t.id}` : `architect:${t.name}`)),
              };
            },
          );
          expect(rendered).toMatchSnapshot();
        });
      }
    }
  }
});

// ── ArchitectTreeBuilder ──────────────────────────────────────────────────────

type TreeOptions = ConstructorParameters<typeof ArchitectTreeBuilder>[0];

/** A Cockpit-style builder for this window's workspace: architect axis, acting rows. */
function actTree(data: OverviewData, scope: string, extra: Partial<TreeOptions> = {}) {
  return new ArchitectTreeBuilder({
    mode: 'act', scope, getData: () => data, grouping: architectGrouping, diffCache: DIFFS, ...extra,
  } as TreeOptions);
}

const TARGET = { path: '/work/other', active: true, name: 'other', isCurrent: false };

/** A builder for another workspace's rows: navigate-only. */
function navigateTree(data: OverviewData, scope: string, target: () => typeof TARGET = () => TARGET) {
  return new ArchitectTreeBuilder({ mode: 'navigate', scope, getData: () => data, target });
}

/** Every row of a builder's tree, depth-first (expanding everything with a chevron). */
async function allRows(tree: InstanceType<typeof ArchitectTreeBuilder>): Promise<vscode.TreeItem[]> {
  const rows: vscode.TreeItem[] = [];
  const visit = async (element: vscode.TreeItem | undefined): Promise<void> => {
    for (const child of await tree.getChildren(element)) {
      rows.push(child);
      if (child.collapsibleState) { await visit(child); }
    }
  };
  await visit(undefined);
  return rows;
}

function ids(rows: vscode.TreeItem[]): string[] {
  return rows.map(r => r.id).filter((id): id is string => id !== undefined);
}

function find<T extends vscode.TreeItem>(rows: vscode.TreeItem[], id: string): T {
  const row = rows.find(r => r.id === id);
  if (!row) { throw new Error(`no row ${id} in ${ids(rows).join(', ')}`); }
  return row as T;
}

/** Every `viewItem` test in `package.json`'s menus, as a predicate over a contextValue. */
function viewItemMatchers(): Array<{ when: string; matches: (value: string) => boolean }> {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
  const matchers: Array<{ when: string; matches: (value: string) => boolean }> = [];
  for (const entries of Object.values(pkg.contributes.menus as Record<string, Array<{ when?: string }>>)) {
    for (const entry of entries) {
      const when = entry.when ?? '';
      for (const m of when.matchAll(/viewItem\s*==\s*([\w.-]+)/g)) {
        matchers.push({ when, matches: v => v === m[1] });
      }
      for (const m of when.matchAll(/viewItem\s*=~\s*\/((?:[^/\\]|\\.)+)\/(\w*)/g)) {
        const re = new RegExp(m[1], m[2]);
        matchers.push({ when, matches: v => re.test(v) });
      }
    }
  }
  return matchers;
}

describe('row classes without a scope keep their pre-refactor ids', () => {
  it('builder, group, idle-container, folder and file rows', () => {
    const file = mk('src/a.ts');
    const node = { name: 'src', fullPath: 'src', children: [] };
    expect(new BuilderGroupTreeItem('main', 1, 2, { blocked: 0, idle: 0, active: 1 }).id).toBe('builder-group:main');
    expect(new IdleArchitectsGroupTreeItem(2).id).toBe('idle-architects-group');
    expect(new BuilderFolderTreeItem('pir-1', '/wt', 'main', node).id).toBe('pir-1::folder::src');
    expect(new BuilderFileTreeItem('pir-1', '/wt', 'main', file.change, file.plan).id).toBe('pir-1::src/a.ts');
    for (const row of [
      new BuilderTreeItem('pir-1', 'label'), new BuilderGroupTreeItem('main', 1, 2, { blocked: 0, idle: 0, active: 1 }),
      new IdleArchitectsGroupTreeItem(2), new BuilderFolderTreeItem('pir-1', '/wt', 'main', node),
      new BuilderFileTreeItem('pir-1', '/wt', 'main', file.change, file.plan),
    ]) {
      expect(row.scope).toBe('');
    }
  });
});

describe('ArchitectTreeBuilder: scoped ids', () => {
  it('prefixes every row id with its scope, including changed-file and folder rows', async () => {
    await withConfig({ buildersFileViewAsTree: true }, async () => {
      const rows = await allRows(actTree(MANY, 'ws:/a|'));
      expect(ids(rows).length).toBeGreaterThan(10);
      for (const id of ids(rows)) { expect(id.startsWith('ws:/a|')).toBe(true); }
      expect(ids(rows)).toEqual(expect.arrayContaining([
        'ws:/a|builder-group:main', 'ws:/a|spir-10#0', 'ws:/a|spir-10::folder::src',
        'ws:/a|spir-10::src/views/a.ts', 'ws:/a|idle-architects-group',
      ]));
      for (const row of rows) {
        if ('scope' in row) { expect((row as { scope: string }).scope).toBe('ws:/a|'); }
      }
    });
  });

  it('two scopes over workspaces that share `main` and a builder id produce disjoint ids', async () => {
    const shared = (owner: string) => overview(
      [builder({ id: 'x', spawnedByArchitect: owner }), builder({ id: 'pir-1', spawnedByArchitect: null })],
      [architect('main'), architect('web'), architect('demos'), architect('reviewer')],
    );
    for (const asTree of [false, true]) {
      await withConfig({ buildersFileViewAsTree: asTree }, async () => {
        const a = ids(await allRows(actTree(shared('main'), 'ws:/a|')));
        const b = ids(await allRows(actTree(shared('main'), 'ws:/b|')));
        const remote = ids(await allRows(navigateTree(shared('web'), 'ws:/c|')));
        expect(a.length).toBeGreaterThan(0);
        expect(a.filter(id => b.includes(id))).toEqual([]);
        expect(a.filter(id => remote.includes(id))).toEqual([]);
        expect(b.filter(id => remote.includes(id))).toEqual([]);
      });
    }
  });

  it('the accordion re-versions scoped rows without stacking the prefix', async () => {
    const tree = actTree(MANY, 'ws:/a|');
    const before = await tree.getChildren(find(await tree.getChildren(), 'ws:/a|builder-group:main'));
    const open = find<InstanceType<typeof BuilderTreeItem>>(before, 'ws:/a|spir-10#0');
    tree.keepOnlyOpen(open);
    const after = await tree.getChildren(find(await tree.getChildren(), 'ws:/a|builder-group:main'));
    expect(ids(after)).toEqual(['ws:/a|spir-10#0', 'ws:/a|air-11#1']);
  });

  it('keeps accordion state per builder: re-versioning one leaves another untouched', async () => {
    const a = actTree(MANY, 'ws:/a|');
    const b = actTree(MANY, 'ws:/b|');
    const mainRows = async (tree: typeof a, scope: string) =>
      ids(await tree.getChildren(find(await tree.getChildren(), `${scope}builder-group:main`)));
    a.keepOnlyOpen(find(await a.getChildren(find(await a.getChildren(), 'ws:/a|builder-group:main')), 'ws:/a|spir-10#0'));
    expect(await mainRows(a, 'ws:/a|')).toEqual(['ws:/a|spir-10#0', 'ws:/a|air-11#1']);
    expect(await mainRows(b, 'ws:/b|')).toEqual(['ws:/b|spir-10#0', 'ws:/b|air-11#0']);
  });

  it('refuses a row another builder made, in getChildren and getParent', async () => {
    const a = actTree(MANY, 'ws:/a|');
    const b = actTree(MANY, 'ws:/b|');
    const foreignGroup = find(await b.getChildren(), 'ws:/b|builder-group:main');
    const foreignBuilder = find(await b.getChildren(foreignGroup), 'ws:/b|spir-10#0');
    await expect(a.getChildren(foreignGroup)).rejects.toThrow("row of scope 'ws:/b|' routed here");
    await expect(a.getChildren(foreignBuilder)).rejects.toThrow("row of scope 'ws:/b|' routed here");
    expect(() => a.getParent(foreignBuilder)).toThrow("row of scope 'ws:/b|' routed here");
  });

  it('refuses an unrecognised row instead of rendering the root again', async () => {
    const tree = actTree(MANY, 'ws:/a|');
    const stray = { label: 'stray' } as vscode.TreeItem;
    await expect(tree.getChildren(stray)).rejects.toThrow("no children for unrecognised row 'stray'");
  });
});

describe('ArchitectTreeBuilder: act mode, scoped (this window in the Cockpit)', () => {
  it('names main vs a sibling in the architect rows\' contextValue; rows otherwise match the Agents view', async () => {
    const rows = await allRows(actTree(MANY, 'ws:/a|'));
    expect(find(rows, 'ws:/a|builder-group:main').contextValue).toBe('cockpit-architect-main');
    for (const name of ['web', 'ghost', 'demos', 'reviewer']) {
      const row = find(rows, `ws:/a|builder-group:${name}`);
      expect(row.contextValue).toBe('cockpit-architect-sibling');
      expect(row.command).toEqual({ command: 'codev.openArchitectTerminal', title: 'Open Architect Terminal', arguments: [name] });
    }
    // Builder and file rows keep the Agents view's contextValues and commands.
    const gated = find(rows, 'ws:/a|spir-10#0');
    expect(gated.contextValue).toBe('blocked-builder-spir');
    expect(gated.command).toEqual({ command: 'codev.openBuilderRow', title: 'Open Builder Terminal', arguments: [gated] });
    expect(find(rows, 'ws:/a|bugfix-12#0').contextValue).toBe('builder-bugfix');
    expect(find(rows, 'ws:/a|bugfix-12::packages/x/y.ts').contextValue).toBe('builder-file');
  });

  it('folds a builder with no recorded architect into main, and keeps a non-live architect\'s row', async () => {
    const tree = actTree(MANY, 'ws:/a|');
    const roots = await tree.getChildren();
    expect(ids(roots)).toEqual([
      'ws:/a|builder-group:main', 'ws:/a|builder-group:ghost', 'ws:/a|builder-group:web', 'ws:/a|idle-architects-group',
    ]);
    expect(ids(await tree.getChildren(find(roots, 'ws:/a|builder-group:main')))).toEqual(['ws:/a|spir-10#0', 'ws:/a|air-11#0']);
    // `ghost` is not in the live roster, but its builder still gets the row (and its click warns).
    const ghost = find(roots, 'ws:/a|builder-group:ghost');
    expect(String(ghost.label)).toBe('GHOST (1)');
    expect(ids(await tree.getChildren(ghost))).toEqual(['ws:/a|pir-13#0']);
  });

  it('rolls two idle siblings into Idle Architects, and a childless architect is a leaf', async () => {
    const tree = actTree(MANY, 'ws:/a|');
    const container = find<InstanceType<typeof IdleArchitectsGroupTreeItem>>(await tree.getChildren(), 'ws:/a|idle-architects-group');
    expect(container).toBeInstanceOf(IdleArchitectsGroupTreeItem);
    expect(container.contextValue).toBe('group-idle-architects');
    const idle = await tree.getChildren(container);
    expect(ids(idle)).toEqual(['ws:/a|builder-group:demos', 'ws:/a|builder-group:reviewer']);
    for (const row of idle) { expect(row.collapsibleState).toBe(0); }

    // One idle sibling stays a top-level leaf.
    const lone = find(await actTree(ONE, 'ws:/a|').getChildren(), 'ws:/a|builder-group:reviewer');
    expect(lone.collapsibleState).toBe(0);
    expect(lone.contextValue).toBe('cockpit-architect-sibling');
  });

  it('getParent chains file → folder → builder → architect, and idle sibling → container', async () => {
    await withConfig({ buildersFileViewAsTree: true }, async () => {
      const tree = actTree(MANY, 'ws:/a|');
      await tree.getChildren(); // the root render records each builder's architect row
      const file = await tree.findFileItem('spir-10', 'src/views/a.ts');
      expect(file?.id).toBe('ws:/a|spir-10::src/views/a.ts');
      const folder = (await tree.getParent(file!)) as InstanceType<typeof BuilderFolderTreeItem>;
      expect(folder).toBeInstanceOf(BuilderFolderTreeItem);
      expect(folder.id).toBe('ws:/a|spir-10::folder::src/views');
      const outer = (await tree.getParent(folder)) as vscode.TreeItem;
      expect(outer.id).toBe('ws:/a|spir-10::folder::src');
      const row = (await tree.getParent(outer)) as vscode.TreeItem;
      expect(row).toBeInstanceOf(BuilderTreeItem);
      expect(row.id).toBe('ws:/a|spir-10#0');
      expect(((await tree.getParent(row)) as vscode.TreeItem).id).toBe('ws:/a|builder-group:main');
      expect(await tree.getParent(find(await tree.getChildren(), 'ws:/a|builder-group:main'))).toBeUndefined();

      const demos = new BuilderGroupTreeItem('demos', 0, 0, { blocked: 0, idle: 0, active: 0 }, 'ws:/a|');
      expect(((await tree.getParent(demos)) as vscode.TreeItem).id).toBe('ws:/a|idle-architects-group');
    });
    await withConfig({ buildersFileViewAsTree: false }, async () => {
      const tree = actTree(MANY, 'ws:/a|');
      const file = await tree.findFileItem('spir-10', 'src/views/a.ts');
      expect(((await tree.getParent(file!)) as vscode.TreeItem).id).toBe('ws:/a|spir-10#0');
    });
  });

  it('reveals agent-cycle targets as scoped rows', async () => {
    const tree = actTree(MANY, 'ws:/a|');
    expect(tree.revealTargetForAgent({ kind: 'builder', id: 'bugfix-12' })?.id).toBe('ws:/a|bugfix-12#0');
    expect(tree.revealTargetForAgent({ kind: 'architect', name: 'web' })?.id).toBe('ws:/a|builder-group:web');
    expect(tree.agentCycleOrder()[0]).toEqual({ kind: 'architect', name: 'main' });
  });
});

describe('ArchitectTreeBuilder: navigate mode (another workspace\'s rows)', () => {
  it('builder rows are leaves; architect rows still expand to their builders', async () => {
    const tree = navigateTree(MANY, 'ws:/other|');
    const roots = await tree.getChildren();
    const main = find(roots, 'ws:/other|builder-group:main');
    expect(main.collapsibleState).toBe(2);
    const builders = await tree.getChildren(main);
    expect(ids(builders)).toEqual(['ws:/other|spir-10#0', 'ws:/other|air-11#0']);
    for (const row of builders) {
      expect(row.collapsibleState).toBe(0);
      expect(await tree.getChildren(row)).toEqual([]);
    }
    expect(await tree.findFileItem('spir-10', 'README.md')).toBeUndefined();
    expect(tree.revealTargetForAgent({ kind: 'builder', id: 'spir-10' })).toBeUndefined();
    // The agent cycle opens this window's terminals; another workspace's agents are not in it.
    expect(tree.agentCycleOrder()).toEqual([]);
  });

  it('every row clicks to open the workspace, and its tooltip names that workspace', async () => {
    const rows = await allRows(navigateTree(MANY, 'ws:/other|'));
    const clickable = rows.filter(r => !(r instanceof IdleArchitectsGroupTreeItem));
    expect(clickable.length).toBe(MANY.builders.length + 5); // 5 builders, 5 architect rows
    for (const row of clickable) {
      expect(row.command).toEqual({ command: 'codev.tower.openWorkspace', title: 'Open Workspace', arguments: [TARGET] });
      expect(String(row.tooltip)).toContain('In workspace other. Click to open its window');
    }
    // Same labels and glyphs as the acting rows.
    const acting = await allRows(actTree(MANY, 'ws:/other|'));
    const visible = (r: vscode.TreeItem) => `${String(r.label)} ${JSON.stringify(r.iconPath)}`;
    expect(clickable.map(visible)).toEqual(acting.filter(r => r.id && !(r instanceof IdleArchitectsGroupTreeItem)
      && !(r instanceof BuilderFileTreeItem) && !(r instanceof BuilderFolderTreeItem)).map(visible));
  });

  it('carries only navigate-only contextValues, none matched by any package.json menu', async () => {
    const rows = await allRows(navigateTree(MANY, 'ws:/other|'));
    const values = new Set(rows.map(r => r.contextValue));
    expect([...values].sort()).toEqual([REMOTE_CONTEXT.architect, REMOTE_CONTEXT.builder, REMOTE_CONTEXT.idleArchitects].sort());
    const matchers = viewItemMatchers();
    expect(matchers.length).toBeGreaterThan(20);
    for (const value of Object.values(REMOTE_CONTEXT)) {
      expect(value.startsWith('cockpit-remote-')).toBe(true);
      expect(matchers.filter(m => m.matches(value)).map(m => m.when)).toEqual([]);
    }
  });

  it('reads the target on every render, so a relabelled workspace stays current', async () => {
    let target = TARGET;
    const tree = navigateTree(ONE, 'ws:/other|', () => target);
    const first = find(await tree.getChildren(), 'ws:/other|builder-group:main');
    expect((first.command as { arguments: unknown[] }).arguments).toEqual([TARGET]);
    target = { ...TARGET, name: 'other (2)' };
    const second = find(await tree.getChildren(), 'ws:/other|builder-group:main');
    expect((second.command as { arguments: unknown[] }).arguments).toEqual([target]);
    expect(String(second.tooltip)).toContain('In workspace other (2).');
  });
});

describe('ArchitectTreeBuilder: attention', () => {
  it('appends held and queued counts to builder-row descriptions only when on', async () => {
    const on = await allRows(actTree(MANY, 'ws:/a|', { attention: true }));
    expect(find(on, 'ws:/a|bugfix-12#0').description).toBe('2 held · 4 queued');
    for (const id of ['ws:/a|spir-10#0', 'ws:/a|air-11#0', 'ws:/a|pir-13#0', 'ws:/a|aspir-14#0']) {
      expect(find(on, id).description).toBeUndefined();
    }
    const off = await allRows(actTree(MANY, 'ws:/a|'));
    expect(find(off, 'ws:/a|bugfix-12#0').description).toBeUndefined();

    const remote = await allRows(new ArchitectTreeBuilder({
      mode: 'navigate', scope: 'ws:/b|', getData: () => MANY, target: () => TARGET, attention: true,
    }));
    expect(find(remote, 'ws:/b|bugfix-12#0').description).toBe('2 held · 4 queued');
  });

  it('shows one count alone, and follows a new overview', async () => {
    let data = overview(
      [builder({ id: 'q', spawnedByArchitect: 'main' })], [architect('main')], { queuedFeedback: { q: 1 } },
    );
    const tree = actTree(data, '', { getData: () => data, attention: true } as Partial<TreeOptions>);
    const row = async () => (await tree.getChildren(find(await tree.getChildren(), 'builder-group:main')))[0];
    expect((await row()).description).toBe('1 queued');
    data = overview(
      [builder({ id: 'q', spawnedByArchitect: 'main', heldCount: 3 })], [architect('main')], { heldCount: 3 },
    );
    expect((await row()).description).toBe('3 held');
  });
});
