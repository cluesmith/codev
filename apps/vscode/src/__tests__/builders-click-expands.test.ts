/**
 * #1743 — `codev.buildersClickExpands` gates whether a builder-row click expands
 * the row (the changed-files list) in addition to opening the terminal.
 *
 * The decision core is `runBuilderRowClick`, extracted from the inline
 * `codev.openBuilderRow` handler so its on/off branch is provable without a live
 * terminal manager or tree view. These tests pin:
 *  - the `package.json` contribution (declared boolean, default true) so a key
 *    typo can't leave the setting silently inert;
 *  - the terminal always opens (both settings);
 *  - the row expands only when the setting is on (default true = unchanged);
 *  - a benign expand failure (row gone mid-cleanup) is swallowed after the
 *    terminal already opened;
 *  - the one accordion seam this feature owns: a disabled click never reveals,
 *    so it never fires `onDidExpandElement` and never disturbs the accordion;
 *    an enabled click does reveal, which feeds that path unchanged. The
 *    `AccordionGate` itself is covered in builders-accordion.test.ts.
 *
 * `builders.ts` imports `vscode` at module load, so we mock it per the
 * established `__tests__` pattern (see builders-accordion.test.ts) even though
 * `runBuilderRowClick` never touches it.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const { runBuilderRowClick } = await import('../views/builders.js');

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
) as { contributes: { configuration: { properties: Record<string, { type?: string; default?: unknown }> } } };

describe('codev.buildersClickExpands setting (manifest invariant) (#1743)', () => {
  it('is declared as a boolean with default true (behavior unchanged for existing users)', () => {
    // A silent typo here — in package.json or in the key extension.ts reads —
    // would make the setting inert while every behavioral test still passed, so
    // pin the declared contract directly (see contributes-review-queue.test.ts).
    const prop = PKG.contributes.configuration.properties['codev.buildersClickExpands'];
    expect(prop).toBeDefined();
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(true);
  });
});

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
  // The accordion is driven entirely by the chevron path
  // (`onDidExpandElement` → `AccordionGate`), which `runBuilderRowClick` never
  // touches. `AccordionGate`'s own behavior is covered in
  // builders-accordion.test.ts; here we pin the one seam this feature owns: a
  // disabled row click must not reach the accordion at all.
  it('a disabled row click never calls expandRow, so it never reveals → never fires onDidExpandElement', async () => {
    const expandRow = vi.fn(async () => {});
    await runBuilderRowClick(false, { openTerminal: async () => {}, expandRow });
    // No reveal({expand:true}) is attempted, so the accordion's
    // onDidExpandElement handler is never triggered by a click when the setting
    // is off — peers are left as the user arranged them. The chevron path,
    // unchanged, still fires onDidExpandElement and collapses peers.
    expect(expandRow).not.toHaveBeenCalled();
  });

  it('an enabled row click DOES reveal (expand), which is what feeds the accordion path', async () => {
    const expandRow = vi.fn(async () => {});
    await runBuilderRowClick(true, { openTerminal: async () => {}, expandRow });
    // reveal({expand:true}) fires onDidExpandElement, which the accordion
    // handler consumes to collapse peers — the pre-#1743 behavior, preserved.
    expect(expandRow).toHaveBeenCalledTimes(1);
  });
});
