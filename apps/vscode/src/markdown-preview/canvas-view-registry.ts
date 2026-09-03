import * as vscode from 'vscode';
import type { CanvasCommand, CanvasCommandEvent } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';
import { parseSseEnvelope, parseSseBody } from '../sse-envelope.js';
import type { HostToWebviewMessage } from './messages.js';

/**
 * Registers one canvas panel as a live view with Tower, and forwards the commands addressed to
 * it into the webview (spec 1401).
 *
 * The extension is the HOST half of the channel: Tower keeps the registry and decides which view
 * a command belongs to, the canvas package executes it, and this module is the wire between
 * them. It owns three jobs and nothing else — lease upkeep, activity reporting, and delivery.
 *
 * Registration is per PANEL rather than per document, because a view is a surface a reviewer is
 * looking at: two panels showing one file are two registrations with two ids, which is exactly
 * the ambiguity Tower's most-recently-active rule exists to resolve.
 */

/** Matches Tower's `CANVAS_VIEW_HEARTBEAT_MS`; the lease there is three times this. */
const HEARTBEAT_MS = 30_000;

/** The SSE event type Tower addresses a canvas command with. */
const CANVAS_COMMAND_EVENT = 'canvas-command';

/**
 * The closed command vocabulary, as runtime data.
 *
 * Tower validates before relaying, so this is defence in depth rather than the primary check —
 * but an SSE frame is untrusted input crossing a process boundary, and forwarding an unchecked
 * string into the webview would push the problem into code with no validation of its own. The
 * assertion below fails to compile if the contract grows a command this list forgets.
 */
const CANVAS_COMMANDS = [
  'block-next',
  'block-prev',
  'comment-next',
  'comment-prev',
  'heading-next',
  'heading-prev',
  'column-forward',
  'column-back',
  'viewport-down',
  'viewport-up',
  'doc-start',
  'doc-end',
  'composer-open',
  'composer-submit',
  'composer-cancel',
  'composer-open-or-submit',
  'reading-mode-toggle',
] as const satisfies readonly CanvasCommand[];

type AssertTrue<T extends true> = T;
type _EveryCommandIsListed = AssertTrue<
  [Exclude<CanvasCommand, (typeof CANVAS_COMMANDS)[number]>] extends [never] ? true : false
>;

function isCanvasCommand(value: unknown): value is CanvasCommand {
  return typeof value === 'string' && (CANVAS_COMMANDS as readonly string[]).includes(value);
}

export interface CanvasViewRegistrationOptions {
  connectionManager: ConnectionManager;
  panel: vscode.WebviewPanel;
  /** Absolute path of the document this panel is showing. */
  file: string;
  log?: (message: string) => void;
}

/**
 * Wire a panel to Tower for its lifetime. Returns a `Disposable`; the caller ties it to
 * `panel.onDidDispose` so a closed panel stops being a target promptly rather than waiting out
 * its lease.
 */
export function registerCanvasView(options: CanvasViewRegistrationOptions): vscode.Disposable {
  const { connectionManager, panel, file } = options;
  const log = options.log ?? ((): void => {});

  let viewId: string | null = null;
  let disposed = false;
  let registering: Promise<void> | null = null;

  const register = async (): Promise<void> => {
    if (disposed || viewId) { return; }
    const client = connectionManager.getClient();
    const workspace = connectionManager.getWorkspacePath();
    if (!client || !workspace) { return; } // not connected yet; the heartbeat retries
    const result = await client.registerCanvasView(workspace, file);
    if (disposed) {
      // The panel closed while the request was in flight. Registering now would leak a view that
      // nothing will ever heartbeat, so hand the id straight back.
      if (result.ok && result.viewId) { void client.unregisterCanvasView(result.viewId); }
      return;
    }
    if (result.ok && result.viewId) {
      viewId = result.viewId;
      log(`canvas view registered: ${result.viewId}`);
    }
  };

  /** Serialize registration attempts so a heartbeat racing a reconnect cannot register twice. */
  const ensureRegistered = async (): Promise<void> => {
    if (registering) { return registering; }
    registering = register().finally(() => {
      registering = null;
    });
    return registering;
  };

  const beat = async (focused: boolean): Promise<void> => {
    if (disposed) { return; }
    if (!viewId) {
      await ensureRegistered();
      return;
    }
    const client = connectionManager.getClient();
    if (!client) { return; }
    // Capture the id this beat is about. Two heartbeats can be in flight at once (the timer and
    // an activation), and both can come back `unknownView`. Without this comparison the second
    // one would clear a viewId the first had already replaced, orphaning a freshly registered
    // view until its lease expired.
    const beatViewId = viewId;
    const result = await client.heartbeatCanvasView(beatViewId, focused);
    if (result.unknownView && viewId === beatViewId) {
      // Tower has forgotten this id — it restarted, or the lease lapsed while the machine slept.
      // Re-register rather than heartbeating into the void, which is what would otherwise leave
      // an open panel permanently undrivable.
      log(`canvas view ${beatViewId} unknown to Tower; re-registering`);
      viewId = null;
      await ensureRegistered();
    }
  };

  void ensureRegistered();

  const timer = setInterval(() => {
    void beat(false);
  }, HEARTBEAT_MS);

  // The panel the reviewer is looking at should win Tower's most-recently-active rule, so report
  // activity when it becomes visible rather than only on a timer.
  const viewStateSub = panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) { void beat(true); }
  });

  // Re-register as soon as the connection comes back, rather than waiting for the next
  // heartbeat. Without this, a Tower restart leaves every open panel undrivable for up to the
  // full heartbeat interval — and the first connection after a slow start would too, since
  // registration at open time is a no-op while there is no client yet.
  const stateSub = connectionManager.onStateChange((state) => {
    if (state !== 'connected') { return; }
    const stale = viewId;
    viewId = null;
    if (stale) {
      const client = connectionManager.getClient();
      // Release the old id before taking a new one. A reconnect is not necessarily a restart: if
      // this is the same Tower, the old registration is still live and would sit there as a
      // duplicate competing for MRU until its lease lapsed. Best-effort — against a genuinely
      // restarted Tower the id is unknown and this 404s harmlessly.
      if (client) { void client.unregisterCanvasView(stale); }
    }
    void ensureRegistered();
  });

  const sseSub = connectionManager.onSSEEvent(({ data }) => {
    const envelope = parseSseEnvelope(data);
    if (!envelope || envelope.type !== CANVAS_COMMAND_EVENT) { return; }
    const event = parseSseBody<CanvasCommandEvent>(envelope.body);
    // Tower broadcasts to every subscriber, so each panel keeps only what is addressed to it.
    // This comparison is the whole addressing mechanism; without it every open canvas would run
    // every command.
    if (!event || typeof event.viewId !== 'string' || event.viewId !== viewId) { return; }
    if (!isCanvasCommand(event.command)) { return; }

    // A malformed `count` invalidates the whole event rather than being quietly dropped. Tower
    // rejects bad counts before relaying, so one arriving here means the frame cannot be trusted
    // — and running the command with a different repeat than the sender intended is a silent
    // change to what the reviewer asked for, which is worse than doing nothing.
    if (event.count !== undefined) {
      if (typeof event.count !== 'number' || !Number.isInteger(event.count) || event.count < 1) {
        return;
      }
    }

    const message: HostToWebviewMessage = { type: 'command', command: event.command };
    if (event.count !== undefined) { message.count = event.count; }
    // Deliberately no `panel.reveal()`: a remote command drives the canvas, it does not steal the
    // reviewer's window, matching the existing command relay's "never pulls focus" posture.
    void panel.webview.postMessage(message);
  });

  return new vscode.Disposable(() => {
    disposed = true;
    clearInterval(timer);
    viewStateSub.dispose();
    stateSub.dispose();
    sseSub.dispose();
    const client = connectionManager.getClient();
    if (viewId && client) {
      void client.unregisterCanvasView(viewId);
      log(`canvas view unregistered: ${viewId}`);
    }
    viewId = null;
  });
}
