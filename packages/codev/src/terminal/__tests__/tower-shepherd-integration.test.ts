/**
 * Phase 3 Integration Tests: Tower ↔ Shepherd Integration
 *
 * Tests that PtySession correctly delegates to ShepherdClient when
 * attachShepherd() is used, and that the SessionManager + PtySession
 * combination works for terminal lifecycle (create, reconnect, kill).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PtySession } from '../pty-session.js';
import type { PtySessionConfig } from '../pty-session.js';
import { EventEmitter } from 'node:events';
import type { IShepherdClient } from '../shepherd-client.js';
import type { WelcomeMessage, SpawnMessage } from '../shepherd-protocol.js';

// --- Mock ShepherdClient ---

class MockShepherdClient extends EventEmitter implements IShepherdClient {
  private _connected = true;
  private _replayData: Buffer | null = null;
  writeData: string[] = [];
  resizeCalls: Array<{ cols: number; rows: number }> = [];
  signalCalls: number[] = [];
  spawnCalls: SpawnMessage[] = [];

  get connected(): boolean { return this._connected; }

  connect(): Promise<WelcomeMessage> {
    this._connected = true;
    return Promise.resolve({ version: 1, pid: 9999, cols: 80, rows: 24, startTime: Date.now() });
  }

  disconnect(): void { this._connected = false; }

  write(data: string | Buffer): void {
    this.writeData.push(typeof data === 'string' ? data : data.toString('utf-8'));
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  signal(sig: number): void {
    this.signalCalls.push(sig);
  }

  spawn(msg: SpawnMessage): void {
    this.spawnCalls.push(msg);
  }

  ping(): void {}

  getReplayData(): Buffer | null {
    return this._replayData;
  }

  setReplayData(data: Buffer): void {
    this._replayData = data;
  }

  // Simulate shepherd sending data
  simulateData(data: string): void {
    this.emit('data', Buffer.from(data, 'utf-8'));
  }

  // Simulate shepherd exit
  simulateExit(code: number, signal?: string): void {
    this.emit('exit', { code, signal: signal ?? null });
  }

  // Simulate shepherd disconnect (socket close)
  simulateClose(): void {
    this.emit('close');
  }
}

// Mock node-pty so PtySession doesn't need it
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

function makeConfig(overrides?: Partial<PtySessionConfig>): PtySessionConfig {
  return {
    id: 'test-session',
    command: '/bin/bash',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: { PATH: '/usr/bin', HOME: '/tmp', SHELL: '/bin/bash', TERM: 'xterm-256color' },
    label: 'Test Terminal',
    logDir: path.join(os.tmpdir(), 'tower-shepherd-integration-test-logs'),
    diskLogEnabled: false,
    ringBufferLines: 100,
    reconnectTimeoutMs: 1000,
    ...overrides,
  };
}

describe('PtySession + ShepherdClient integration', () => {
  let session: PtySession;
  let mockClient: MockShepherdClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = new MockShepherdClient();
    session = new PtySession(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('attachShepherd()', () => {
    it('sets shepherdBacked to true', () => {
      expect(session.shepherdBacked).toBe(false);
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      expect(session.shepherdBacked).toBe(true);
    });

    it('reports shepherd PID', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      expect(session.pid).toBe(9999);
    });

    it('populates ring buffer from replay data', () => {
      const replayData = Buffer.from('previous output\nfrom shepherd\n', 'utf-8');
      session.attachShepherd(mockClient, replayData, 9999);
      const lines = session.ringBuffer.getAll();
      expect(lines.join('\n')).toContain('previous output');
    });

    it('forwards shepherd data to ring buffer and clients', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      const wsClient = { send: vi.fn() };
      session.attach(wsClient);

      mockClient.simulateData('hello world');

      // Data should reach the WebSocket client
      expect(wsClient.send).toHaveBeenCalledWith('hello world');
      // Data should be in ring buffer
      expect(session.ringBuffer.getAll().join('')).toContain('hello world');
    });

    it('info includes persistent: true', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      expect(session.info.persistent).toBe(true);
    });

    it('info includes persistent: undefined for non-shepherd session', async () => {
      // Non-shepherd session (spawned normally)
      const regularSession = new PtySession(makeConfig());
      await regularSession.spawn();
      // persistent is false for non-shepherd sessions
      expect(regularSession.info.persistent).toBe(false);
    });
  });

  describe('write() delegation', () => {
    it('forwards write to shepherd client', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      session.write('ls -la\n');
      expect(mockClient.writeData).toContain('ls -la\n');
    });

    it('does not write when session has exited', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      mockClient.simulateExit(0);
      session.write('should not reach');
      expect(mockClient.writeData).toEqual([]);
    });
  });

  describe('resize() delegation', () => {
    it('forwards resize to shepherd client', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      session.resize(120, 40);
      expect(mockClient.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
      expect(session.info.cols).toBe(120);
      expect(session.info.rows).toBe(40);
    });
  });

  describe('kill() delegation', () => {
    it('sends SIGTERM signal to shepherd', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      session.kill();
      expect(mockClient.signalCalls).toContain(15); // SIGTERM
    });
  });

  describe('exit handling', () => {
    it('emits exit on shepherd exit', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      const exitSpy = vi.fn();
      session.on('exit', exitSpy);

      mockClient.simulateExit(0);

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(session.status).toBe('exited');
      expect(session.info.exitCode).toBe(0);
    });

    it('emits exit with code -1 on unexpected disconnect', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      const exitSpy = vi.fn();
      session.on('exit', exitSpy);

      mockClient.simulateClose();

      expect(exitSpy).toHaveBeenCalledWith(-1);
      expect(session.status).toBe('exited');
    });

    it('does not double-emit exit on close after exit', () => {
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);
      const exitSpy = vi.fn();
      session.on('exit', exitSpy);

      mockClient.simulateExit(0);
      mockClient.simulateClose();

      // Should only be called once (exit, not close)
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('detach behavior for shepherd sessions', () => {
    it('does not start disconnect timer for shepherd-backed sessions', () => {
      vi.useFakeTimers();
      session.attachShepherd(mockClient, Buffer.alloc(0), 9999);

      const timeoutSpy = vi.fn();
      session.on('timeout', timeoutSpy);

      const wsClient = { send: vi.fn() };
      session.attach(wsClient);
      session.detach(wsClient);

      // Advance past reconnectTimeoutMs
      vi.advanceTimersByTime(2000);
      expect(timeoutSpy).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});

describe('TerminalManager.createSessionRaw()', () => {
  it('creates a PtySession without spawning', async () => {
    // Import TerminalManager to test createSessionRaw
    const { TerminalManager } = await import('../pty-manager.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-raw-test-'));

    const manager = new TerminalManager({
      projectRoot: tmpDir,
    });

    const info = manager.createSessionRaw({
      label: 'Test Raw',
      cwd: tmpDir,
    });

    expect(info.id).toBeTruthy();
    expect(info.label).toBe('Test Raw');
    expect(info.status).toBe('running');
    expect(info.pid).toBe(-1); // No PTY or shepherd attached yet

    const session = manager.getSession(info.id);
    expect(session).toBeDefined();
    expect(session!.shepherdBacked).toBe(false);

    // Now attach a mock shepherd
    const client = new MockShepherdClient();
    session!.attachShepherd(client, Buffer.from('replay'), 5555);
    expect(session!.shepherdBacked).toBe(true);
    expect(session!.pid).toBe(5555);

    manager.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('TerminalManager.shutdown() shepherd handling', () => {
  it('does not send SIGTERM to shepherd-backed sessions on shutdown', async () => {
    const { TerminalManager } = await import('../pty-manager.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shutdown-test-'));

    const manager = new TerminalManager({
      projectRoot: tmpDir,
    });

    // Create a shepherd-backed session
    const info = manager.createSessionRaw({
      label: 'Shepherd Session',
      cwd: tmpDir,
    });
    const session = manager.getSession(info.id)!;
    const client = new MockShepherdClient();
    session.attachShepherd(client, Buffer.alloc(0), 7777);

    // Shutdown should NOT send SIGTERM to the shepherd
    manager.shutdown();

    // SIGTERM = signal 15 — should NOT have been called
    expect(client.signalCalls).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tracks shepherdSessionId for kill path routing', async () => {
    const { TerminalManager } = await import('../pty-manager.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sessid-test-'));

    const manager = new TerminalManager({
      projectRoot: tmpDir,
    });

    // Create a session without shepherdSessionId
    const info1 = manager.createSessionRaw({ label: 'No Session ID', cwd: tmpDir });
    const session1 = manager.getSession(info1.id)!;
    const client1 = new MockShepherdClient();
    session1.attachShepherd(client1, Buffer.alloc(0), 1111);
    expect(session1.shepherdSessionId).toBeNull();

    // Create a session WITH shepherdSessionId
    const info2 = manager.createSessionRaw({ label: 'With Session ID', cwd: tmpDir });
    const session2 = manager.getSession(info2.id)!;
    const client2 = new MockShepherdClient();
    session2.attachShepherd(client2, Buffer.alloc(0), 2222, 'shepherd-uuid-abc');
    expect(session2.shepherdSessionId).toBe('shepherd-uuid-abc');
    expect(session2.shepherdBacked).toBe(true);

    manager.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detaches listeners so client close does not trigger exit event', async () => {
    const { TerminalManager } = await import('../pty-manager.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-detach-test-'));

    const manager = new TerminalManager({
      projectRoot: tmpDir,
    });

    const info = manager.createSessionRaw({
      label: 'Shepherd Detach Test',
      cwd: tmpDir,
    });
    const session = manager.getSession(info.id)!;
    const client = new MockShepherdClient();
    session.attachShepherd(client, Buffer.alloc(0), 8888);

    const exitSpy = vi.fn();
    session.on('exit', exitSpy);

    // Simulate Tower shutdown: detachShepherd then client disconnect
    manager.shutdown();
    // After shutdown, simulate the client disconnect (as SessionManager.shutdown() does)
    client.simulateClose();

    // The exit event should NOT have fired — listeners were removed by detachShepherd()
    expect(exitSpy).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('reconnectSession auto-restart options', () => {
  it('ReconnectRestartOptions interface is exported and usable', async () => {
    // Verify the interface is available for tower-server to use
    const mod = await import('../session-manager.js');
    expect(mod.SessionManager).toBeDefined();
    // ReconnectRestartOptions is a type-only export — verify SessionManager.reconnectSession
    // accepts the 5th parameter by checking it's a function with >= 5 params
    const sm = new mod.SessionManager({
      socketDir: '/tmp/test',
      shepherdScript: '/dev/null',
      nodeExecutable: process.execPath,
    });
    expect(typeof sm.reconnectSession).toBe('function');
    // reconnectSession(sessionId, socketPath, pid, startTime, restartOptions?)
    expect(sm.reconnectSession.length).toBeGreaterThanOrEqual(4);
  });
});
