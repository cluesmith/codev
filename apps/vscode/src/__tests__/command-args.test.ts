/**
 * How commands resolve their target from the argument VS Code passes them (`commands/command-args.ts`).
 * A `view/item/context` entry passes the tree element itself, so each resolver is pinned for the
 * Codev views' rows and for the Cockpit's (Spec 1963).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
  class TreeItem {
    id?: string;
    tooltip?: string;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    constructor(public label: string, public collapsibleState?: number) {}
  }
  class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
  class ThemeColor { constructor(public id: string) {} }
  return { TreeItem, ThemeIcon, ThemeColor, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 } };
});

const vscode = await import('vscode');
const { architectNameFromArg, extractBuilderId, extractIssueId } = await import('../commands/command-args.js');
const { BuilderGroupTreeItem, BuilderTreeItem } = await import('../views/builder-tree-item.js');

const NO_BUILDERS = { blocked: 0, idle: 0, active: 0 };

describe('architectNameFromArg (codev.removeArchitect)', () => {
  it("a Cockpit sibling architect row resolves to its groupName, not its display label", () => {
    const row = new BuilderGroupTreeItem('web', 0, vscode.TreeItemCollapsibleState.None, NO_BUILDERS, 'ws:/work/codev|');
    row.contextValue = 'cockpit-architect-sibling';
    expect(row.label).toBe('WEB (0)');
    expect(architectNameFromArg(row)).toBe('web');
  });

  it('a Workspace-view architect row resolves from its id (Issue 841 Gap 3), then its label', () => {
    const row = new vscode.TreeItem('WEB');
    row.id = 'workspace-architect-web';
    expect(architectNameFromArg(row)).toBe('web');
    const noId = new vscode.TreeItem('reviewer');
    expect(architectNameFromArg(noId)).toBe('reviewer');
  });

  it('a string is the name; anything else resolves to nothing', () => {
    expect(architectNameFromArg('demos')).toBe('demos');
    expect(architectNameFromArg(undefined)).toBeUndefined();
    expect(architectNameFromArg({ kind: 'workspace' })).toBeUndefined();
  });
});

describe('extractIssueId / extractBuilderId', () => {
  it('a Cockpit workspace node carries no issue id, so Spawn Builder opens its full picker', () => {
    const node = { kind: 'workspace', ws: { label: 'codev', isCurrent: true, entry: {} } };
    expect(extractIssueId(node)).toBeUndefined();
    expect(extractIssueId('42')).toBe('42');
    expect(extractIssueId({ issueId: '7', issueTitle: 't' })).toBe('7');
  });

  it("a Cockpit builder row resolves to its builder id, as an Agents row does", () => {
    const row = new BuilderTreeItem('spir-10', 'spir-10 gated', 'ws:/work/codev|');
    expect(extractBuilderId(row)).toBe('spir-10');
    expect(extractBuilderId('air-11')).toBe('air-11');
    expect(extractBuilderId({ kind: 'workspace' })).toBeUndefined();
  });
});
