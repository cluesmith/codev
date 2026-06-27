import * as vscode from 'vscode';
import { CodevPseudoterminal } from './terminal-adapter.js';
import type { ConnectionManager } from './connection-manager.js';
import type { OverviewCache } from './views/overview-data.js';
import { encodeWorkspacePath } from '@cluesmith/codev-core/workspace';
import { resolveAgentName } from '@cluesmith/codev-core/agent-names';
import type { TerminalType } from '@cluesmith/codev-core/tower-client';
import { resolveBuilderTerminal, mainCheckoutRoot } from './terminal-resolve.js';

const MAX_TERMINALS = 10;

interface ManagedTerminal {
  terminal: vscode.Terminal;
  pty: CodevPseudoterminal;
  type: TerminalType;
  id: string;
}

/**
 * Manages VS Code terminal instances backed by Tower PTY sessions.
 * Handles WebSocket pool, editor layout, and terminal lifecycle.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private outputChannel: vscode.OutputChannel;
  private connectionManager: ConnectionManager;
  private readonly iconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly _onDidChangeDevTerminals = new vscode.EventEmitter<void>();
  /** Fires whenever the set of open dev terminals changes (start/stop/swap/cleanup). */
  readonly onDidChangeDevTerminals = this._onDidChangeDevTerminals.event;
  /**
   * When each dev terminal began running, keyed by builderId. `listDevTerminals`
   * carries only ids, so the Codev Dev surface (#921) reads start times here to
   * render uptime. Set on a fresh open (not a refocus), cleared on close.
   */
  private readonly devStartedAt = new Map<string, number>();
  private readonly overviewCache: OverviewCache;

  constructor(
    connectionManager: ConnectionManager,
    outputChannel: vscode.OutputChannel,
    extensionUri: vscode.Uri,
    overviewCache: OverviewCache,
  ) {
    this.connectionManager = connectionManager;
    this.outputChannel = outputChannel;
    this.overviewCache = overviewCache;
    // Theme-aware icon pair. The single-Uri form rendered as solid black on
    // dark themes (VSCode doesn't resolve currentColor on terminal-tab icons).
    // codev-light.svg has dark fill (visible on light themes), codev-dark.svg
    // has light fill (visible on dark themes).
    this.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'icons', 'codev-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'icons', 'codev-dark.svg'),
    };
  }

  /**
   * Friendly builder tab title — mirrors the sidebar's `#<issueId> <issueTitle>`,
   * prefixed `Codev: `. Falls back to `fallback` (the canonical
   * `Codev: <agent-name>`) whenever overview data, a builder match, or an
   * issue number is unavailable, so the title is never broken or empty.
   *
   * Display-only: terminal identity, cleanup, and click-to-focus all key off
   * the `builder-<id>` map key and Terminal object — never the tab title — so
   * changing this string has no functional side effects.
   */
  private friendlyBuilderLabel(builderId: string, fallback: string): string {
    const data = this.overviewCache.getData();
    if (!data?.builders?.length) { return fallback; }
    // Open paths pass the canonical roleId (`builder-<protocol>-<id>`), but
    // OverviewCache builders carry the short id the sidebar uses. resolveAgentName
    // matches a *short* target against canonical candidates, so feed it the
    // trailing id token, not the full roleId (otherwise it never matches and
    // every builder falls back to the agent name).
    const shortId = builderId.split('-').pop() ?? builderId;
    const { builder } = resolveAgentName(shortId, data.builders);
    // Mirror the sidebar exactly: `#${issueId ?? id} ${issueTitle ?? ''}`.
    const num = builder?.issueId ?? builder?.id;
    if (num === undefined || num === null || num === '') { return fallback; }
    // Bound the tab name: `#<id>` stays whole (short, identifying), but the
    // issue title is capped — VSCode's default `tabSizing: 'fit'` does not
    // ellipsize a lone wide tab, so an unbounded title spans the whole group.
    const MAX_TITLE = 25;
    const raw = (builder?.issueTitle ?? '').trim();
    let title = raw;
    if (raw.length > MAX_TITLE) {
      const slice = raw.slice(0, MAX_TITLE);
      const lastSpace = slice.lastIndexOf(' ');
      // Cut at the last whole word; fall back to a hard cut when the first
      // word alone already exceeds the cap (no usable space boundary).
      const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice.slice(0, MAX_TITLE - 1);
      title = `${cut.trimEnd()}…`;
    }
    return `Codev: #${num}${title ? ` ${title}` : ''}`;
  }

  /**
   * Open the architect terminal. `focus` defaults to false so background
   * paths don't steal focus; click paths pass true.
   *
   * Spec 786 Phase 6: keyed by architect name (`'main'` or a sibling) so
   * each architect gets its own VSCode terminal slot. The previous singleton
   * `'architect'` key meant clicking different architects in the sidebar
   * routed to the same terminal — now each gets its own. Opening the same
   * architect twice reuses its existing slot.
   *
   * Spec 786 PR iter-1 review fix: if the existing terminal points at a
   * stale Tower session id (different from the current `terminalId`), dispose
   * it before opening a new one. This matches `openBuilder()`'s pattern and
   * handles the `afx workspace stop`+start / Tower restart / remove+re-add
   * scenarios where Tower issues a fresh session id for the same architect
   * name. Without this check, the VSCode sidebar click would refocus a dead
   * terminal instead of attaching to the live one.
   */
  async openArchitect(terminalId: string, architectName: string = 'main', focus = false): Promise<void> {
    const key = `architect:${architectName}`;
    const existing = this.terminals.get(key);
    if (existing) {
      if (existing.id === terminalId) {
        existing.terminal.show(!focus);
        return;
      }
      // Stale session id — dispose the dead terminal and open a fresh one.
      existing.pty.close();
      existing.terminal.dispose();
      this.terminals.delete(key);
    }
    const label = architectName === 'main' ? 'Codev: Architect' : `Codev: Architect (${architectName})`;
    await this.openTerminal(terminalId, 'architect', label, key, focus);
  }

  /**
   * Type `text` into an architect terminal's input *without* a trailing
   * newline (no submit). Returns false if the named architect terminal isn't
   * registered in this window — callers should ensure it's open first (via
   * `codev.openArchitectTerminal`) before injecting.
   *
   * Spec 786 Phase 6: defaults `architectName` to `'main'` so existing
   * callers (notably `codev.referenceIssueInArchitect` — the Backlog inline
   * button) keep targeting main without modification. This is the
   * conservative call documented in the Phase 6 plan deliverable: the
   * Backlog button always targets `main` regardless of how many sibling
   * architects exist.
   */
  injectArchitectText(text: string, architectName: string = 'main'): boolean {
    const key = `architect:${architectName}`;
    const entry = this.terminals.get(key);
    if (!entry) { return false; }
    entry.terminal.show();
    entry.terminal.sendText(text, false);
    return true;
  }

  /**
   * Type `text` into a builder terminal's input *without* a trailing newline
   * (no submit) — the builder-side analogue of `injectArchitectText`, backing
   * the "Forward to Builder" CodeLens (#789). Returns false if no terminal is
   * registered for `builderId`; callers ensure it's open first (via
   * `openBuilderByRoleOrId`, whose resolved id keys the lookup).
   */
  injectBuilderText(builderId: string, text: string): boolean {
    const key = `builder-${builderId}`;
    const entry = this.terminals.get(key);
    if (!entry) { return false; }
    entry.terminal.show();
    entry.terminal.sendText(text, false);
    return true;
  }

  /**
   * Open a builder terminal. If a terminal already exists for this builder
   * but points at a different (stale) Tower session, dispose it before
   * opening a new one — happens when a builder is re-spawned and Tower
   * issues a new terminalId for the same roleId.
   *
   * `focus` defaults to false so background paths (e.g. auto-spawn when
   * the architect spawns a new builder) don't steal focus mid-typing.
   * Explicit user actions — sidebar click, terminal-link click, toast
   * click, command-palette pick — pass `true` to activate the terminal
   * for keyboard input.
   */
  async openBuilder(terminalId: string, builderId: string, label: string, focus = false): Promise<void> {
    const key = `builder-${builderId}`;
    const existing = this.terminals.get(key);
    if (existing) {
      if (existing.id === terminalId) {
        existing.terminal.show(!focus);
        return;
      }
      existing.pty.close();
      existing.terminal.dispose();
      this.terminals.delete(key);
    }
    await this.openTerminal(terminalId, 'builder', this.friendlyBuilderLabel(builderId, label), key, focus);
  }

  /**
   * Resolve a builder by `roleId` or `id` via Tower workspace state, then
   * open its terminal. Used by the sidebar tree views, terminal link
   * provider, and command palette so the lookup logic lives in one place.
   *
   * The resolve is retried with a short backoff (`resolveBuilderTerminal`):
   * Tower's `/api/state` can momentarily omit a live builder while its session
   * registry rehydrates/reconnects, and that transient miss self-heals on the
   * next call (PIR #982). Only a persistent miss surfaces the recovery toast.
   *
   * Returns the resolved **canonical** builder id on success (the key under
   * which the terminal is registered), or `undefined` when the builder can't
   * be opened. The "Forward to Builder" inject path (#789) uses this to target
   * the same terminal that was opened, even when called with a bare numeric id;
   * other callers ignore the return value.
   */
  async openBuilderByRoleOrId(roleOrId: string, focus = false): Promise<string | undefined> {
    const client = this.connectionManager.getClient();
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!client || !workspacePath) {
      vscode.window.showErrorMessage('Codev: Not connected to Tower');
      return undefined;
    }
    try {
      // resolveBuilderTerminal uses resolveAgentName internally so the bare
      // numeric IDs the sidebar passes (e.g. '153' from OverviewBuilder)
      // tail-match canonical 'builder-spir-153' IDs from Tower's runtime state.
      const outcome = await resolveBuilderTerminal(
        roleOrId,
        async () => {
          const state = await client.getWorkspaceState(workspacePath);
          return state?.builders ?? [];
        },
        { sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)) },
      );
      if (outcome.kind === 'ambiguous') {
        vscode.window.showWarningMessage(
          `Codev: Multiple builders match "${roleOrId}": ${outcome.matches.map(b => b.name).join(', ')}`,
        );
        return undefined;
      }
      if (outcome.kind === 'missing') {
        await this.promptNoTerminalRecovery(roleOrId, workspacePath, focus);
        return undefined;
      }
      const { builder, terminalId } = outcome;
      await this.openBuilder(terminalId, builder.id, `Codev: ${builder.name}`, focus);
      return builder.id;
    } catch (err) {
      this.log('ERROR', `Failed to open builder ${roleOrId}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(`Codev: Failed to open ${roleOrId}`);
      return undefined;
    }
  }

  /**
   * Actionable toast for when a builder row is clicked but no live terminal
   * resolves after the bounded retry (PIR #982). Replaces the old dead-end
   * `No active terminal` warning. Leads with **Retry** — the common case is a
   * session still settling (a longer startup-reconciliation window than the
   * auto-retry budget covers) — and offers **Recover Builders** as the
   * last-resort path for a genuinely lost session (e.g. a dead shellper).
   *
   * Recover opens a terminal running `afx workspace recover` (its default
   * dry-run preview) at the main checkout root, mirroring `run-worktree-setup`.
   * It deliberately stops at the preview rather than `--apply`: recover is
   * workspace-wide (it can't target one builder), so the user reviews the scope
   * before reviving. The cwd is resolved via `mainCheckoutRoot` so the command
   * runs from the main checkout even when VSCode is rooted at a builder worktree
   * window (where `getWorkspacePath()` resolves to the worktree, not main).
   */
  private async promptNoTerminalRecovery(roleOrId: string, workspacePath: string, focus: boolean): Promise<void> {
    const RETRY = 'Retry';
    const RECOVER = 'Recover Builders';
    const who = this.friendlyBuilderId(roleOrId);
    const choice = await vscode.window.showWarningMessage(
      `Codev: ${who}'s terminal isn't available yet — it may still be starting, or its session was dropped. ` +
        `Retry, or recover builders if it was lost.`,
      RETRY,
      RECOVER,
    );
    if (choice === RETRY) {
      await this.openBuilderByRoleOrId(roleOrId, focus);
    } else if (choice === RECOVER) {
      const terminal = vscode.window.createTerminal({
        name: 'Codev: Recover Builders',
        cwd: mainCheckoutRoot(workspacePath),
      });
      terminal.show();
      terminal.sendText('afx workspace recover');
    }
  }

  /**
   * A short, friendly identity for a builder (`#<issueId>`) from the overview
   * cache, falling back to the raw `roleOrId` when no row matches. Used only
   * for the recovery toast's prose so it names the row the user clicked.
   */
  private friendlyBuilderId(roleOrId: string): string {
    const data = this.overviewCache.getData();
    if (!data?.builders?.length) { return roleOrId; }
    const shortId = roleOrId.split('-').pop() ?? roleOrId;
    const { builder } = resolveAgentName(shortId, data.builders);
    const num = builder?.issueId ?? builder?.id;
    return num ? `#${num}` : roleOrId;
  }

  /**
   * Open a dev-server terminal for a builder's worktree (#690).
   * Keyed `dev-<builderId>` so it lives alongside (not on top of) the
   * builder's own AI terminal at `builder-<id>`. Tab label is set by the
   * caller (server-side `'Dev: <id>'` flows through Tower's terminal name).
   *
   * `focus` defaults to true — `afx dev` / "Run Dev Server" are explicit
   * user actions, so activate the tab so they see the spawning output.
   */
  async openDevTerminal(terminalId: string, builderId: string, builderName: string, focus = true): Promise<void> {
    const key = `dev-${builderId}`;
    const existing = this.terminals.get(key);
    if (existing) {
      if (existing.id === terminalId) {
        existing.terminal.show(!focus);
        return;
      }
      // Stale terminal for the same builder — dispose before re-opening
      existing.pty.close();
      existing.terminal.dispose();
      this.terminals.delete(key);
    }
    // Tab title matches the builder-tab format (`Codev: <name>`) with a
    // `(dev)` suffix so the pairing is obvious in the tab strip.
    await this.openTerminal(terminalId, 'dev', `Codev: ${builderName} (dev)`, key, focus);
    // Fresh open (the refocus path returned above), so stamp the start time for
    // uptime. A re-spawn that replaced a stale terminal lands here too and
    // correctly resets the clock.
    this.devStartedAt.set(builderId, Date.now());
    this._onDidChangeDevTerminals.fire();
  }

  /**
   * Wall-clock ms (epoch) when the dev terminal for `builderId` started, or
   * undefined if no dev is tracked for it (e.g. a dev that predates this
   * extension activation). Read by the Codev Dev surface (#921) for uptime.
   */
  getDevStartedAt(builderId: string): number | undefined {
    return this.devStartedAt.get(builderId);
  }

  /**
   * Dispose the VSCode terminal tab for a builder's dev server, if any.
   * Used by `codev.stopWorktreeDev` after killing the Tower-side PTY so the
   * user doesn't see a dead "Process exited" tab lingering.
   */
  closeDevTerminal(builderId: string): void {
    const key = `dev-${builderId}`;
    const existing = this.terminals.get(key);
    if (!existing) { return; }
    existing.pty.close();
    existing.terminal.dispose();
    this.terminals.delete(key);
    this.devStartedAt.delete(builderId);
    this._onDidChangeDevTerminals.fire();
  }

  /**
   * Dispose the VSCode terminal tabs for a builder — both the AI terminal
   * and any companion dev-server terminal — after the builder has been
   * cleaned up. Tower kills the PTYs as part of cleanup, so without this
   * the user sees a stale "Process exited" tab until they close it
   * manually. Accepts the canonical builder roleId (e.g. `builder-spir-109`),
   * matching the value passed to `openBuilder`.
   */
  closeBuilderTerminal(builderId: string): void {
    let devClosed = false;
    for (const key of [`builder-${builderId}`, `dev-${builderId}`]) {
      const existing = this.terminals.get(key);
      if (!existing) { continue; }
      existing.pty.close();
      existing.terminal.dispose();
      this.terminals.delete(key);
      if (key.startsWith('dev-')) { devClosed = true; }
    }
    if (devClosed) {
      this.devStartedAt.delete(builderId);
      this._onDidChangeDevTerminals.fire();
    }
  }

  /**
   * Return { builderId, terminalId } for every dev terminal this VSCode
   * instance has open. Used by `codev.stopWorktreeDev` as the source of
   * truth — more reliable than round-tripping through Tower's label filter
   * (whose preservation through create→list isn't worth depending on, and
   * cross-VSCode-instance discovery is a #690 non-goal anyway).
   */
  listDevTerminals(): Array<{ builderId: string; terminalId: string }> {
    const out: Array<{ builderId: string; terminalId: string }> = [];
    for (const [key, entry] of this.terminals.entries()) {
      if (key.startsWith('dev-')) {
        out.push({ builderId: key.slice('dev-'.length), terminalId: entry.id });
      }
    }
    return out;
  }

  /**
   * Open a shell terminal.
   */
  async openShell(terminalId: string, shellNumber: number): Promise<void> {
    const key = `shell-${shellNumber}`;
    if (this.terminals.has(key)) {
      this.terminals.get(key)!.terminal.show();
      return;
    }
    await this.openTerminal(terminalId, 'shell', `Codev: Shell #${shellNumber}`, key);
  }

  getTerminalCount(): number {
    return this.terminals.size;
  }

  /**
   * Resolve the currently-focused VSCode terminal to its Codev PTY, or null
   * if the active terminal is not a Codev-managed one. Linear scan over the
   * (≤ MAX_TERMINALS) map — no reverse index to keep in sync. Used by the
   * image-paste command (#736) and the `codev.terminalFocused` context key.
   */
  getActiveManagedPty(): CodevPseudoterminal | null {
    const active = vscode.window.activeTerminal;
    if (!active) { return null; }
    for (const entry of this.terminals.values()) {
      if (entry.terminal === active) { return entry.pty; }
    }
    return null;
  }

  isCodevTerminalActive(): boolean {
    return this.getActiveManagedPty() !== null;
  }

  /**
   * The builder id of the currently-focused VSCode terminal, or null when the
   * active terminal isn't a Codev *builder* terminal. Recovered from the map key
   * (`builder-<builderId>`), the same id the open path was given. Used to publish a
   * `builder-active` activity event when a builder terminal is focused.
   */
  getActiveBuilderId(): string | null {
    const active = vscode.window.activeTerminal;
    if (!active) { return null; }
    const prefix = 'builder-';
    for (const [mapKey, entry] of this.terminals) {
      if (entry.terminal === active && entry.type === 'builder' && mapKey.startsWith(prefix)) {
        return mapKey.slice(prefix.length);
      }
    }
    return null;
  }

  // ── Internal ─────────────────────────────────────────────────

  private async openTerminal(
    terminalId: string,
    type: TerminalType,
    name: string,
    key?: string,
    focus = false,
  ): Promise<void> {
    if (this.terminals.size >= MAX_TERMINALS) {
      vscode.window.showWarningMessage(`Too many terminals (${MAX_TERMINALS} max) — close unused terminals`);
      return;
    }

    const wsUrl = this.buildWsUrl(terminalId);
    if (!wsUrl) {
      vscode.window.showErrorMessage('Cannot open terminal — no workspace detected');
      return;
    }

    const authKey = await this.getAuthKey();
    const pty = new CodevPseudoterminal(wsUrl, authKey, this.outputChannel);
    const position = vscode.workspace.getConfiguration('codev').get<string>('terminalPosition', 'editor');

    // Dev servers are long-running background logs — always the bottom panel,
    // regardless of the `codev.terminalPosition` setting (which governs the
    // architect/builder/shell terminals: architect → editor group 1, the
    // rest → group 2).
    let location: vscode.TerminalLocation | vscode.TerminalEditorLocationOptions;
    if (type === 'dev' || position !== 'editor') {
      location = vscode.TerminalLocation.Panel;
    } else if (type === 'architect') {
      location = { viewColumn: vscode.ViewColumn.One };
    } else {
      // Builder/shell terminals prefer the second editor group so they live
      // beside the architect's pane. But `ViewColumn.Two` is fixed by ordinal:
      // targeting it when only one group is open forces VS Code to spawn a new
      // group, reshaping the user's layout (#804). Attach to the second group
      // only when it already exists; otherwise fall back to the first/default
      // group so single-column users stay undisturbed.
      const hasSecondGroup = vscode.window.tabGroups.all.length >= 2;
      if (hasSecondGroup) {
        location = { viewColumn: vscode.ViewColumn.Two };
      } else {
        location = { viewColumn: vscode.ViewColumn.One };
      }
    }

    const terminal = vscode.window.createTerminal({ name, pty, location, iconPath: this.iconPath });

    const mapKey = key ?? type;
    this.terminals.set(mapKey, { terminal, pty, type, id: terminalId });

    // Clean up when terminal is closed by user. The map-delete is guarded
    // because a stale terminal disposed via openBuilder's re-spawn path can
    // emit onDidCloseTerminal *after* the replacement registers under the
    // same mapKey — without the identity check we'd unmap the live one.
    const disposable = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) { return; }
      pty.close();
      const wasTracked = this.terminals.get(mapKey)?.terminal === terminal;
      if (wasTracked) {
        this.terminals.delete(mapKey);
      }
      // A dev terminal closed via this generic path (tab ✕, or the dev process
      // exiting) must refresh the dev surfaces (#921) too — the explicit
      // closeDevTerminal/closeBuilderTerminal paths fire the event, but a manual
      // close reaches only here, which previously just unmapped and left the
      // chip / tab / `codev.devServerRunning` stranded as "running". Guarded by
      // `wasTracked` so the explicit-close path (which deletes first, then
      // dispose()s the terminal) doesn't double-fire.
      if (wasTracked && mapKey.startsWith('dev-')) {
        this.devStartedAt.delete(mapKey.slice('dev-'.length));
        this._onDidChangeDevTerminals.fire();
      }
      disposable.dispose();
    });

    terminal.show(!focus);
  }

  /**
   * Reconnect the adapter backing a specific VSCode terminal. Used by the
   * give-up recovery affordance (#939): the terminal-link click resolves to
   * the clicked terminal, and we map it back to its adapter by identity (works
   * for every terminal kind — builder, architect, dev, shell — without parsing
   * a role out of the message text).
   */
  reconnectByTerminal(terminal: vscode.Terminal): void {
    for (const managed of this.terminals.values()) {
      if (managed.terminal === terminal) {
        managed.pty.reconnect();
        return;
      }
    }
  }

  /**
   * Force every managed terminal to repaint via a SIGWINCH nudge — the
   * opt-in window-refocus escape hatch (#1052), gated off by default behind
   * `codev.terminal.repaintOnRefocus` (see extension.ts). The initial-render fix
   * (replay buffer-and-flush) covers the confirmed corruption; this path is only
   * for setups that still report stale content after refocus. It nudges *all*
   * managed terminals (≤ MAX_TERMINALS) rather than just the active one — a
   * coarse choice, acceptable because it's off by default and `forceRepaint`
   * no-ops on a disconnected/replaying adapter. If it ever ships on by default,
   * narrow this to the visible/active terminal(s) first.
   */
  repaintAllOnRefocus(): void {
    for (const entry of this.terminals.values()) {
      entry.pty.forceRepaint();
    }
  }

  private buildWsUrl(terminalId: string): string | null {
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!workspacePath) { return null; }

    const config = vscode.workspace.getConfiguration('codev');
    const host = config.get<string>('towerHost', 'localhost');
    const port = config.get<number>('towerPort', 4100);
    const encoded = encodeWorkspacePath(workspacePath);

    return `ws://${host}:${port}/workspace/${encoded}/ws/terminal/${terminalId}`;
  }

  private async getAuthKey(): Promise<string | null> {
    const client = this.connectionManager.getClient();
    if (!client) { return null; }
    // TowerClient's getAuthKey is synchronous
    return (client as any).getAuthKey?.() ?? null;
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [TerminalManager] [${level}] ${message}`);
  }

  dispose(): void {
    for (const [, managed] of this.terminals) {
      managed.pty.close();
      managed.terminal.dispose();
    }
    this.terminals.clear();
    this._onDidChangeDevTerminals.dispose();
  }
}
