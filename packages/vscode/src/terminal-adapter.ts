import * as vscode from 'vscode';
import WebSocket from 'ws';
import { FRAME_CONTROL, FRAME_DATA, type ControlMessage } from '@cluesmith/codev-types';
import { EscapeBuffer } from '@cluesmith/codev-core/escape-buffer';

const CHUNK_SIZE = 16384; // 16KB — chunk onDidWrite to avoid CPU spikes
const MAX_QUEUE = 1048576; // 1MB — disconnect if queue exceeds this

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
  private disposed = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private wsUrl: string,
    private authKey: string | null,
    private outputChannel: vscode.OutputChannel,
  ) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.lastDimensions = { cols: initialDimensions.columns, rows: initialDimensions.rows };
    }
    // Prime the renderer synchronously inside open() — VS Code drops or
    // mis-orders writes that arrive purely asynchronously after open()
    // when the terminal becomes the active editor (microsoft/vscode#108298),
    // which manifests as a blank pane when openTerminal calls show(false).
    this.writeEmitter.fire('');
    this.connect();
  }

  close(): void {
    this.disposed = true;
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
    this.lastDimensions = { cols: dimensions.columns, rows: dimensions.rows };
    if (this.replaying) {
      // Defer resize during replay to prevent garbled rendering (Bugfix #625)
      this.pendingResize = { cols: dimensions.columns, rows: dimensions.rows };
      return;
    }
    this.sendResize(dimensions.columns, dimensions.rows);
  }

  // ── WebSocket ────────────────────────────────────────────────

  private connect(): void {
    if (this.disposed) { return; }

    this.log('INFO', `Connecting to ${this.wsUrl}`);
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.on('open', () => {
      this.log('INFO', 'WebSocket connected');
      this.reconnectAttempts = 0;
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
        this.sendResize(this.lastDimensions.cols, this.lastDimensions.rows);
      }
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

    // Capture reference for the close-handler identity check below
    const closedWs = this.ws;
    this.ws.on('close', () => {
      // Guard against stale close events: if reconnect() was called while
      // this socket was still closing, this.ws now points at a healthy new
      // connection. Only schedule a reconnect if we're still looking at the
      // same socket instance that just closed.
      if (!this.disposed && this.ws === closedWs) {
        this.log('WARN', 'WebSocket closed');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.log('ERROR', `WebSocket error: ${err.message}`);
    });
  }

  reconnect(wsUrl?: string): void {
    if (wsUrl) { this.wsUrl = wsUrl; }
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.escapeBuffer = new EscapeBuffer();
    this.connect();
  }

  // ── Reconnection ─────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) { return; }

    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.writeEmitter.fire('\x1b[31m[Codev: Connection lost — max reconnect attempts reached]\x1b[0m\r\n');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
    this.writeEmitter.fire(`\x1b[33m[Codev: Connection lost, reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})]\x1b[0m\r\n`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reset decoder and escape buffer before reconnecting — stale bytes
      // from the dead connection would otherwise get prepended to the first
      // replay chunk, garbling output (same reset as reconnect() at L169-170).
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.escapeBuffer = new EscapeBuffer();
      this.connect();
    }, delay);
  }

  // ── Data handling ────────────────────────────────────────────

  private handleData(payload: Buffer): void {
    // Backpressure check
    this.queuedBytes += payload.length;
    if (this.queuedBytes > MAX_QUEUE) {
      this.log('WARN', 'Backpressure exceeded 1MB — disconnecting for replay');
      this.queuedBytes = 0;
      this.reconnect();
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
        this.replaying = true;
        break;
      case 'resume':
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
