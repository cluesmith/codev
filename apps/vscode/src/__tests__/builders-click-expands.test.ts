/**
 * #1743 — `codev.buildersClickExpands` gates whether a builder-row click expands
 * the row (the changed-files list) in addition to opening the terminal.
 *
 * The decision core is `runBuilderRowClick`, extracted from the inline
 * `codev.openBuilderRow` handler so its on/off branch is provable without a live
 * terminal manager or tree view. These tests pin:
 *  - the terminal always opens (both settings);
 *  - the row expands only when the setting is on (default true = unchanged);
 *  - a benign expand failure (row gone mid-cleanup) is swallowed after the
 *    terminal already opened;
 *  - the chevron path (`onDidExpandElement` → `AccordionGate`) is orthogonal to
 *    the click setting, so the accordion keeps collapsing peers on a chevron
 *    expand regardless of `buildersClickExpands`.
 *
 * `builders.ts` imports `vscode` at module load, so we mock it per the
 * established `__tests__` pattern (see builders-accordion.test.ts) even though
 * `runBuilderRowClick` / `AccordionGate` never touch it.
 */

import { describe, it, expect, vi } from 'vitest';

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
      getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
    },
  };
});

const { runBuilderRowClick, AccordionGate } = await import('../views/builders.js');

describe('runBuilderRowClick (#1743)', () => {
  it('opens the terminal AND expands the row when the setting is on (default)', async () => {
    const openTerminal = vi.fn(async () => {});
    const expandRow = vi.fn(async () => {});

    await runBuilderRowClick(true, { openTerminal, expandRow });

    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(expandRow).toHaveBeenCalledTimes(1);
  });

  it('opens the terminal but does NOT expand the row when the setting is off', async () => {
    const openTerminal = vi.fn(async () => {});
    const expandRow = vi.fn(async () => {});

    await runBuilderRowClick(false, { openTerminal, expandRow });

    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(expandRow).not.toHaveBeenCalled();
  });

  it('opens the terminal before attempting the expand (order is terminal-first)', async () => {
    const calls: string[] = [];
    await runBuilderRowClick(true, {
      openTerminal: async () => { calls.push('terminal'); },
      expandRow: async () => { calls.push('expand'); },
    });
    expect(calls).toEqual(['terminal', 'expand']);
  });

  it('swallows a benign expand failure (row gone mid-cleanup) after the terminal opened', async () => {
    const openTerminal = vi.fn(async () => {});
    const expandRow = vi.fn(async () => { throw new Error('row no longer present'); });

    await expect(
      runBuilderRowClick(true, { openTerminal, expandRow }),
    ).resolves.toBeUndefined();
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(expandRow).toHaveBeenCalledTimes(1);
  });
});

describe('accordion is orthogonal to buildersClickExpands (#1743)', () => {
  it('the chevron path still collapses peers on an expand, regardless of the click setting', () => {
    // `AccordionGate` drives the `onDidExpandElement` (chevron) path and never
    // consults `buildersClickExpands`. A chevron expand — the way the file list
    // is opened when the click setting is off — still collapses peers.
    const gate = new AccordionGate(true);
    expect(gate.shouldCollapseOthers('a')).toBe(true);
    expect(gate.shouldCollapseOthers('b')).toBe(true);
  });

  it('runBuilderRowClick with the setting off never triggers an expand, so it never disturbs the accordion', async () => {
    const expandRow = vi.fn(async () => {});
    await runBuilderRowClick(false, { openTerminal: async () => {}, expandRow });
    // No reveal() → no onDidExpandElement fired → the accordion gate is untouched.
    expect(expandRow).not.toHaveBeenCalled();
  });
});
