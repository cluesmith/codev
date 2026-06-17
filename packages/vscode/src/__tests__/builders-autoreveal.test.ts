/**
 * #1066 — sync the Builders sidebar selection with the active builder-diff file.
 *
 * Covers the groundwork that lets `buildersView.reveal(fileRow)` work:
 *  - `findParentNode` reconstructs a node's enclosing folder (top-level,
 *    nested, compacted chain, not-found) so `getParent` can build the chain up.
 *  - `BuilderFileTreeItem` carries a stable `<builderId>::<relPath>` id, unique
 *    per builder so two builders that changed the same path stay distinct.
 *  - `findFileItem` returns the row for the right builder; `getParent` resolves
 *    a file row's parent (builder row in flat mode, enclosing folder in tree
 *    mode). The live `reveal` glue is exercised manually at the dev-approval gate.
 *
 * Mocks `vscode` per the established `__tests__` pattern (see
 * builders-accordion.test.ts), extended with `Uri` + `ThemeIcon.Folder` that the
 * file/folder rows touch.
 */

import { describe, it, expect, vi } from 'vitest';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import type { BuilderFileChange } from '../views/builder-diff-cache.js';

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

const { BuildersProvider, findParentNode } = await import('../views/builders.js');
const { BuilderFileTreeItem } = await import('../views/builder-file-tree-item.js');
const { BuilderFolderTreeItem } = await import('../views/builder-folder-tree-item.js');
const { BuilderTreeItem } = await import('../views/builder-tree-item.js');
const { buildFilePathTree } = await import('../views/file-path-tree.js');

/** A `BuilderFileChange` whose only meaningful field is `plan.resourcePath`. */
function mk(relPath: string): BuilderFileChange {
  return {
    change: { status: 'M', oldPath: null, path: relPath },
    plan: { resourcePath: relPath, left: { kind: 'base', path: relPath }, right: { kind: 'file', path: relPath } },
  } as BuilderFileChange;
}

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

function fakeCache(builders: OverviewBuilder[]) {
  const data = { builders, backlog: [], pendingPRs: [], recentlyClosed: [] } as unknown as OverviewData;
  return { getData: () => data, onDidChange: () => ({ dispose() {} }) } as never;
}

/** Diff cache double: returns a fixed file list per builder id. */
function fakeDiffCache(filesById: Record<string, BuilderFileChange[]>) {
  return {
    getDiff: async (builderId: string) => ({
      baseRef: 'main',
      files: filesById[builderId] ?? [],
    }),
  } as never;
}

describe('findParentNode (#1066)', () => {
  const tree = buildFilePathTree([
    mk('README.md'),
    mk('packages/vscode/src/a.ts'),
    mk('packages/vscode/src/b.ts'),
  ]);

  it('returns undefined for a top-level node (no parent folder)', () => {
    expect(findParentNode(tree, 'README.md')).toBeUndefined();
  });

  it('returns undefined for a path not in the tree', () => {
    expect(findParentNode(tree, 'does/not/exist.ts')).toBeUndefined();
  });

  it('resolves the enclosing folder of a nested file via the compacted chain', () => {
    // `packages/vscode/src` compacts to a single folder node; the file's parent
    // is that compacted folder, not `packages`.
    const parent = findParentNode(tree, 'packages/vscode/src/a.ts');
    expect(parent?.fullPath).toBe('packages/vscode/src');
  });

  it('resolves a folder node to its parent folder (at its compacted fullPath)', () => {
    // Two sibling subtrees keep `packages` from compacting, so it stays a real
    // folder node. Each branch compacts to a single child folder:
    // `packages/vscode/src` and `packages/core` — those are the fullPaths a
    // folder row actually carries, and each resolves to `packages` as parent.
    const nested = buildFilePathTree([
      mk('packages/vscode/src/a.ts'),
      mk('packages/core/x.ts'),
    ]);
    expect(findParentNode(nested, 'packages/vscode/src')?.fullPath).toBe('packages');
    expect(findParentNode(nested, 'packages/core')?.fullPath).toBe('packages');
    expect(findParentNode(nested, 'packages')).toBeUndefined();
  });
});

describe('BuilderFileTreeItem id (#1066)', () => {
  it('is <builderId>::<relPath>', () => {
    const item = new BuilderFileTreeItem('pir-7', '/tmp/wt', 'main', mk('src/a.ts').change, mk('src/a.ts').plan);
    expect(item.id).toBe('pir-7::src/a.ts');
  });

  it('is unique per builder for the same relative path', () => {
    const a = new BuilderFileTreeItem('pir-1', '/tmp/wt', 'main', mk('src/a.ts').change, mk('src/a.ts').plan);
    const b = new BuilderFileTreeItem('pir-2', '/tmp/wt', 'main', mk('src/a.ts').change, mk('src/a.ts').plan);
    expect(a.id).not.toBe(b.id);
  });
});

describe('BuildersProvider.findFileItem (#1066)', () => {
  it('returns the file row for the requested builder', async () => {
    const provider = new BuildersProvider(
      fakeCache([builder({ id: 'pir-1' })]),
      fakeDiffCache({ 'pir-1': [mk('src/a.ts'), mk('src/b.ts')] }),
    );
    const item = await provider.findFileItem('pir-1', 'src/b.ts');
    expect(item).toBeInstanceOf(BuilderFileTreeItem);
    expect(item!.id).toBe('pir-1::src/b.ts');
  });

  it('resolves the correct builder when two builders changed the same path', async () => {
    const provider = new BuildersProvider(
      fakeCache([builder({ id: 'pir-1' }), builder({ id: 'pir-2' })]),
      fakeDiffCache({ 'pir-1': [mk('src/shared.ts')], 'pir-2': [mk('src/shared.ts')] }),
    );
    const item = await provider.findFileItem('pir-2', 'src/shared.ts');
    expect(item!.id).toBe('pir-2::src/shared.ts');
    expect((item as InstanceType<typeof BuilderFileTreeItem>).builderId).toBe('pir-2');
  });

  it('returns undefined when the file is not in the diff', async () => {
    const provider = new BuildersProvider(
      fakeCache([builder({ id: 'pir-1' })]),
      fakeDiffCache({ 'pir-1': [mk('src/a.ts')] }),
    );
    expect(await provider.findFileItem('pir-1', 'src/gone.ts')).toBeUndefined();
  });
});

describe('BuildersProvider.getParent for file rows (#1066)', () => {
  it('flat-list mode: a file row\'s parent is its builder row', async () => {
    configValues['buildersFileViewAsTree'] = false;
    try {
      const provider = new BuildersProvider(
        fakeCache([builder({ id: 'pir-1' })]),
        fakeDiffCache({ 'pir-1': [mk('packages/vscode/src/a.ts')] }),
      );
      const file = await provider.findFileItem('pir-1', 'packages/vscode/src/a.ts');
      const parent = await provider.getParent(file!);
      expect(parent).toBeInstanceOf(BuilderTreeItem);
      expect((parent as InstanceType<typeof BuilderTreeItem>).builderId).toBe('pir-1');
    } finally {
      delete configValues['buildersFileViewAsTree'];
    }
  });

  it('tree mode: a nested file row\'s parent is its enclosing folder row', async () => {
    // tree mode is the default (mock returns the supplied default = true).
    const provider = new BuildersProvider(
      fakeCache([builder({ id: 'pir-1' })]),
      fakeDiffCache({ 'pir-1': [mk('packages/vscode/src/a.ts'), mk('packages/vscode/src/b.ts')] }),
    );
    const file = await provider.findFileItem('pir-1', 'packages/vscode/src/a.ts');
    const parent = await provider.getParent(file!);
    expect(parent).toBeInstanceOf(BuilderFolderTreeItem);
    expect((parent as InstanceType<typeof BuilderFolderTreeItem>).id).toBe('pir-1::folder::packages/vscode/src');
  });

  it('tree mode: a top-level file row\'s parent is its builder row', async () => {
    const provider = new BuildersProvider(
      fakeCache([builder({ id: 'pir-1' })]),
      fakeDiffCache({ 'pir-1': [mk('README.md'), mk('packages/vscode/src/a.ts')] }),
    );
    const file = await provider.findFileItem('pir-1', 'README.md');
    const parent = await provider.getParent(file!);
    expect(parent).toBeInstanceOf(BuilderTreeItem);
  });
});
