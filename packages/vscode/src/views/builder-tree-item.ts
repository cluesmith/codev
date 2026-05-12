import * as vscode from 'vscode';

/**
 * TreeItem subclass that carries a builder id as a typed field.
 *
 * Why: VSCode passes the tree item itself (not its `command.arguments`)
 * to commands invoked from `view/item/context` menus. The new #690
 * commands (codev.reviewDiff, codev.runWorktreeDev, codev.stopWorktreeDev)
 * need to know which builder was right-clicked, so the views construct
 * builder rows with this class and the command handlers narrow via
 * `instanceof BuilderTreeItem` to read `.builderId` safely.
 *
 * Used by views/builders.ts and views/needs-attention.ts.
 */
export class BuilderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly builderId: string,
    label: string,
  ) {
    super(label);
  }
}
