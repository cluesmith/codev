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
  private queuedBytes = 0;
  private disposed = false;

  constructor(
    private wsUrl: string,
    private authKey: string | null,
    private outputChannel: vscode.OutputChannel,
  ) {}

  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.connect();
  }

  close(): void {
    this.disposed = true;
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

  setDimensions(dimensions: vscode.TerminalDimensions): void {
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
      // Send auth via control message (not query param)
      if (this.authKey) {
        this.sendControl({ type: 'ping', payload: { auth: this.authKey } });
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

    this.ws.on('close', () => {
      if (!this.disposed) {
        this.log('WARN', 'WebSocket closed');
        this.writeEmitter.fire('\x1b[33m[Codev: Connection lost, reconnecting...]\x1b[0m\r\n');
        // Reconnection handled by terminal-manager
      }
    });

    this.ws.on('error', (err) => {
      this.log('ERROR', `WebSocket error: ${err.message}`);
    });
  }

  reconnect(wsUrl?: string): void {
    if (wsUrl) { this.wsUrl = wsUrl; }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.escapeBuffer = new EscapeBuffer();
    this.connect();
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
