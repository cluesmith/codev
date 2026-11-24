/**
 * The Work panel (Spec 1963): the shared Work view in an editor-area webview, for this window's
 * workspace. One panel per window, restored after a reload (`single-panel.ts`).
 *
 * The webview never contacts Tower:
 * - **Its data is pushed** from the host's `OverviewCache`, the same source the sidebar uses, on
 *   every overview or connection change. The panel adds no poll of its own; while it is visible it
 *   counts toward the periodic overview refresh (`OverviewRefreshGate`), as the sidebar views do.
 * - **Last-known-good.** While Tower is not connected the panel keeps the last overview under a
 *   not-connected notice. Before the first overview it shows its loading state.
 * - **Every kept dashboard action is mapped** to its VS Code equivalent:
 *   - *Open* (a builder row) opens the builder's terminal, as clicking its Agents row does;
 *   - *+ Shell* runs *New Shell* (a Tower shell opened by the terminal manager);
 *   - *Refresh* asks Tower to drop its overview cache (`POST /api/overview/refresh`, the call the
 *     dashboard's *Refresh* makes, which is machine-wide), then re-reads this window's overview;
 *   - a *spec* / *plan* / *review* link opens that file in an editor, only when its canonical
 *     (symlink-resolved) location is inside the workspace;
 *   - an issue or PR link opens in the user's browser, http(s) only.
 *
 *   The dropped ones (Open Files & Shells, the file panel, the tip of the day) are not rendered:
 *   the webview passes the view no slots.
 */

import * as vscode from 'vscode';
import type { OverviewData } from '@cluesmith/codev-types';
import type { TowerClient } from '@cluesmith/codev-sdk/tower-client';
import type { OverviewState } from '@cluesmith/codev-workspace-views/host';
import type { ConnectionState } from '../connection-manager.js';
import { PanelSession, SingleWebviewPanel, type SinglePanelOptions } from './single-panel.js';
import { resolveWorkspaceFile } from './security.js';
import { NOT_CONNECTED_MESSAGE } from './decisions-bridge.js';
import {
  WORK_VIEW_TYPE,
  isOpenExternalMessage,
  isReadyMessage,
  isWorkNewShellMessage,
  isWorkOpenArtifactMessage,
  isWorkOpenBuilderMessage,
  isWorkRefreshMessage,
  type WorkHostMessage,
} from './messages.js';

/** This window's overview (`OverviewCache`). */
export interface WorkOverviewSource {
  getData(): OverviewData | null;
  readonly onDidChange: vscode.Event<void>;
  refresh(): Promise<void>;
}

/** This window's Tower connection (`ConnectionManager`). */
export interface WorkConnection {
  getState(): ConnectionState;
  readonly onStateChange: vscode.Event<ConnectionState>;
  getClient(): Pick<TowerClient, 'refreshOverview'> | null;
}

/** The VS Code actions the panel's controls map to. */
export interface WorkActions {
  /** Open a builder's terminal (`TerminalManager.openBuilderByRoleOrId`). */
  openBuilder(builderId: string): Promise<unknown>;
  /** *New Shell* (`codev.newShell`). */
  newShell(): Promise<unknown>;
  /** Open a file, already checked to be inside the workspace, in an editor. */
  openFile(fsPath: string): Promise<unknown>;
  /** Tell the user why a link they clicked did not open. */
  warn(message: string): void;
}

export interface WorkPanelsOptions extends SinglePanelOptions {
  overview: WorkOverviewSource;
  connection: WorkConnection;
  actions: WorkActions;
  /** The workspace whose files an artifact link may open. */
  workspacePath: () => string | null;
}

const PANEL_TITLE = 'Work';

/**
 * What the Work view shows for this window's overview and connection:
 * - null (its loading state) until the first overview, unless Tower is known to be unreachable;
 * - otherwise the last overview read, under the not-connected notice while Tower is not connected.
 */
export function workOverviewState(data: OverviewData | null, state: ConnectionState): OverviewState | null {
  const notConnected = state === 'disconnected' || state === 'reconnecting';
  if (data === null) {
    return notConnected ? { data: null, error: NOT_CONNECTED_MESSAGE } : null;
  }
  return { data, error: state === 'connected' ? null : NOT_CONNECTED_MESSAGE };
}

/** The window's one Work panel, and its serializer. */
export class WorkPanels extends SingleWebviewPanel {
  constructor(private readonly options: WorkPanelsOptions) {
    super({ viewType: WORK_VIEW_TYPE, title: PANEL_TITLE, bundle: 'work' }, options);
  }

  protected attach(panel: vscode.WebviewPanel): void {
    new WorkPanelSession(panel, this.options);
  }
}

/** One panel's webview, from creation until it is closed. */
class WorkPanelSession extends PanelSession<WorkHostMessage> {
  constructor(panel: vscode.WebviewPanel, private readonly options: WorkPanelsOptions) {
    super(panel, PANEL_TITLE, options.log);
    this.track(
      options.overview.onDidChange(() => this.postOverview()),
      options.connection.onStateChange(() => this.postOverview()),
    );
  }

  private postOverview(): void {
    const { overview, connection } = this.options;
    this.post({ type: 'work/overview', overview: workOverviewState(overview.getData(), connection.getState()) });
  }

  protected async onMessage(message: unknown): Promise<void> {
    const { actions } = this.options;
    if (isReadyMessage(message)) {
      this.postOverview();
    } else if (isWorkOpenBuilderMessage(message)) {
      await this.openBuilder(message.builderId);
    } else if (isWorkNewShellMessage(message)) {
      await actions.newShell();
    } else if (isWorkRefreshMessage(message)) {
      await this.refresh();
    } else if (isWorkOpenArtifactMessage(message)) {
      await this.openArtifact(message.path);
    } else if (isOpenExternalMessage(message)) {
      this.openExternal(message.url);
    } else {
      this.log('ignored a malformed message from its webview.');
    }
  }

  /** Only a builder the panel shows: its row is the only place an id comes from. */
  private async openBuilder(builderId: string): Promise<void> {
    const builders = this.options.overview.getData()?.builders ?? [];
    if (!builders.some(builder => builder.id === builderId)) {
      this.log(`did not open builder ${builderId}: it is not in this workspace's overview.`);
      return;
    }
    await this.options.actions.openBuilder(builderId);
  }

  /** Drop Tower's overview cache, then re-read this window's overview, as the dashboard's *Refresh* does. */
  private async refresh(): Promise<void> {
    const { connection, overview } = this.options;
    const client = connection.getState() === 'connected' ? connection.getClient() : null;
    if (client) { await client.refreshOverview(); }
    await overview.refresh();
  }

  private async openArtifact(requested: string): Promise<void> {
    const { actions, workspacePath } = this.options;
    const root = workspacePath();
    if (root === null) {
      this.log(`did not open ${requested}: this window has no workspace.`);
      return;
    }
    const resolved = await resolveWorkspaceFile(root, requested);
    if (resolved.ok) {
      await actions.openFile(resolved.path);
      return;
    }
    this.log(`did not open ${requested}: ${resolved.reason}.`);
    actions.warn(resolved.reason === 'not-found'
      ? `Codev: ${requested} was not found in this workspace.`
      : `Codev: ${requested} was not opened: it is outside this workspace.`);
  }
}
