/**
 * Issue 1174 — under the architect axis, every registered architect gets a group
 * header even when it owns no builders. Before the fix, an architect's row
 * vanished from the Agents view the moment its last builder was cleaned up
 * (headers were sourced only from the builders array's `spawnedByArchitect`
 * values). The fix sources the header set from the architect roster
 * (`OverviewData.architects`) the overview cache already carries.
 *
 * These tests pin, through the provider: a childless architect renders a `(0)`
 * header that (a) is leaf-like (`None` — no empty accordion), (b) carries the
 * click-to-open-terminal command, and (c) shows a neutral idle glyph rather than
 * the worst-of tri-state green/yellow. They also pin that stage/area axes are
 * unaffected (roster ignored). Mocks `vscode` per the `__tests__` pattern.
 */

import { describe, it, expect, vi } from 'vitest';
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
const { BuilderGroupTreeItem } = await import('../views/builder-tree-item.js');

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
  return { name, port: 0, pid: 0 };
}

function fakeCache(builders: OverviewBuilder[], architects: ArchitectState[]) {
  const data = { builders, architects, backlog: [], pendingPRs: [], recentlyClosed: [] } as unknown as OverviewData;
  return { getData: () => data, onDidChange: () => ({ dispose() {} }) } as never;
}

const fakeDiffCache = {} as never;

type Header = InstanceType<typeof BuilderGroupTreeItem>;
type ThemeIconLike = { id: string; color?: { id: string } };

async function groupHeaders(provider: InstanceType<typeof BuildersProvider>): Promise<Header[]> {
  const roots = await provider.getChildren();
  return roots.filter(r => r instanceof BuilderGroupTreeItem) as Header[];
}

describe('childless-architect headers under the architect axis (Issue 1174)', () => {
  it('emits a (0) header for every registered architect when there are no builders', async () => {
    configValues['buildersGroupBy'] = 'architect';
    try {
      const provider = new BuildersProvider(
        fakeCache([], [architect('main'), architect('reviewer'), architect('security')]),
        fakeDiffCache,
      );
      const headers = await groupHeaders(provider);
      expect(headers.map(h => h.groupName)).toEqual(['main', 'reviewer', 'security']);
      // Count in the label + leaf-like state (None) — no empty accordion.
      for (const h of headers) {
        expect(h.label).toContain('(0)');
        expect(h.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
      }
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('keeps a childless architect visible alongside a populated one, each with its count', async () => {
    configValues['buildersGroupBy'] = 'architect';
    try {
      const provider = new BuildersProvider(
        fakeCache(
          [
            builder({ id: 'a', spawnedByArchitect: 'main' }),
            builder({ id: 'b', spawnedByArchitect: 'main' }),
          ],
          [architect('main'), architect('reviewer')],
        ),
        fakeDiffCache,
      );
      const headers = await groupHeaders(provider);
      const byName = new Map(headers.map(h => [h.groupName, h]));
      expect([...byName.keys()]).toEqual(['main', 'reviewer']);
      expect(byName.get('main')!.label).toContain('(2)');
      expect(byName.get('main')!.collapsibleState).toBe(2); // Expanded
      expect(byName.get('reviewer')!.label).toContain('(0)');
      expect(byName.get('reviewer')!.collapsibleState).toBe(0); // None
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('a childless header still opens the architect terminal on click', async () => {
    configValues['buildersGroupBy'] = 'architect';
    try {
      const provider = new BuildersProvider(
        fakeCache([], [architect('main'), architect('reviewer')]),
        fakeDiffCache,
      );
      const headers = await groupHeaders(provider);
      const reviewer = headers.find(h => h.groupName === 'reviewer')!;
      expect(reviewer.command).toEqual({
        command: 'codev.openArchitectTerminal',
        title: 'Open Architect Terminal',
        arguments: ['reviewer'],
      });
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('a childless header uses a neutral idle glyph, not the yellow attention bell', async () => {
    configValues['buildersGroupBy'] = 'architect';
    try {
      const provider = new BuildersProvider(
        fakeCache([], [architect('main')]),
        fakeDiffCache,
      );
      const [header] = await groupHeaders(provider);
      const icon = header.iconPath as ThemeIconLike;
      expect(icon.id).toBe('circle-outline');
      expect(icon.color?.id).toBe('disabledForeground');
      expect(header.tooltip).toBe('No builders');
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('stage axis ignores the roster — no childless-architect headers appear', async () => {
    configValues['buildersGroupBy'] = 'stage';
    try {
      const provider = new BuildersProvider(
        fakeCache(
          [builder({ id: 'a', spawnedByArchitect: 'main', protocolPhase: 'implement' })],
          [architect('main'), architect('reviewer'), architect('security')],
        ),
        fakeDiffCache,
      );
      const headers = await groupHeaders(provider);
      // Stage headers are lifecycle stages, never architect names.
      expect(headers.map(h => h.groupName)).not.toContain('reviewer');
      expect(headers.map(h => h.groupName)).not.toContain('security');
      for (const h of headers) {
        expect(h.command).toBeUndefined();
      }
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });
});
