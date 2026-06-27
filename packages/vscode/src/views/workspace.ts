import * as vscode from 'vscode';
import { encodeWorkspacePath } from '@cluesmith/codev-core/workspace';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';
import { getTowerAddress } from '../workspace-detector.js';
import { resolveWorkspaceDevTarget } from '../commands/dev-shared.js';
import { loadWorktreeConfig, hasRunnableDevCommand } from '../load-worktree-config.js';
import { displayArchitectName } from './architect-display.js';

/**
 * Workspace-level entry points: architect terminal, Tower web dashboard,
 * spawn builder, and new shell. Sits at the top of the Codev sidebar so
 * common workspace actions are one click away, not buried in the palette.
 */
export class WorkspaceProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private connectionManager: ConnectionManager,
    private terminalManager: TerminalManager,
  ) {
    connectionManager.onStateChange(() => this.changeEmitter.fire());
    // Re-render when the dev-terminal set changes (start/stop, a swap that
    // killed this workspace's dev, or cleanup) so the conditional "Stop Dev
    // Server" row reflects reality across every path.
    terminalManager.onDidChangeDevTerminals(() => this.changeEmitter.fire());
    // Tower fans out a `codev-config-updated` SSE event whenever
    // .codev/config(.local).json changes (server-side file watcher in
    // codev-config-watcher.ts), and a `architects-updated` event
    // whenever an architect is added or removed (Spec 823 — closes the
    // gap where the Architects tree went stale when add/remove happened
    // via CLI outside VSCode). We re-render on either signal.
    //
    // Tower emits events as a JSON envelope on the SSE `data:` field
    // with no `event:` name (see builder-spawn-handler.ts for the same
    // gotcha), so the SSE-client-level `type` is always '' and the
    // real type sits inside the envelope.
    //
    // No workspace filter at the SSE-subscriber layer: VSCode is opened
    // against one workspace at a time, and `WorkspaceProvider` is
    // workspace-scoped at construction. Mirrors the existing
    // `codev-config-updated` subscriber's unconditional-fire behaviour.
    connectionManager.onSSEEvent(({ data }) => {
      try {
        const envelope = JSON.parse(data) as { type?: unknown };
        if (envelope.type === 'codev-config-updated' || envelope.type === 'architects-updated') {
          this.changeEmitter.fire();
        }
      } catch {
        // benign — malformed envelope
      }
    });
  }

  /**
   * Spec 786 Phase 6: imperative refresh entry point so commands like
   * `codev.removeArchitect` (and any future `codev.addArchitect` UI) can
   * force the sidebar to re-render after they mutate Tower state. Without
   * this, the expanded "Architects" section would stay stale until another
   * SSE event happened to fire.
   */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Spec 786 Phase 6: when expanding the "Architects" parent, return one
    // child per registered architect. The parent is identified by its id so
    // we don't need a sentinel field on every other TreeItem.
    if (element?.id === 'workspace-architects-root') {
      return this.getArchitectChildren();
    }

    const items: vscode.TreeItem[] = [];

    // Spec 786 Phase 6: expandable "Architects" tree section, replacing the
    // pre-786 singleton "Open Architect" row. Collapsed = "Architects" only;
    // expanded = "Architects > main" (and any siblings).
    const architectsRoot = new vscode.TreeItem(
      'Architects',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    architectsRoot.id = 'workspace-architects-root';
    architectsRoot.iconPath = new vscode.ThemeIcon('person');
    architectsRoot.tooltip = 'Workspace architect terminals (main + any siblings)';
    architectsRoot.contextValue = 'workspace-architects-root';
    items.push(architectsRoot);

    const webUrl = this.buildDashboardUrl();
    if (webUrl) {
      const web = new vscode.TreeItem('Open Web Interface');
      web.iconPath = new vscode.ThemeIcon('globe');
      web.tooltip = webUrl;
      web.contextValue = 'workspace-web';
      web.command = {
        command: 'vscode.open',
        title: 'Open Tower dashboard in browser',
        arguments: [vscode.Uri.parse(webUrl)],
      };
      items.push(web);
    }

    const spawn = new vscode.TreeItem('Spawn Builder');
    spawn.iconPath = new vscode.ThemeIcon('rocket');
    spawn.tooltip = 'Spawn a new builder for a GitHub issue';
    spawn.contextValue = 'workspace-spawn';
    spawn.command = {
      command: 'codev.spawnBuilder',
      title: 'Spawn Builder',
    };
    items.push(spawn);

    const shell = new vscode.TreeItem('New Shell');
    shell.iconPath = new vscode.ThemeIcon('terminal-new');
    shell.tooltip = 'Open a new shell tab in Tower';
    shell.contextValue = 'workspace-shell';
    shell.command = {
      command: 'codev.newShell',
      title: 'New Shell',
    };
    items.push(shell);

    // Target is whatever folder this VSCode window is rooted at: the main
    // checkout → `main`, a `.builders/<id>/` worktree → that builder. The
    // label stays generic; the tooltip names the resolved target.
    const workspacePath = this.connectionManager.getWorkspacePath();
    const devTarget = workspacePath ? resolveWorkspaceDevTarget(workspacePath) : null;

    // Resolved worktree config (Tower-merged across all 5 layers). One
    // fetch drives both the dev-server row's visibility (gated on
    // devCommand presence) and the Open Dev URL row(s) below.
    const worktreeConfig = await loadWorktreeConfig(this.connectionManager);
    const devCommand = worktreeConfig?.devCommand ?? null;
    const devUrls = worktreeConfig?.devUrls ?? [];

    // Mutually exclusive: show Start when no dev is running anywhere, Stop
    // when one is — regardless of which target started it. The single-slot
    // model in dev-shared.ts means listDevTerminals() has at most one entry;
    // reflect the slot's occupancy here so a dev started from a builder's
    // right-click context menu is visible/stoppable from the Workspace view
    // too. The visible control is itself the state indicator (play/stop
    // model) — never both, no row-count jitter.
    //
    // Visibility also depends on whether a *runnable* devCommand is
    // configured (non-empty, non-whitespace — see hasRunnableDevCommand):
    //   - dev running → always show Stop (lets the user kill a dev they
    //     started before clearing devCommand)
    //   - no dev running + runnable devCommand → show Start
    //   - no dev running + no runnable devCommand → show nothing
    // The third case removes the "click Start, get a toast saying
    // devCommand isn't configured" footgun. Gating on hasRunnableDevCommand
    // (not `devCommand !== null`) also treats `"devCommand": ""` as absent,
    // matching dev-shared.ts's runnability check.
    const allDevs = this.terminalManager.listDevTerminals();
    const targetDev = devTarget ? allDevs.find(d => d.builderId === devTarget.id) : undefined;
    const otherDev = !targetDev ? allDevs[0] : undefined; // single-slot ⇒ at most one

    if (targetDev) {
      // This workspace's own dev is the running one. Today's Stop row.
      const stopDev = new vscode.TreeItem('Stop Dev Server');
      stopDev.iconPath = new vscode.ThemeIcon('debug-stop');
      stopDev.tooltip = `Stop the dev server for this workspace (target: ${devTarget!.id})`;
      stopDev.contextValue = 'workspace-dev-stop';
      stopDev.command = {
        command: 'codev.stopWorkspaceDev',
        title: 'Stop Dev Server',
      };
      items.push(stopDev);
    } else if (otherDev) {
      // A dev is running, but for a different target — surface it so the
      // user can see/stop it without leaving the Workspace view. Goes
      // through codev.stopWorktreeDev which targets the dev slot directly
      // (kills every dev in the local registry; single-slot invariant
      // means that's exactly the one running).
      const stopDev = new vscode.TreeItem('Stop Dev Server');
      stopDev.iconPath = new vscode.ThemeIcon('debug-stop');
      stopDev.tooltip = `Stop the dev server (currently running for ${otherDev.builderId})`;
      stopDev.contextValue = 'workspace-dev-stop-other';
      stopDev.command = {
        command: 'codev.stopWorktreeDev',
        title: 'Stop Dev Server',
      };
      items.push(stopDev);
    } else if (hasRunnableDevCommand(worktreeConfig)) {
      // No dev anywhere AND a runnable devCommand is configured — Start row.
      const startDev = new vscode.TreeItem('Start Dev Server');
      startDev.iconPath = new vscode.ThemeIcon('play');
      startDev.tooltip = devTarget
        ? `Run worktree.devCommand (\`${devCommand}\`) for this workspace (target: ${devTarget.id})`
        : `Run worktree.devCommand (\`${devCommand}\`) for this workspace`;
      startDev.contextValue = 'workspace-dev-start';
      startDev.command = {
        command: 'codev.runWorkspaceDev',
        title: 'Start Dev Server',
      };
      items.push(startDev);
    }
    // else: no dev running and no runnable devCommand → no dev-server row at all.

    // Open Dev URL rows: one per entry in `worktree.devUrls`. Visible
    // independent of dev-PTY
    // state. Opens in the user's default browser (real DevTools, real
    // cookies, real OAuth) — not the embedded Simple Browser webview.
    // Closed the tab? Click the row again for a fresh one.
    for (const { label, url } of devUrls) {
      const row = new vscode.TreeItem(label);
      // 'link-external' (square + outgoing arrow) — VSCode's conventional
      // "opens outside the editor" glyph; matches what
      // vscode.env.openExternal actually does, and distinguishes this row
      // from "Open Web Interface" above (which keeps the more abstract
      // 'globe' for the Tower dashboard).
      row.iconPath = new vscode.ThemeIcon('link-external');
      row.tooltip = `Open ${url} in your default browser`;
      row.contextValue = 'workspace-dev-url';
      row.command = {
        command: 'codev.openDevUrl',
        title: label,
        arguments: [url],
      };
      items.push(row);
    }

    return items;
  }

  private buildDashboardUrl(): string | null {
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!workspacePath) { return null; }
    const { host, port } = getTowerAddress();
    return `http://${host}:${port}/workspace/${encodeWorkspacePath(workspacePath)}/`;
  }

  /**
   * Spec 786 Phase 6: fetch architects from Tower and emit one TreeItem per
   * architect.
   *
   * `main` always appears first (per Spec 786 Phase 5's main-first ordering
   * in `getTerminalsForWorkspace`). Sibling entries get
   * `contextValue: 'workspace-architect-sibling'` which gates the right-click
   * "Remove Architect" menu item (per Spec 786 Phase 6 — `package.json`'s
   * `menus['view/item/context']` checks this).
   *
   * If Tower isn't reachable or the workspace has no architects, returns a
   * single "main" entry as a fallback so users see the same baseline UX as
   * pre-786. The fallback is intentional: it never produces a sibling
   * (removing main is forbidden), so right-click remove can't fire on it.
   */
  private async getArchitectChildren(): Promise<vscode.TreeItem[]> {
    const workspacePath = this.connectionManager.getWorkspacePath();
    const client = this.connectionManager.getClient();

    let names: string[] = ['main'];
    if (client && workspacePath) {
      try {
        const status = await client.getWorkspaceStatus(workspacePath);
        if (status && Array.isArray(status.terminals)) {
          const archTerminals = status.terminals.filter(t => t.type === 'architect');
          if (archTerminals.length > 0) {
            names = archTerminals.map(t => t.architectName ?? t.label ?? 'main');
          }
        }
      } catch {
        // Tower unreachable / API error — fall back to default 'main' entry.
      }
    }

    return names.map(name => {
      // Label is UPPERCASE (Issue 841 Gap 3); the raw lowercase `name` is the
      // canonical identifier. `item.id` carries it so `codev.removeArchitect`
      // can resolve the real name independent of the (uppercased) display
      // label — reading `arg.label` would otherwise send a DELETE for a name
      // Tower doesn't know (e.g. 'WEB' vs 'web').
      const item = new vscode.TreeItem(displayArchitectName(name));
      item.id = `workspace-architect-${name}`;
      item.iconPath = new vscode.ThemeIcon('person');
      item.tooltip = `Open the ${name} architect terminal`;
      // Spec 786 Phase 6: contextValue gates the right-click context menu.
      // `main` is workspace-defining and undeletable; siblings get the
      // "Remove Architect" action via the package.json menus contribution.
      item.contextValue = name === 'main' ? 'workspace-architect-main' : 'workspace-architect-sibling';
      item.command = {
        command: 'codev.openArchitectTerminal',
        title: `Open ${name} terminal`,
        arguments: [name],
      };
      return item;
    });
  }
}
