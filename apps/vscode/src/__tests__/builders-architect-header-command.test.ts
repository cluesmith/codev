/**
 * #1108 — architect-axis group headers open the architect terminal on row click.
 *
 * In architect grouping mode the header is first-class, so (like a builder row)
 * a click on the header body opens that architect's terminal while the chevron
 * keeps toggling expand/collapse. This wires `codev.openArchitectTerminal` onto
 * the architect-header `TreeItem` with the architect name (`g.key`) as the
 * argument. Stage/area headers name no launchable entity, so they stay command-
 * less containers.
 *
 * These tests pin: architect headers carry the command with the right argument
 * (incl. the `main` fold for null `spawnedByArchitect`); stage and area headers
 * carry no command. Mocks `vscode` per the established `__tests__` pattern (see
 * builders-autoreveal.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';

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

function fakeCache(builders: OverviewBuilder[]) {
  const data = { builders, backlog: [], pendingPRs: [], recentlyClosed: [] } as unknown as OverviewData;
  return { getData: () => data, onDidChange: () => ({ dispose() {} }) } as never;
}

const fakeDiffCache = {} as never;

/** The group headers at root for the active grouping axis. */
async function groupHeaders(provider: InstanceType<typeof BuildersProvider>) {
  const roots = await provider.getChildren();
  return roots.filter(r => r instanceof BuilderGroupTreeItem) as InstanceType<typeof BuilderGroupTreeItem>[];
}

describe('architect-axis header command (#1108)', () => {
  it('carries codev.openArchitectTerminal with the architect name as the argument', async () => {
    configValues['buildersGroupBy'] = 'architect';
    try {
      const provider = new BuildersProvider(
        fakeCache([
          builder({ id: 'a', spawnedByArchitect: 'main' }),
          builder({ id: 'b', spawnedByArchitect: 'vscode' }),
        ]),
        fakeDiffCache,
      );
      const headers = await groupHeaders(provider);
      const byName = new Map(headers.map(h => [h.groupName, h.command as { command: string; arguments: unknown[] } | undefined]));

      expect(byName.get('main')).toEqual({
        command: 'codev.openArchitectTerminal',
        title: 'Open Architect Terminal',
        arguments: ['main'],
      });
      expect(byName.get('vscode')).toEqual({
        command: 'codev.openArchitectTerminal',
        title: 'Open Architect Terminal',
        arguments: ['vscode'],
      });
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('folds a null spawnedByArchitect into a main header that opens the main terminal', async () => {
    configValues['buildersGroupBy'] = 'architect';
    try {
      const provider = new BuildersProvider(
        fakeCache([builder({ id: 'a', spawnedByArchitect: null })]),
        fakeDiffCache,
      );
      const [header] = await groupHeaders(provider);
      expect(header.groupName).toBe('main');
      expect(header.command).toEqual({
        command: 'codev.openArchitectTerminal',
        title: 'Open Architect Terminal',
        arguments: ['main'],
      });
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('leaves stage headers without a command (pure grouping containers)', async () => {
    configValues['buildersGroupBy'] = 'stage';
    try {
      const provider = new BuildersProvider(
        fakeCache([builder({ id: 'a', spawnedByArchitect: 'main' })]),
        fakeDiffCache,
      );
      const headers = await groupHeaders(provider);
      expect(headers.length).toBeGreaterThan(0);
      for (const h of headers) {
        expect(h.command).toBeUndefined();
      }
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });

  it('leaves area headers without a command (pure grouping containers)', async () => {
    configValues['buildersGroupBy'] = 'area';
    try {
      const provider = new BuildersProvider(
        // Two distinct areas so the lone-Uncategorized flatten doesn't apply and
        // real area headers render.
        fakeCache([
          builder({ id: 'a', area: 'area/vscode' }),
          builder({ id: 'b', area: 'area/tower' }),
        ]),
        fakeDiffCache,
      );
      const headers = await groupHeaders(provider);
      expect(headers.length).toBeGreaterThan(0);
      for (const h of headers) {
        expect(h.command).toBeUndefined();
      }
    } finally {
      delete configValues['buildersGroupBy'];
    }
  });
});
