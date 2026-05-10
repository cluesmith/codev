import * as vscode from 'vscode';
import { TowerClient } from '@cluesmith/codev-core/tower-client';
import { AuthWrapper } from './auth-wrapper.js';
import { detectWorkspacePath, getTowerAddress } from './workspace-detector.js';
import { SSEClient } from './sse-client.js';
import { autoStartTower } from './tower-starter.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Singleton managing Tower communication from the VS Code extension.
 *
 * Wraps TowerClient from @cluesmith/codev-core with VS Code-specific
 * concerns: state machine, Output Channel, SecretStorage auth, settings.
 */
export class ConnectionManager {
  private state: ConnectionState = 'disconnected';
  private client: TowerClient | null = null;
  private auth: AuthWrapper;
  private outputChannel: vscode.OutputChannel;
  private workspacePath: string | null = null;
  private sse: SSEClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30000;
  private disposed = false;
  private autoStartInFlight = false;

  private readonly stateChangeEmitter = new vscode.EventEmitter<ConnectionState>();
  readonly onStateChange = this.stateChangeEmitter.event;

  private readonly sseEventEmitter = new vscode.EventEmitter<{ type: string; data: string }>();
  readonly onSSEEvent = this.sseEventEmitter.event;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ) {
    this.auth = new AuthWrapper(context.secrets);
    this.outputChannel = outputChannel;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getWorkspacePath(): string | null {
    return this.workspacePath;
  }

  getClient(): TowerClient | null {
    return this.client;
  }

  /**
   * Initialize: detect workspace, create TowerClient, attempt connection.
   */
  async initialize(): Promise<void> {
    // Prime auth cache
    await this.auth.initialize();

    // Detect workspace
    this.workspacePath = detectWorkspacePath();
    if (this.workspacePath) {
      this.log('INFO', `Workspace detected: ${this.workspacePath}`);
    } else {
      this.log('WARN', 'No Codev workspace detected');
    }

    // Create TowerClient with VS Code settings and auth
    const { host, port } = getTowerAddress();
    this.client = new TowerClient({
      host,
      port,
      getAuthKey: () => this.auth.getKeySync(),
    });

    // Connect if autoConnect is enabled
    const config = vscode.workspace.getConfiguration('codev');
    const autoConnect = config.get<boolean>('autoConnect', true);
    if (autoConnect) {
      // Try connecting; if Tower isn't running, try auto-start
      await this.connect();
      if (this.state !== 'connected' && config.get<boolean>('autoStartTower', true)) {
        // A failed connect() will have scheduled a backoff retry; cancel it so the
        // explicit auto-start path isn't racing the timer.
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
          this.setState('disconnected');
        }
        this.autoStartInFlight = true;
        try {
          this.log('INFO', 'Tower not running, attempting auto-start...');
          const started = await autoStartTower(this.client!, this.workspacePath, this.outputChannel);
          if (started) {
            await this.connect();
          }
        } finally {
          this.autoStartInFlight = false;
        }
      }
    }
  }

  /**
   * Attempt to connect to Tower.
   */
  async connect(): Promise<void> {
    if (this.disposed || !this.client) { return; }
    if (this.state === 'connecting' || this.state === 'connected') { return; }
    this.setState('connecting');

    try {
      const health = await this.client.getHealth();
      if (health) {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.setState('connected');
        this.reconnectAttempt = 0;
        this.log('INFO', `Connected to Tower (status: ${health.status}, uptime: ${health.uptime}s)`);
        await this.activateWorkspace();
        this.startSSE();
      } else {
        this.log('WARN', 'Tower not responding');
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    } catch (err) {
      this.log('ERROR', `Connection failed: ${(err as Error).message}`);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  /**
   * User-initiated reconnect. Bypasses backoff and skips any pending timer.
   * No-op when already connected or already trying.
   */
  async reconnect(): Promise<void> {
    if (this.disposed) { return; }
    if (this.state === 'connected' || this.state === 'connecting') { return; }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.log('INFO', 'Manual reconnect requested');

    const config = vscode.workspace.getConfiguration('codev');
    if (config.get<boolean>('autoStartTower', true) && this.client && !this.autoStartInFlight) {
      this.autoStartInFlight = true;
      try {
        await autoStartTower(this.client, this.workspacePath, this.outputChannel);
      } finally {
        this.autoStartInFlight = false;
      }
    }

    await this.connect();
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  scheduleReconnect(): void {
    if (this.disposed || this.state === 'connected' || this.state === 'connecting') { return; }
    if (this.reconnectTimer) { return; }

    this.setState('reconnecting');
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), this.maxReconnectDelay);
    this.reconnectAttempt++;

    this.log('INFO', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /**
   * Handle a 401 response — refresh auth key and retry.
   */
  async handleAuthFailure(): Promise<void> {
    this.log('WARN', 'Auth failed (401), re-reading key from disk');
    const newKey = await this.auth.refreshKey();
    if (newKey) {
      this.log('INFO', 'Auth key refreshed');
    } else {
      this.log('ERROR', 'No auth key found — check ~/.agent-farm/local-key');
    }
  }

  // ── Workspace Activation ──────────────────────────────────────

  private async activateWorkspace(): Promise<void> {
    if (!this.client || !this.workspacePath) { return; }
    try {
      const result = await this.client.activateWorkspace(this.workspacePath);
      if (result.ok) {
        this.log('INFO', `Workspace activated: ${this.workspacePath}`);
      } else {
        const msg = `Workspace activation failed: ${result.error}`;
        this.log('ERROR', msg);
        vscode.window.showErrorMessage(`Codev: ${msg}`);
      }
    } catch (err) {
      const msg = `Workspace activation error: ${(err as Error).message}`;
      this.log('ERROR', msg);
      vscode.window.showErrorMessage(`Codev: ${msg}`);
    }
  }

  // ── SSE ───────────────────────────────────────────────────────

  private startSSE(): void {
    this.stopSSE();
    const { host, port } = getTowerAddress();
    this.sse = new SSEClient(
      `http://${host}:${port}`,
      this.outputChannel,
      () => {
        // SSE disconnected — trigger reconnection
        if (!this.disposed && this.state === 'connected') {
          this.log('WARN', 'SSE connection lost');
          this.setState('disconnected');
          this.scheduleReconnect();
        }
      },
    );
    this.sse.onEvent((type, data) => {
      this.sseEventEmitter.fire({ type, data });
    });
    this.sse.connect();
  }

  private stopSSE(): void {
    if (this.sse) {
      this.sse.dispose();
      this.sse = null;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.stateChangeEmitter.fire(newState);
    }
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);
  }

  dispose(): void {
    this.disposed = true;
    this.stopSSE();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.stateChangeEmitter.dispose();
    this.sseEventEmitter.dispose();
    this.log('INFO', 'Connection Manager disposed');
  }
}
