import * as vscode from 'vscode';
import type { CanvasCommandEvent } from '@cluesmith/codev-types';
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
    if (disposed || viewId) return;
    const client = connectionManager.getClient();
    const workspace = connectionManager.getWorkspacePath();
    if (!client || !workspace) return; // not connected yet; the heartbeat retries
    const result = await client.registerCanvasView(workspace, file);
    if (disposed) {
      // The panel closed while the request was in flight. Registering now would leak a view that
      // nothing will ever heartbeat, so hand the id straight back.
      if (result.ok && result.viewId) void client.unregisterCanvasView(result.viewId);
      return;
    }
    if (result.ok && result.viewId) {
      viewId = result.viewId;
      log(`canvas view registered: ${result.viewId}`);
    }
  };

  /** Serialize registration attempts so a heartbeat racing a reconnect cannot register twice. */
  const ensureRegistered = async (): Promise<void> => {
    if (registering) return registering;
    registering = register().finally(() => {
      registering = null;
    });
    return registering;
  };

  const beat = async (focused: boolean): Promise<void> => {
    if (disposed) return;
    if (!viewId) {
      await ensureRegistered();
      return;
    }
    const client = connectionManager.getClient();
    if (!client) return;
    const result = await client.heartbeatCanvasView(viewId, focused);
    if (result.unknownView) {
      // Tower has forgotten this id — it restarted, or the lease lapsed while the machine slept.
      // Re-register rather than heartbeating into the void, which is what would otherwise leave
      // an open panel permanently undrivable.
      log(`canvas view ${viewId} unknown to Tower; re-registering`);
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
    if (e.webviewPanel.active) void beat(true);
  });

  const sseSub = connectionManager.onSSEEvent(({ data }) => {
    const envelope = parseSseEnvelope(data);
    if (!envelope || envelope.type !== CANVAS_COMMAND_EVENT) return;
    const event = parseSseBody<CanvasCommandEvent>(envelope.body);
    // Tower broadcasts to every subscriber, so each panel keeps only what is addressed to it.
    // This comparison is the whole addressing mechanism; without it every open canvas would run
    // every command.
    if (!event || typeof event.viewId !== 'string' || event.viewId !== viewId) return;
    if (typeof event.command !== 'string') return;

    const message: HostToWebviewMessage = { type: 'command', command: event.command };
    if (typeof event.count === 'number') message.count = event.count;
    // Deliberately no `panel.reveal()`: a remote command drives the canvas, it does not steal the
    // reviewer's window, matching the existing command relay's "never pulls focus" posture.
    void panel.webview.postMessage(message);
  });

  return new vscode.Disposable(() => {
    disposed = true;
    clearInterval(timer);
    viewStateSub.dispose();
    sseSub.dispose();
    const client = connectionManager.getClient();
    if (viewId && client) {
      void client.unregisterCanvasView(viewId);
      log(`canvas view unregistered: ${viewId}`);
    }
    viewId = null;
  });
}
