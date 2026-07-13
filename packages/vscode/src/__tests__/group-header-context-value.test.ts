/**
 * Group-header rows must NOT surface builder-scoped context-menu entries (#1170).
 *
 * Agents-tree group headers (architect / phase / area axis, plus the Backlog
 * view) are `AreaGroupTreeItem`s. Their `contextValue` is what VSCode matches
 * the `view/item/context` menu `when` regexes against. The seven builder-scoped
 * commands gate on the state-family prefix `/^(builder|blocked-builder|
 * awaiting-builder)-/`.
 *
 * The bug: the header contextValue was built as `${kind}-group`, so a builder
 * group header got `builder-group` — which matches `^builder-` and surfaced all
 * seven entries. Each silently no-ops on a header (the handlers narrow via
 * `instanceof BuilderTreeItem`), so the menu was pure noise. The fix flips the
 * template to `group-${kind}` (`group-builder`), moving the family token off the
 * front so none of the regexes match.
 *
 * This test derives the contextValue from the REAL `AreaGroupTreeItem` and feeds
 * it to the actual package.json regexes. Reverting the source to `${kind}-group`
 * makes the header value `builder-group` again, matches the regexes, and fails
 * these assertions — which a hardcoded string wouldn't catch.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('vscode', () => {
  class TreeItem {
    id?: string;
    contextValue?: string;
    constructor(public label: string, public collapsibleState?: number) {}
  }
  return {
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
});

// Import AFTER the mock is registered.
const vscode = await import('vscode');
const { AreaGroupTreeItem } = await import('../views/area-group-tree-item.js');

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);
const viewItemMenuEntries: Array<{ command: string; when: string }> =
  PKG.contributes.menus['view/item/context'];

/**
 * The seven builder-scoped commands whose `when` gates on the state-family
 * prefix regex. Two (run/stopWorktreeDev) append `&& codev.hasDevCommand`, so
 * the regex isn't at the tail of the clause — extract it tolerantly.
 */
const BUILDER_SCOPED = [
  'codev.openBuilderById',
  'codev.viewDiff',
  'codev.openWorktreeWindow',
  'codev.openWorktreeFolder',
  'codev.runWorktreeSetup',
  'codev.runWorktreeDev',
  'codev.stopWorktreeDev',
] as const;

function viewItemRegex(command: string): RegExp {
  const entry = viewItemMenuEntries.find(
    e => e.command === command && e.when.includes('view == codev.agents'));
  if (!entry) {
    throw new Error(`No agents view/item/context entry for ${command}`);
  }
  const m = entry.when.match(/viewItem =~ \/(.+?)\/(?:\s|$)/);
  if (!m) {
    throw new Error(`No viewItem regex in when clause: ${entry.when}`);
  }
  return new RegExp(m[1]);
}

/** contextValue of a group header for the given kind, from the real class. */
function headerContextValue(kind: 'builder' | 'backlog'): string {
  const header = new AreaGroupTreeItem(
    'area/tower', kind, 2, vscode.TreeItemCollapsibleState.Expanded);
  return header.contextValue!;
}

describe('group-header rows reject builder-scoped menu entries (#1170)', () => {
  it('AreaGroupTreeItem puts the group token first (group-<kind>)', () => {
    expect(headerContextValue('builder')).toBe('group-builder');
    expect(headerContextValue('backlog')).toBe('group-backlog');
  });

  for (const command of BUILDER_SCOPED) {
    const regex = viewItemRegex(command);

    it(`${command} is hidden for a builder group header`, () => {
      expect(regex.test(headerContextValue('builder')),
        `${command} menu for builder group header`).toBe(false);
    });

    it(`${command} is hidden for a backlog group header`, () => {
      expect(regex.test(headerContextValue('backlog')),
        `${command} menu for backlog group header`).toBe(false);
    });

    it(`${command} still shows for a builder row (guards against over-tightening)`, () => {
      expect(regex.test('builder-bugfix'),
        `${command} for builder-bugfix`).toBe(true);
    });
  }
});
