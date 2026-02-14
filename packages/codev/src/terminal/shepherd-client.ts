/**
 * ShepherdClient: Tower's connection to a single shepherd process.
 *
 * Connects to a shepherd via Unix socket, performs HELLO/WELCOME handshake,
 * and provides a typed API for sending/receiving frames. Emits events for
 * data, exit, replay, and errors.
 *
 * Usage:
 *   const client = new ShepherdClient('/path/to/shepherd.sock');
 *   const welcome = await client.connect();
 *   client.on('data', (buf) => { ... });
 *   client.write('ls\n');
 *   client.disconnect();
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  FrameType,
  PROTOCOL_VERSION,
  createFrameParser,
  encodeHello,
  encodeData,
  encodeResize,
  encodeSignal,
  encodeSpawn,
  encodePing,
  encodePong,
  parseJsonPayload,
  isKnownFrameType,
  type ParsedFrame,
  type WelcomeMessage,
  type ExitMessage,
  type SpawnMessage,
} from './shepherd-protocol.js';

export interface IShepherdClient extends EventEmitter {
  connect(): Promise<WelcomeMessage>;
  disconnect(): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  signal(sig: number): void;
  spawn(msg: SpawnMessage): void;
  ping(): void;
  getReplayData(): Buffer | null;
  readonly connected: boolean;
}

export class ShepherdClient extends EventEmitter implements IShepherdClient {
  private socket: net.Socket | null = null;
  private _connected = false;
  private replayData: Buffer | null = null;

  constructor(private readonly socketPath: string) {
    super();
  }

  /**
   * Emit an 'error' event only if listeners are attached.
   * Prevents Node.js from throwing on unhandled 'error' events,
   * which would crash Tower.
   */
  private safeEmitError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the shepherd, perform HELLO/WELCOME handshake.
   * Resolves with the WelcomeMessage on success.
   * Rejects on connection error or handshake failure.
   */
  connect(): Promise<WelcomeMessage> {
    return new Promise((resolve, reject) => {
      if (this._connected) {
        reject(new Error('Already connected'));
        return;
      }

      const socket = net.createConnection(this.socketPath);
      this.socket = socket;

      let handshakeResolved = false;
      const parser = createFrameParser();

      const onError = (err: Error) => {
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(err);
        } else {
          this.safeEmitError(err);
        }
        this.cleanup();
      };

      socket.on('error', onError);
      parser.on('error', (err) => {
        this.safeEmitError(err);
        this.cleanup();
      });

      socket.on('connect', () => {
        socket.pipe(parser);
        // Send HELLO to initiate handshake
        socket.write(encodeHello({ version: PROTOCOL_VERSION }));
      });

      socket.on('close', () => {
        const wasConnected = this._connected;
        this.cleanup();
        if (wasConnected) {
          this.emit('close');
        }
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(new Error('Connection closed during handshake'));
        }
      });

      // Buffer frames that arrive before WELCOME (e.g., DATA from PTY output
      // that the shepherd forwards immediately on connection)
      const preWelcomeBuffer: ParsedFrame[] = [];

      parser.on('data', (frame: ParsedFrame) => {
        if (!handshakeResolved) {
          if (frame.type === FrameType.WELCOME) {
            try {
              const welcome = parseJsonPayload<WelcomeMessage>(frame.payload);

              // Version mismatch handling per spec:
              // - shepherd version < Tower version → disconnect (stale shepherd)
              // - shepherd version > Tower version → warn but continue
              const shepherdVersion = welcome.version ?? 0;
              if (shepherdVersion < PROTOCOL_VERSION) {
                handshakeResolved = true;
                reject(new Error(`Shepherd protocol version ${shepherdVersion} is older than Tower version ${PROTOCOL_VERSION}`));
                this.cleanup();
                return;
              }
              if (shepherdVersion > PROTOCOL_VERSION) {
                // Newer shepherd — log warning but continue (forward compatible)
                this.emit('version-warning', shepherdVersion, PROTOCOL_VERSION);
              }

              handshakeResolved = true;
              this._connected = true;
              // Replay any buffered frames received before WELCOME
              for (const buffered of preWelcomeBuffer) {
                this.handleFrame(buffered);
              }
              resolve(welcome);
            } catch {
              handshakeResolved = true;
              reject(new Error('Invalid WELCOME payload'));
              this.cleanup();
            }
          } else {
            // Buffer non-WELCOME frames for replay after handshake
            preWelcomeBuffer.push(frame);
          }
        } else {
          // Post-handshake: dispatch frames
          this.handleFrame(frame);
        }
      });
    });
  }

  private handleFrame(frame: ParsedFrame): void {
    if (!isKnownFrameType(frame.type)) {
      // Unknown types silently ignored (forward compatibility)
      return;
    }

    switch (frame.type) {
      case FrameType.DATA:
        this.emit('data', frame.payload);
        break;
      case FrameType.EXIT: {
        try {
          const exit = parseJsonPayload<ExitMessage>(frame.payload);
          this.emit('exit', exit);
        } catch {
          this.safeEmitError(new Error('Invalid EXIT payload'));
        }
        break;
      }
      case FrameType.REPLAY:
        this.replayData = frame.payload;
        this.emit('replay', frame.payload);
        break;
      case FrameType.PING:
        this.socket?.write(encodePong());
        break;
      case FrameType.PONG:
        this.emit('pong');
        break;
      case FrameType.WELCOME:
        // Duplicate WELCOME after handshake — ignore
        break;
      default:
        // Other frame types (HELLO, RESIZE, SIGNAL, SPAWN) are shepherd-bound,
        // not expected from shepherd → Tower
        break;
    }
  }

  disconnect(): void {
    this.cleanup();
  }

  private cleanup(): void {
    this._connected = false;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }

  write(data: string | Buffer): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodeData(data));
  }

  resize(cols: number, rows: number): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodeResize({ cols, rows }));
  }

  signal(sig: number): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodeSignal({ signal: sig }));
  }

  spawn(msg: SpawnMessage): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodeSpawn(msg));
  }

  ping(): void {
    if (!this._connected || !this.socket) return;
    this.socket.write(encodePing());
  }

  /** Get the last received replay data, or null if none. */
  getReplayData(): Buffer | null {
    return this.replayData;
  }
}
