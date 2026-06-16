import * as vscode from 'vscode';
import WebSocket from 'ws';
import { FRAME_CONTROL, FRAME_DATA, type ControlMessage } from '@cluesmith/codev-types';
import { EscapeBuffer } from '@cluesmith/codev-core/escape-buffer';
import { BackoffController, classifyUpgradeError } from '@cluesmith/codev-core/reconnect-policy';

const CHUNK_SIZE = 16384; // 16KB — chunk onDidWrite to avoid CPU spikes
const MAX_QUEUE = 1048576; // 1MB — drop live output if the unrendered queue exceeds this
const DROP_WARN_INTERVAL_MS = 5000; // throttle backpressure-drop warnings (#1047)
const REPAINT_NUDGE_DELAY_MS = 500; // settle delay before forcing a redraw-SIGWINCH (#1047), matching the web client's 500ms

// Reconnect backoff. The exponential curve (1000 * 2^attempt, capped at 30s),
// the give-up threshold, and the session-unknown classifier all live in the
// shared BackoffController / classifyUpgradeError (#961). This adapter keeps the
// #936 tuning: give up after MAX_RECONNECT_ATTEMPTS retries (sequence 1s, 2s,
// 4s, 8s, 16s, 30s) and surface a terminal failure state.
const MAX_RECONNECT_ATTEMPTS = 6;

/**
 * The clickable token emitted in the give-up message. Shared with the terminal
 * link provider (#939) so the message text and the matcher cannot drift —
 * `ReconnectTerminalLinkProvider` imports this exact constant.
 */
export const RECONNECT_LINK_TEXT = 'Click here to reconnect';

/**
 * VS Code Pseudoterminal backed by a Tower WebSocket connection.
 *
 * Translates between Tower's binary protocol (0x00/0x01 framing)
 * and VS Code's string-based Pseudoterminal API.
 */
export class CodevPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private ws: WebSocket | null = null;
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private encoder = new TextEncoder();
  private escapeBuffer = new EscapeBuffer();
  private lastSeq = 0;
  private replaying = false;
  private pendingResize: { cols: number; rows: number } | null = null;
  // Latest dimensions VSCode has told us about. Seeded from open()'s
  // initialDimensions and refreshed on every setDimensions(). Re-sent after
  // every WS auth so Tower's PTY isn't stuck at node-pty's 80×24 default
  // until the user happens to manually resize the panel (Bugfix #737).
  private lastDimensions: { cols: number; rows: number } | null = null;
  private queuedBytes = 0;
  private lastDropWarnAt = 0;
  private disposed = false;

  // Repaint-nudge state (#1047). A freshly-attached terminal can stay blank:
  // the app inside (e.g. Claude's full-screen TUI) only paints after a real
  // window-size change (SIGWINCH), but the resize we send on connect can be a
  // same-size no-op or land before the app reacts. The web dashboard client
  // avoids this by unconditionally sending a "redraw" resize ~500ms after
  // connect (Terminal.tsx flushInitialBuffer); the Pseudoterminal path here had
  // no equivalent. We mirror it: after a settle delay, if nothing has rendered,
  // nudge the size (a brief 1-row change, then back) to force the SIGWINCH.
  private renderedSinceConnect = false;
  private repaintNudgeTimer: ReturnType<typeof setTimeout> | null = null;


  // Reconnect-loop state. The adapter owns reconnection end-to-end (#936) —
  // backoff scheduling, give-up after MAX_RECONNECT_ATTEMPTS, and a terminal
  // failure state that stops the loop until the user manually reconnects. The
  // backoff curve and give-up threshold live in the shared controller (#961).
  private readonly backoff = new BackoffController({ maxAttempts: MAX_RECONNECT_ATTEMPTS });
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gaveUp = false;
  // Tracks whether a wipeable in-progress retry notice currently occupies the
  // terminal's current line (#1001). Set when scheduleReconnect writes a notice;
  // cleared when a successful reconnect wipes it or the give-up state replaces
  // it. Guards against emitting cursor-control sequences on the happy-path first
  // connect, where no notice was ever written.
  private hadReconnectNotice = false;

  constructor(
    private wsUrl: string,
    private authKey: string | null,
    private outputChannel: vscode.OutputChannel,
  ) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    // Prime the renderer synchronously inside open() — VS Code drops or
    // mis-orders writes that arrive purely asynchronously after open()
    // when the terminal becomes the active editor (microsoft/vscode#108298),
    // which manifests as a blank pane when openTerminal calls show(false).
    this.writeEmitter.fire('');
    this.log('INFO', `[#1052-diag] open() initialDimensions=${initialDimensions ? `${initialDimensions.columns}x${initialDimensions.rows}` : 'undefined'}`);
    if (initialDimensions) {
      this.lastDimensions = { cols: initialDimensions.columns, rows: initialDimensions.rows };
    }
    this.connect();
  }

  close(): void {
    this.disposed = true;
    this.clearRepaintNudge();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  handleInput(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }

    const encoded = this.encoder.encode(data);
    const frame = new Uint8Array(1 + encoded.length);
    frame[0] = FRAME_DATA;
    frame.set(encoded, 1);
    this.ws.send(frame);
  }

  /**
   * Write text straight to the VSCode terminal renderer (local only — this
   * goes through writeEmitter, NOT handleInput, so it is never sent to the
   * PTY / agent). Used for transient status notices like "[Uploading
   * image...]" during image paste (#736).
   */
  writeNotice(text: string): void {
    if (this.disposed) { return; }
    this.writeEmitter.fire(text);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.log('INFO', `[#1052-diag] setDimensions ${dimensions.columns}x${dimensions.rows} replaying=${this.replaying}`);
    this.lastDimensions = { cols: dimensions.columns, rows: dimensions.rows };
    if (this.replaying) {
      // Defer resize during replay to prevent garbled rendering (Bugfix #625)
      this.log('INFO', '[#1052-diag] PATH setDimensions/during-replay → deferring resize until resume');
      this.pendingResize = { cols: dimensions.columns, rows: dimensions.rows };
      return;
    }
    this.log('INFO', '[#1052-diag] PATH setDimensions/live → sendResize now');
    this.sendResize(dimensions.columns, dimensions.rows);
  }

  // ── WebSocket ────────────────────────────────────────────────

  /**
   * Build the effective WebSocket URL, requesting a delta replay via
   * `?resume=<lastSeq>` when we've already received data (#1047). This ships
   * only the bytes produced during the disconnect window instead of the whole
   * buffer on every reconnect — the dominant win when Tower is hosted remotely
   * and reconnects are frequent. A fresh connect (lastSeq 0) gets a full
   * (bounded) replay, as does a switch to a successor session whose lastSeq
   * was reset.
   */
  private connectUrl(): string {
    if (this.lastSeq <= 0) { return this.wsUrl; }
    const sep = this.wsUrl.includes('?') ? '&' : '?';
    return `${this.wsUrl}${sep}resume=${this.lastSeq}`;
  }

  private connect(): void {
    if (this.disposed) { return; }

    const url = this.connectUrl();
    this.log('INFO', `Connecting to ${url}`);
    const socket = new WebSocket(url);
    this.ws = socket;
    this.ws.binaryType = 'arraybuffer';

    this.ws.on('open', () => {
      this.log('INFO', 'WebSocket connected');
      // A successful (re)connect clears the loop state so a later close starts
      // a fresh backoff chain from the 1s base delay rather than continuing
      // where the previous failure run left off.
      this.backoff.recordSuccess();
      this.gaveUp = false;
      // Wipe any in-progress retry notice before replayed buffer / normal
      // output resumes, so it doesn't orphan in scrollback (#1001).
      this.clearReconnectNotice();
      // Send auth via control message (not query param)
      if (this.authKey) {
        this.sendControl({ type: 'ping', payload: { auth: this.authKey } });
      }
      // Sync Tower's PTY to the dimensions VSCode reported. Without this,
      // the PTY stays at node-pty's 80×24 default until a manual resize,
      // which makes Claude Code's TUI render its input box mid-screen and
      // overlap streaming content. Pause/replay messages arrive *after*
      // this outbound resize, so the order is auth → resize → replay → resume.
      if (this.lastDimensions) {
        this.log('INFO', `[#1052-diag] PATH ws-open → resync PTY size ${this.lastDimensions.cols}x${this.lastDimensions.rows}`);
        this.sendResize(this.lastDimensions.cols, this.lastDimensions.rows);
      } else {
        this.log('INFO', '[#1052-diag] PATH ws-open → NO lastDimensions (PTY left at default size)');
      }
      // Force a redraw-SIGWINCH after the connection settles if nothing has
      // rendered (#1047), mirroring the web dashboard's post-connect resize.
      this.renderedSinceConnect = false;
      this.log('INFO', `[#1052-diag] PATH ws-open → lastSeq=${this.lastSeq}`);
      this.scheduleRepaintNudge();
    });

    this.ws.on('message', (raw: ArrayBuffer) => {
      const data = Buffer.from(raw);
      if (data.length === 0) { return; }

      const prefix = data[0];
      if (prefix === FRAME_DATA) {
        this.handleData(data.subarray(1));
      } else if (prefix === FRAME_CONTROL) {
        const json = data.subarray(1).toString('utf-8');
        try {
          this.handleControlMessage(JSON.parse(json) as ControlMessage);
        } catch {
          this.log('WARN', `Invalid control frame: ${json}`);
        }
      }
    });

    this.ws.on('close', () => {
      // Identity guard: an intentional reconnect() (or the backpressure path)
      // closes this socket and opens a new one; this socket's `close` then
      // fires asynchronously. Ignore it if it isn't the active socket, or we'd
      // schedule a stray retry against the now-healthy connection.
      if (this.disposed || this.ws !== socket || this.gaveUp) { return; }
      this.log('WARN', 'WebSocket closed');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.log('ERROR', `WebSocket error: ${err.message}`);
      // A 4xx upgrade rejection means the session/resource is gone (Tower 404s
      // an unknown session ID). The matching `close` fires right after; give up
      // now so the close handler's scheduleReconnect() is a no-op.
      if (this.ws === socket && classifyUpgradeError(err.message) === 'permanent') {
        this.giveUp('this terminal session no longer exists on Tower');
      }
    });
  }

  /**
   * Schedule one backed-off reconnect attempt. Emits at most one notice per
   * backoff interval (not per close-event), and transitions to the give-up
   * state once the attempt budget is exhausted (#936).
   */
  private scheduleReconnect(): void {
    if (this.disposed || this.gaveUp || this.reconnectTimer) { return; }
    if (this.backoff.recordFailure() === 'give-up') {
      this.giveUp(`unable to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      return;
    }

    const delay = this.backoff.nextDelayMs();
    // Overwrite the previous notice in place: leading `\r\x1b[2K` (carriage
    // return + erase-entire-line) rewrites the same line each attempt rather
    // than stacking a new scrollback line, so only one notice is ever visible
    // and the attempt counter ticks 1/6 → 6/6 in place (#1001).
    this.hadReconnectNotice = true;
    this.writeEmitter.fire(
      `\r\x1b[2K\x1b[33m[Codev: Connection lost. retrying in ${delay / 1000}s ` +
      `(attempt ${this.backoff.attempt}/${MAX_RECONNECT_ATTEMPTS})]\x1b[0m`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reset stream state before re-opening so stale partial ANSI bytes from
      // the dead connection don't garble Tower's replayed buffer (#630).
      this.resetStreamState();
      this.connect();
    }, delay);
  }

  /**
   * Enter the terminal failure state: stop auto-retrying and surface a quiet
   * red notice carrying the clickable reconnect affordance (#936 give-up state;
   * the affordance itself is wired by ReconnectTerminalLinkProvider, #939).
   */
  private giveUp(reason: string): void {
    if (this.gaveUp) { return; }
    this.gaveUp = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.log('WARN', `Giving up reconnect: ${reason}`);
    // When reached via the exhausted-budget path, a yellow retry notice is
    // sitting on the current line; overwrite it in place. When reached via the
    // immediate-4xx path, no notice exists, so don't disturb the current line.
    // Either way the give-up notice keeps its trailing `\r\n` and is never
    // wiped — it is the terminal failure state and must stay visible (#1001).
    const prefix = this.hadReconnectNotice ? '\r\x1b[2K' : '';
    this.hadReconnectNotice = false;
    this.writeEmitter.fire(
      `${prefix}\x1b[31m[Codev: Connection lost. ${reason}. ${RECONNECT_LINK_TEXT}]\x1b[0m\r\n`,
    );
  }

  /**
   * Wipe the single in-progress retry notice line on a successful reconnect
   * (#1001). One `\r\x1b[2K` clears it because notices overwrite in place — only
   * one ever occupies the current line. No-ops (emits nothing) when no notice
   * was written, keeping the happy-path first connect silent.
   */
  private clearReconnectNotice(): void {
    if (this.hadReconnectNotice) {
      this.writeEmitter.fire('\r\x1b[2K');
      this.hadReconnectNotice = false;
    }
  }

  /** Fresh decoder + escape buffer. Shared by every (re)connect path so none
   *  leaks stale stream state into the next connection. */
  private resetStreamState(): void {
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.escapeBuffer = new EscapeBuffer();
    // Clear replay/backpressure state so a connection that dropped mid-replay
    // (no `resume` control seen) doesn't leave `replaying` stuck true and
    // mis-route the next connection's live data (#1047).
    this.replaying = false;
    this.queuedBytes = 0;
    // Drop any pending repaint nudge from a prior connection; the next WS open
    // reschedules it.
    this.clearRepaintNudge();
  }

  /**
   * Reconnect now, bypassing backoff. Called for the backpressure replay path
   * and by the user's manual recovery click (#939). Resets the attempt budget
   * and clears the give-up state so the user gets a full fresh retry chain.
   */
  reconnect(wsUrl?: string): void {
    if (this.disposed) { return; }
    if (wsUrl && wsUrl !== this.wsUrl) {
      // A successor session (#991) is a different terminal id, so our lastSeq
      // doesn't apply — reset it so connectUrl() requests a full (bounded)
      // replay against the new session rather than a stale delta (#1047).
      this.wsUrl = wsUrl;
      this.lastSeq = 0;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff.reset();
    this.gaveUp = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.resetStreamState();
    this.connect();
  }

  // ── Data handling ────────────────────────────────────────────

  private handleData(payload: Buffer): void {
    // Replay burst (bracketed by Tower's pause→…→resume, #1047): the initial
    // buffer snapshot is expected to be large and is delivered once. Pace it
    // through the chunked writer and do NOT count it toward the live
    // backpressure budget — otherwise a multi-MB replay trips the guard before
    // anything renders and the old reconnect-for-replay path looped forever.
    if (this.replaying) {
      const text = this.decoder.decode(payload, { stream: true });
      const safe = this.escapeBuffer.write(text);
      if (safe.length > 0) { this.renderedSinceConnect = true; this.writeChunked(safe); }
      return;
    }
    this.renderedSinceConnect = true;

    // Live overload: if rendered output falls far enough behind that the queue
    // exceeds MAX_QUEUE, DROP this burst rather than reconnecting. Terminal
    // output is ephemeral — the app repaints — so dropping is safe, and unlike
    // a reconnect it does not re-download the whole buffer (costly remotely)
    // or risk an infinite replay storm (#1047). Mirrors Tower's own
    // bufferedAmount drop on the send side.
    this.queuedBytes += payload.length;
    if (this.queuedBytes > MAX_QUEUE) {
      this.warnDroppedThrottled();
      this.queuedBytes = 0;
      return;
    }

    const text = this.decoder.decode(payload, { stream: true });
    const safe = this.escapeBuffer.write(text);
    if (safe.length === 0) { return; }

    // Chunk large writes to avoid CPU spikes
    if (safe.length <= CHUNK_SIZE) {
      this.writeEmitter.fire(safe);
      this.queuedBytes = 0;
    } else {
      this.writeChunked(safe);
    }
  }

  /**
   * Warn (at most once per interval) that live output was dropped under
   * backpressure. Throttled so a sustained burst can't spam the log the way
   * the old reconnect-storm did (#1047 produced ~14k lines in under an hour).
   */
  private warnDroppedThrottled(): void {
    const now = Date.now();
    if (now - this.lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
      this.lastDropWarnAt = now;
      this.log('WARN', 'Backpressure exceeded 1MB — dropping output (terminal will repaint)');
    }
  }

  /**
   * Schedule the post-connect repaint nudge (#1047). Fires once after a settle
   * delay; if the pane is still blank (nothing rendered since connect), it
   * forces a SIGWINCH so the app redraws — the equivalent of the web client's
   * unconditional post-connect resize. Skipped when replay/live output has
   * already painted, so a reconnect that rendered from the buffer doesn't
   * reflow.
   */
  private scheduleRepaintNudge(): void {
    this.clearRepaintNudge();
    this.repaintNudgeTimer = setTimeout(() => {
      this.repaintNudgeTimer = null;
      if (this.disposed || this.renderedSinceConnect) {
        this.log('INFO', `[#1052-diag] PATH nudge-timer → SKIP (disposed=${this.disposed} renderedSinceConnect=${this.renderedSinceConnect})`);
        return;
      }
      this.log('INFO', '[#1052-diag] PATH nudge-timer → blank pane, sending SIGWINCH nudge');
      this.sendRepaintNudge();
    }, REPAINT_NUDGE_DELAY_MS);
  }

  /**
   * Send a size delta that forces the running app to repaint. A 1-row change
   * then back guarantees a real terminal-size change (and thus a SIGWINCH) even
   * when the PTY is already at the target size, landing back at the correct
   * dimensions; the brief intermediate frame is overwritten at once. No-ops when
   * dimensions are unknown. Shared by the connect-time nudge and the refocus
   * repaint (#1052).
   */
  private sendRepaintNudge(): void {
    if (!this.lastDimensions) { return; }
    const { cols, rows } = this.lastDimensions;
    if (rows <= 1) { this.sendResize(cols, rows); return; }
    this.sendResize(cols, rows - 1);
    this.sendResize(cols, rows);
  }

  /**
   * Force an immediate redraw of the running app. Called when the VSCode window
   * regains focus (#1052): while the window is backgrounded Electron throttles
   * the renderer, so xterm.js's cursor/screen state can drift from the PTY and
   * the pane shows stacked frames with the cursor near the top on return. A
   * SIGWINCH makes a full-screen TUI clear and repaint a complete, correct frame
   * — the same lever as the manual window-resize workaround, performed
   * automatically. Ungated by `renderedSinceConnect` (the pane has already
   * rendered by definition on a refocus); no-ops while disposed, disconnected,
   * or mid-replay (the connect path owns the redraw then).
   */
  forceRepaint(): void {
    if (this.disposed) { this.log('INFO', '[#1052-diag] PATH forceRepaint(refocus) → SKIP disposed'); return; }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.log('INFO', '[#1052-diag] PATH forceRepaint(refocus) → SKIP socket not OPEN'); return; }
    if (this.replaying) { this.log('INFO', '[#1052-diag] PATH forceRepaint(refocus) → SKIP mid-replay'); return; }
    this.log('INFO', '[#1052-diag] PATH forceRepaint(refocus) → SIGWINCH nudge');
    this.sendRepaintNudge();
  }

  private clearRepaintNudge(): void {
    if (this.repaintNudgeTimer) {
      clearTimeout(this.repaintNudgeTimer);
      this.repaintNudgeTimer = null;
    }
  }

  private writeChunked(text: string): void {
    let offset = 0;
    const writeNext = (): void => {
      if (this.disposed || offset >= text.length) {
        this.queuedBytes = 0;
        return;
      }
      const chunk = text.substring(offset, offset + CHUNK_SIZE);
      offset += CHUNK_SIZE;
      this.writeEmitter.fire(chunk);
      setImmediate(writeNext);
    };
    writeNext();
  }

  private handleControlMessage(msg: ControlMessage): void {
    switch (msg.type) {
      case 'seq':
        this.lastSeq = (msg.payload.seq as number) ?? this.lastSeq;
        break;
      case 'pong':
        break;
      case 'pause':
        this.log('INFO', '[#1052-diag] PATH ctrl/pause → replay starting');
        this.replaying = true;
        break;
      case 'resume':
        this.log('INFO', '[#1052-diag] PATH ctrl/resume → replay done');
        this.replaying = false;
        // Flush deferred resize
        if (this.pendingResize) {
          this.sendResize(this.pendingResize.cols, this.pendingResize.rows);
          this.pendingResize = null;
        }
        break;
      case 'error':
        this.log('ERROR', `Server error: ${JSON.stringify(msg.payload)}`);
        break;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  private sendControl(msg: ControlMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    const json = JSON.stringify(msg);
    const jsonBuf = Buffer.from(json, 'utf-8');
    const frame = Buffer.allocUnsafe(1 + jsonBuf.length);
    frame[0] = FRAME_CONTROL;
    jsonBuf.copy(frame, 1);
    this.ws.send(frame);
  }

  private sendResize(cols: number, rows: number): void {
    this.sendControl({ type: 'resize', payload: { cols, rows } });
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [Terminal] [${level}] ${message}`);
  }
}
