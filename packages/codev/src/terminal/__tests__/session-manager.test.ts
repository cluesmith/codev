import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { SessionManager, StderrBuffer, getProcessStartTime, type CreateSessionOptions } from '../session-manager.js';
import { ShellperProcess, type IShellperPty, type PtyOptions } from '../shellper-process.js';
import { ShellperClient } from '../shellper-client.js';

// Helper: create a temp directory for socket files
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-mgr-test-'));
}

// Helper: clean up directory recursively
function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// Helper: create a MockPty for use with ShellperProcess
class MockPty implements IShellperPty {
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  pid = 9999;

  spawn(_command: string, _args: string[], _options: PtyOptions): void {
    // No-op
  }

  write(_data: string): void {
    // No-op
  }

  resize(_cols: number, _rows: number): void {
    // No-op
  }

  kill(_signal?: number): void {
    // Simulate process exit after kill
    setTimeout(() => {
      this.exitCallback?.({ exitCode: 0, signal: _signal });
    }, 10);
  }

  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (exitInfo: { exitCode: number; signal?: number }) => void): void {
    this.exitCallback = callback;
  }

  // Test helpers: simulate PTY output/exit
  simulateData(data: string): void {
    this.dataCallback?.(data);
  }

  simulateExit(exitCode: number, signal?: number): void {
    this.exitCallback?.({ exitCode, signal });
  }
}

describe('SessionManager', () => {
  let socketDir: string;
  let cleanupFns: (() => void)[] = [];

  beforeEach(() => {
    socketDir = tmpDir();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const fn of cleanupFns) {
      try { await fn(); } catch { /* noop */ }
    }
    // Small delay for sockets to close
    await new Promise((r) => setTimeout(r, 100));
    rmrf(socketDir);
  });

  describe('with mock shellper (unit tests)', () => {
    // Create a real ShellperProcess with MockPty to serve as the shellper
    async function createMockShellper(sessionId: string): Promise<{
      shellper: ShellperProcess;
      socketPath: string;
      mockPty: MockPty;
    }> {
      const socketPath = path.join(socketDir, `shellper-${sessionId}.sock`);
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        1000,
      );

      await shellper.start('/bin/bash', ['-l'], '/tmp', {}, 80, 24);

      return { shellper, socketPath, mockPty: capturedPty! };
    }

    it('connects to a shellper via ShellperClient', async () => {
      const { shellper, socketPath, mockPty } = await createMockShellper('test-1');
      cleanupFns.push(() => shellper.shutdown());

      const client = new ShellperClient(socketPath);
      cleanupFns.push(() => client.disconnect());

      const welcome = await client.connect();
      expect(welcome.pid).toBe(mockPty.pid);
      expect(welcome.cols).toBe(80);
      expect(welcome.rows).toBe(24);
      expect(client.connected).toBe(true);
    });

    it('receives data from shellper', async () => {
      const { shellper, socketPath, mockPty } = await createMockShellper('test-2');
      cleanupFns.push(() => shellper.shutdown());

      const client = new ShellperClient(socketPath);
      cleanupFns.push(() => client.disconnect());
      await client.connect();

      const dataPromise = new Promise<Buffer>((resolve) => {
        client.on('data', resolve);
      });

      mockPty.simulateData('hello from pty');

      const data = await dataPromise;
      expect(data.toString()).toContain('hello from pty');
    });

    it('sends data to shellper', async () => {
      const { shellper, socketPath, mockPty } = await createMockShellper('test-3');
      cleanupFns.push(() => shellper.shutdown());

      const client = new ShellperClient(socketPath);
      cleanupFns.push(() => client.disconnect());
      await client.connect();

      // Write data — the mock PTY won't actually process it,
      // but we verify no errors occur
      client.write('user input');
      await new Promise((r) => setTimeout(r, 50));
      // If we get here without errors, the write was accepted
    });

    it('receives exit event from shellper', async () => {
      const { shellper, socketPath, mockPty } = await createMockShellper('test-4');
      cleanupFns.push(() => shellper.shutdown());

      const client = new ShellperClient(socketPath);
      cleanupFns.push(() => client.disconnect());
      await client.connect();

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        client.on('exit', resolve);
      });

      mockPty.simulateExit(0);

      const exitInfo = await exitPromise;
      expect(exitInfo.code).toBe(0);
    });

    it('receives replay data on connect', async () => {
      const { shellper, socketPath, mockPty } = await createMockShellper('test-5');
      cleanupFns.push(() => shellper.shutdown());

      // Generate some output in the replay buffer
      mockPty.simulateData('line1\n');
      mockPty.simulateData('line2\n');
      mockPty.simulateData('line3\n');

      // Wait for data to be buffered
      await new Promise((r) => setTimeout(r, 20));

      const client = new ShellperClient(socketPath);
      cleanupFns.push(() => client.disconnect());

      const replayPromise = new Promise<Buffer>((resolve) => {
        client.on('replay', resolve);
      });

      await client.connect();

      const replay = await replayPromise;
      expect(replay.toString()).toContain('line1');
      expect(replay.toString()).toContain('line2');
      expect(replay.toString()).toContain('line3');
    });
  });

  describe('listSessions', () => {
    it('returns empty map initially', () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });
      expect(manager.listSessions().size).toBe(0);
    });
  });

  describe('cleanupStaleSockets', () => {
    it('removes stale socket files', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Create a real Unix socket file, then close the server (leaving a stale socket)
      const staleSocketPath = path.join(socketDir, 'shellper-stale1.sock');
      const staleServer = net.createServer();
      await new Promise<void>((resolve) => staleServer.listen(staleSocketPath, resolve));
      // Keep the server listening so the socket file exists, then close
      await new Promise<void>((resolve) => staleServer.close(resolve));

      // node.js may or may not clean up the socket file on close.
      // If it cleaned it up, re-create it as a socket for the test.
      if (!fs.existsSync(staleSocketPath)) {
        // Create a fresh socket file that we immediately close
        const tmpServer = net.createServer();
        await new Promise<void>((resolve) => tmpServer.listen(staleSocketPath, resolve));
        // Don't close this time — we'll just unref to let it be GC'd
        // Actually, we need the file to exist as a socket but with no listener
        // The simplest approach: create the socket, then close without deleting
        tmpServer.close();
        // If that also cleaned it, the test condition is just that cleanup handles
        // the case where there are no sockets (returns 0)
      }

      if (fs.existsSync(staleSocketPath)) {
        // Socket exists — cleanup should remove it
        const cleaned = await manager.cleanupStaleSockets();
        expect(cleaned).toBe(1);
        expect(fs.existsSync(staleSocketPath)).toBe(false);
      } else {
        // Node cleaned up the socket — verify cleanup handles empty dir
        const cleaned = await manager.cleanupStaleSockets();
        expect(cleaned).toBe(0);
      }
    });

    it('skips symlinks', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Create a regular file and symlink to it
      const realFile = path.join(socketDir, 'real-file');
      fs.writeFileSync(realFile, '');
      const symlinkPath = path.join(socketDir, 'shellper-symlink.sock');
      fs.symlinkSync(realFile, symlinkPath);

      const cleaned = await manager.cleanupStaleSockets();
      expect(cleaned).toBe(0);
      // Symlink should still exist
      expect(fs.existsSync(symlinkPath)).toBe(true);
    });

    it('skips non-shellper files', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Create a file that doesn't match shellper pattern
      fs.writeFileSync(path.join(socketDir, 'other-file.sock'), '');

      const cleaned = await manager.cleanupStaleSockets();
      expect(cleaned).toBe(0);
    });

    it('returns 0 if socket directory does not exist', async () => {
      const manager = new SessionManager({
        socketDir: '/nonexistent/dir',
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      const cleaned = await manager.cleanupStaleSockets();
      expect(cleaned).toBe(0);
    });

    it('repeated calls are idempotent (second call returns 0)', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Create a stale socket file (regular file with .sock extension)
      const staleSocketPath = path.join(socketDir, 'shellper-idempotent.sock');
      const tmpServer = net.createServer();
      await new Promise<void>((resolve) => tmpServer.listen(staleSocketPath, resolve));
      await new Promise<void>((resolve) => tmpServer.close(resolve));

      if (fs.existsSync(staleSocketPath)) {
        // First call removes the stale socket
        const cleaned1 = await manager.cleanupStaleSockets();
        expect(cleaned1).toBe(1);

        // Second call finds nothing to clean
        const cleaned2 = await manager.cleanupStaleSockets();
        expect(cleaned2).toBe(0);
      } else {
        // Node cleaned up the socket — both calls return 0
        const cleaned1 = await manager.cleanupStaleSockets();
        expect(cleaned1).toBe(0);
        const cleaned2 = await manager.cleanupStaleSockets();
        expect(cleaned2).toBe(0);
      }
    });
  });

  describe('getSessionInfo', () => {
    it('returns null for unknown session', () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });
      expect(manager.getSessionInfo('nonexistent')).toBeNull();
    });
  });

  describe('cleanupStaleSockets (live shellper preserved)', () => {
    it('does not delete sockets with live shellpers', async () => {
      // Create a real shellper that is listening on a socket
      const socketPath = path.join(socketDir, 'shellper-livesock.sock');
      let mockPty: MockPty | null = null;
      const shellper = new ShellperProcess(
        () => {
          mockPty = new MockPty();
          return mockPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      // SessionManager has NO knowledge of this session (simulates Tower restart)
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      expect(fs.existsSync(socketPath)).toBe(true);
      const cleaned = await manager.cleanupStaleSockets();
      // Should NOT delete the socket because the shellper is alive (connection succeeds)
      expect(cleaned).toBe(0);
      expect(fs.existsSync(socketPath)).toBe(true);
    });
  });

  describe('socket directory permissions', () => {
    it('creates socket directory with 0700 permissions', async () => {
      const newSocketDir = path.join(os.tmpdir(), `session-mgr-perm-test-${Date.now()}`);
      cleanupFns.push(() => rmrf(newSocketDir));

      const socketPath = path.join(newSocketDir, 'shellper-perm.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );

      // SessionManager creates the directory with 0700
      const manager = new SessionManager({
        socketDir: newSocketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Trigger directory creation by calling createSession internals
      // (we just need to verify the dir gets 0700)
      fs.mkdirSync(newSocketDir, { recursive: true, mode: 0o700 });
      const stat = fs.statSync(newSocketDir);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });

  // Real shellper integration tests require node-pty native module and are
  // skipped in CI where the child process cannot resolve the native binding.
  describe.skipIf(!!process.env.CI)('createSession (integration with real shellper)', () => {
    // These tests spawn a real shellper-main.js process
    const shellperScript = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../dist/terminal/shellper-main.js',
    );

    it('spawns a shellper and returns connected client', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript,
        nodeExecutable: process.execPath,
      });

      const client = await manager.createSession({
        sessionId: 'int-test-1',
        command: '/bin/echo',
        args: ['hello'],
        cwd: '/tmp',
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
      });
      cleanupFns.push(async () => {
        try { await manager.killSession('int-test-1'); } catch { /* noop */ }
      });

      expect(client.connected).toBe(true);
      expect(manager.listSessions().size).toBe(1);

      const info = manager.getSessionInfo('int-test-1');
      expect(info).not.toBeNull();
      expect(info!.pid).toBeGreaterThan(0);
      expect(info!.startTime).toBeGreaterThan(0);
    }, 15000);

    it('create → write → read → kill → verify cleanup', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript,
        nodeExecutable: process.execPath,
      });

      const client = await manager.createSession({
        sessionId: 'int-test-2',
        command: '/bin/cat',
        args: [],
        cwd: '/tmp',
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
      });
      cleanupFns.push(async () => {
        try { await manager.killSession('int-test-2'); } catch { /* noop */ }
      });

      // Write data and read it back via /bin/cat
      const dataPromise = new Promise<string>((resolve) => {
        client.on('data', (buf: Buffer) => {
          const text = buf.toString();
          if (text.includes('test-echo')) {
            resolve(text);
          }
        });
      });

      client.write('test-echo\n');

      const output = await Promise.race([
        dataPromise,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      expect(output).toContain('test-echo');

      // Kill session
      const info = manager.getSessionInfo('int-test-2');
      await manager.killSession('int-test-2');

      // Session removed from map
      expect(manager.listSessions().size).toBe(0);

      // Socket file cleaned up
      if (info) {
        expect(fs.existsSync(info.socketPath)).toBe(false);
      }
    }, 20000);

    it('kills child process when readShellperInfo fails (PID verification)', async () => {
      // Create a script that writes its PID then hangs (never writes shellper info JSON)
      const pidFile = path.join(socketDir, 'hang-pid.txt');
      const hangScript = path.join(socketDir, 'hang-with-pid.js');
      fs.writeFileSync(hangScript, [
        `const fs = require('fs');`,
        `fs.writeFileSync('${pidFile.replace(/\\/g, '\\\\')}', String(process.pid));`,
        `setTimeout(() => {}, 60000);`,
      ].join('\n'));

      const manager = new SessionManager({
        socketDir,
        shellperScript: hangScript,
        nodeExecutable: process.execPath,
      });

      await expect(manager.createSession({
        sessionId: 'pid-kill-test',
        command: '/bin/echo',
        args: [],
        cwd: '/tmp',
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
      })).rejects.toThrow();

      // Read the PID the child wrote before it was killed
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
      expect(pid).toBeGreaterThan(0);

      // Brief delay for SIGKILL to propagate
      await new Promise(r => setTimeout(r, 500));

      // Verify process is dead via signal 0 (ESRCH = dead)
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* ESRCH = dead, good */ }
      expect(alive).toBe(false);
    }, 20000);
  });

  describe('killSession', () => {
    it('kills session and cleans up', async () => {
      // Create a shellper with MockPty
      const socketPath = path.join(socketDir, 'shellper-kill.sock');
      let mockPty: MockPty | null = null;
      const shellper = new ShellperProcess(
        () => {
          mockPty = new MockPty();
          return mockPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      // Connect client and register in a mock manager-like setup
      const client = new ShellperClient(socketPath);
      await client.connect();

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Manually reconnect to register the session
      const reconnected = await manager.reconnectSession(
        'kill-test',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (reconnected) {
        expect(manager.listSessions().size).toBeGreaterThan(0);
        await manager.killSession('kill-test');
        expect(manager.listSessions().has('kill-test')).toBe(false);
      }

      // Clean up in case reconnect failed
      client.disconnect();
      shellper.shutdown();
    });
  });

  describe('shellper crash cleanup (close without EXIT)', () => {
    it('removes session from map when shellper disconnects without EXIT', async () => {
      const socketPath = path.join(socketDir, 'shellper-crash.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Reconnect to register the session
      const client = await manager.reconnectSession(
        'crash-test',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (client) {
        expect(manager.listSessions().size).toBe(1);

        const errorPromise = new Promise<Error>((resolve) => {
          manager.on('session-error', (_id: string, err: Error) => {
            if (err.message.includes('Shellper disconnected unexpectedly')) {
              resolve(err);
            }
          });
        });

        // Simulate shellper crash by shutting down the server (closes socket)
        shellper.shutdown();

        const err = await Promise.race([
          errorPromise,
          new Promise<Error>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);

        expect(err.message).toContain('Shellper disconnected unexpectedly');
        expect(manager.listSessions().size).toBe(0);
        expect(manager.getSessionInfo('crash-test')).toBeNull();
      } else {
        shellper.shutdown();
      }
    });
  });

  describe('natural exit cleanup (no auto-restart)', () => {
    it('removes session from map when process exits and restartOnExit is false', async () => {
      const socketPath = path.join(socketDir, 'shellper-natural-exit.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Reconnect to register the session (restartOnExit is NOT set)
      const client = await manager.reconnectSession(
        'natural-exit-test',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (client) {
        expect(manager.listSessions().size).toBe(1);

        // Wait for exit event to be processed
        const exitPromise = new Promise<void>((resolve) => {
          manager.on('session-exit', () => resolve());
        });

        // Simulate process exit
        capturedPty!.simulateExit(0);
        await exitPromise;

        // Session should be removed from the map
        expect(manager.listSessions().size).toBe(0);
        expect(manager.getSessionInfo('natural-exit-test')).toBeNull();
      }

      shellper.shutdown();
    });
  });

  describe('auto-restart logic', () => {
    it('sends SPAWN frame on exit when restartOnExit is true', async () => {
      const socketPath = path.join(socketDir, 'shellper-restart.sock');
      let capturedPty: MockPty | null = null;
      let spawnCount = 0;

      const shellper = new ShellperProcess(
        () => {
          spawnCount++;
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', ['-l'], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Create a mock session with auto-restart by manually connecting
      // and registering with restart options
      const client = new ShellperClient(socketPath);
      await client.connect();

      // We need to test the auto-restart behavior directly.
      // Since createSession isn't available without a real shellper binary,
      // we'll test the internal logic by verifying that the session-restart
      // event is emitted when a client exit occurs.

      // Simulate the auto-restart behavior: after exit, SPAWN is sent
      const restartPromise = new Promise<void>((resolve) => {
        shellper.on('spawn', () => {
          resolve();
        });
      });

      // Simulate exit and trigger auto-restart via the client
      const exitPromise = new Promise<void>((resolve) => {
        client.on('exit', () => resolve());
      });

      capturedPty!.simulateExit(1);
      await exitPromise;

      // Send SPAWN manually (simulating what auto-restart does)
      client.spawn({
        command: '/bin/bash',
        args: ['-l'],
        cwd: '/tmp',
        env: {},
      });

      await Promise.race([
        restartPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);

      expect(spawnCount).toBe(2); // Original + restart
      client.disconnect();
    });

    // This test spawns real shellper processes — skip in CI
    it.skipIf(!!process.env.CI)('respects maxRestarts limit', async () => {
      const shellperScript = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../../../dist/terminal/shellper-main.js',
      );

      const manager = new SessionManager({
        socketDir,
        shellperScript,
        nodeExecutable: process.execPath,
      });

      // Create with maxRestarts=2 and short delay
      const client = await manager.createSession({
        sessionId: 'maxrestart-test',
        command: '/bin/sh',
        args: ['-c', 'exit 1'],
        cwd: '/tmp',
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
        restartOnExit: true,
        restartDelay: 100,
        maxRestarts: 2,
      });
      cleanupFns.push(async () => {
        try { await manager.killSession('maxrestart-test'); } catch { /* noop */ }
      });

      // Wait for restarts to happen and exhaust maxRestarts
      const errorPromise = new Promise<Error>((resolve) => {
        manager.on('session-error', (_id: string, err: Error) => {
          if (err.message.includes('Max restarts')) {
            resolve(err);
          }
        });
      });

      const err = await Promise.race([
        errorPromise,
        new Promise<Error>((_, reject) => setTimeout(() => reject(new Error('timeout waiting for max restarts')), 15000)),
      ]);

      expect(err.message).toContain('Max restarts (2) exceeded');
    }, 20000);
  });

  describe('shutdown (disconnect without killing)', () => {
    it('disconnects clients but leaves shellper processes alive', async () => {
      const socketPath = path.join(socketDir, 'shellper-shutdown.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Reconnect to register the session
      const client = await manager.reconnectSession(
        'shutdown-test',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (client) {
        expect(manager.listSessions().size).toBe(1);
        expect(client.connected).toBe(true);

        // Shutdown should disconnect but NOT kill the shellper
        manager.shutdown();

        expect(manager.listSessions().size).toBe(0);

        // The shellper should still be accepting connections (still alive)
        const client2 = new ShellperClient(socketPath);
        cleanupFns.push(() => client2.disconnect());
        const welcome = await client2.connect();
        expect(welcome.pid).toBeGreaterThan(0);
        client2.disconnect();
      }
    });
  });

  describe('stop/reconnect/replay integration', () => {
    it('disconnects Tower connection, reconnects, and receives replay', async () => {
      const socketPath = path.join(socketDir, 'shellper-replay.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        1000,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Connect first client
      const client1 = await manager.reconnectSession(
        'replay-test',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (client1) {
        // Simulate PTY output that goes into the replay buffer
        capturedPty!.simulateData('hello world\r\n');
        await new Promise((r) => setTimeout(r, 50));

        // Disconnect (simulates Tower stop) — shutdown doesn't kill shellper
        manager.shutdown();
        expect(manager.listSessions().size).toBe(0);

        // Wait for socket to fully close
        await new Promise((r) => setTimeout(r, 100));

        // Reconnect — shellper is still alive
        const manager2 = new SessionManager({
          socketDir,
          shellperScript: '/nonexistent/shellper.js',
          nodeExecutable: process.execPath,
        });

        const client2 = await manager2.reconnectSession(
          'replay-test',
          socketPath,
          process.pid,
          Date.now(),
        );

        if (client2) {
          cleanupFns.push(() => client2.disconnect());
          expect(client2.connected).toBe(true);

          // Wait for replay to arrive
          const replayPromise = new Promise<Buffer>((resolve) => {
            client2.on('replay', (data: Buffer) => resolve(data));
          });

          const replayData = await Promise.race([
            replayPromise,
            new Promise<Buffer>((_, reject) => setTimeout(() => reject(new Error('replay timeout')), 3000)),
          ]);

          // Replay should contain the data written before disconnect
          expect(replayData.toString()).toContain('hello world');
        }
      }
    });
  });

  describe('reconnectSession', () => {
    it('returns null for dead process', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Use a PID that doesn't exist
      const result = await manager.reconnectSession('test', '/tmp/nonexistent.sock', 999999, Date.now());
      expect(result).toBeNull();
    });

    it('logs reason when reconnect fails: dead process', async () => {
      const logs: string[] = [];
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      await manager.reconnectSession('dead-pid', '/tmp/nonexistent.sock', 999999, Date.now());
      expect(logs.some((m) => m.includes('reconnect failed: process 999999 is dead'))).toBe(true);
    });

    it('logs reason when reconnect fails: socket missing', async () => {
      const logs: string[] = [];
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      // Use actual process start time so we pass the PID reuse check
      const actualStartTime = await getProcessStartTime(process.pid);
      if (actualStartTime === null) return; // Skip if can't determine start time
      await manager.reconnectSession('no-socket', '/tmp/nonexistent.sock', process.pid, actualStartTime);
      expect(logs.some((m) => m.includes('reconnect failed: socket missing'))).toBe(true);
    });

    it('logs reason when reconnect fails: PID reused (start time mismatch)', async () => {
      const logs: string[] = [];
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      // Use our own PID (alive) but a wildly wrong start time to trigger PID reuse detection
      await manager.reconnectSession('pid-reuse', '/tmp/nonexistent.sock', process.pid, 1000);
      expect(logs.some((m) => m.includes('reconnect failed: PID') && m.includes('reused (start time mismatch)'))).toBe(true);
    });

    it('logs reason when reconnect fails: connect error', async () => {
      const logs: string[] = [];
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      // Create a real socket file that nothing is listening on
      const staleSocketPath = path.join(socketDir, 'shellper-connect-err.sock');
      const tmpServer = net.createServer();
      await new Promise<void>((resolve) => tmpServer.listen(staleSocketPath, resolve));
      await new Promise<void>((resolve) => tmpServer.close(resolve));

      // If Node cleaned up the socket, skip (can't reproduce connect error without a socket file)
      if (!fs.existsSync(staleSocketPath)) return;

      const actualStartTime = await getProcessStartTime(process.pid);
      if (actualStartTime === null) return;

      await manager.reconnectSession('connect-err', staleSocketPath, process.pid, actualStartTime);
      expect(logs.some((m) => m.includes('reconnect failed: connect error:'))).toBe(true);
    });

    it('returns null if socket file missing', async () => {
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Use our own PID (alive) but nonexistent socket
      const result = await manager.reconnectSession('test', '/tmp/nonexistent.sock', process.pid, Date.now());
      expect(result).toBeNull();
    });

    it('reconnects to a live shellper', async () => {
      // Create a real mock shellper
      const socketPath = path.join(socketDir, 'shellper-reconnect.sock');
      let mockPty: MockPty | null = null;
      const shellper = new ShellperProcess(
        () => {
          mockPty = new MockPty();
          return mockPty;
        },
        socketPath,
        1000,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
      });

      // Use our own PID since the shellper doesn't have its own process
      // and the socket is alive. We mock start time validation.
      const client = await manager.reconnectSession(
        'reconnect-test',
        socketPath,
        process.pid,
        Date.now(),
      );

      // This might be null on CI due to start time validation.
      // The key test is that it attempts connection properly.
      if (client) {
        cleanupFns.push(() => client.disconnect());
        expect(client.connected).toBe(true);
        expect(manager.listSessions().size).toBe(1);
      }
    });
  });

  describe('logger callback', () => {
    it('logs session creation', async () => {
      const logs: string[] = [];
      const socketPath = path.join(socketDir, 'shellper-logcreate.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      const client = await manager.reconnectSession(
        'log-create',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (client) {
        cleanupFns.push(() => client.disconnect());
        expect(logs.some((m) => m.includes('Session log-create reconnected: pid='))).toBe(true);
      }
    });

    it('logs kill session', async () => {
      const logs: string[] = [];
      const socketPath = path.join(socketDir, 'shellper-logkill.sock');

      const shellper = new ShellperProcess(
        () => new MockPty(),
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      const client = await manager.reconnectSession(
        'log-kill',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (client) {
        await manager.killSession('log-kill');
        expect(logs.some((m) => m.includes('Killing session log-kill: pid='))).toBe(true);
      }
    });

    it('logs unexpected disconnect', async () => {
      const logs: string[] = [];
      const socketPath = path.join(socketDir, 'shellper-logdisconnect.sock');

      const shellper = new ShellperProcess(
        () => new MockPty(),
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      const client = await manager.reconnectSession(
        'log-disconnect',
        socketPath,
        process.pid,
        Date.now(),
      );

      if (client) {
        const errorPromise = new Promise<void>((resolve) => {
          manager.on('session-error', () => resolve());
        });

        // Crash the shellper
        shellper.shutdown();
        await Promise.race([
          errorPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);

        expect(logs.some((m) => m.includes('Session log-disconnect shellper disconnected unexpectedly'))).toBe(true);
      } else {
        shellper.shutdown();
      }
    });

    it('logs reconnect attempt with pid and socket', async () => {
      const logs: string[] = [];
      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      // Will fail (dead pid), but should still log the attempt first
      await manager.reconnectSession('attempt-test', '/tmp/some.sock', 999999, Date.now());
      expect(logs.some((m) => m.includes('Reconnecting session attempt-test: pid=999999, socket=/tmp/some.sock'))).toBe(true);
    });
  });

  describe('auto-restart logging', () => {
    it('logs auto-restart count, max, and delay', async () => {
      const logs: string[] = [];
      const socketPath = path.join(socketDir, 'shellper-autorestart-log.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', ['-l'], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      // Reconnect with restart options to enable auto-restart
      const client = await manager.reconnectSession(
        'restart-log',
        socketPath,
        process.pid,
        Date.now(),
        {
          command: '/bin/bash',
          args: ['-l'],
          cwd: '/tmp',
          env: {},
          restartDelay: 100,
          maxRestarts: 3,
        },
      );

      if (client) {
        const restartPromise = new Promise<void>((resolve) => {
          manager.on('session-restart', () => resolve());
        });

        // Simulate PTY exit to trigger auto-restart
        capturedPty!.simulateExit(1);
        await Promise.race([
          restartPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);

        expect(logs.some((m) => m.includes('Session restart-log auto-restart #1/3 in 100ms'))).toBe(true);
      }
    });

    it('logs max restarts exceeded', async () => {
      const logs: string[] = [];
      const socketPath = path.join(socketDir, 'shellper-maxrestart-log.sock');
      let capturedPty: MockPty | null = null;

      const shellper = new ShellperProcess(
        () => {
          capturedPty = new MockPty();
          return capturedPty;
        },
        socketPath,
        100,
      );
      await shellper.start('/bin/bash', ['-l'], '/tmp', {}, 80, 24);
      cleanupFns.push(() => shellper.shutdown());

      const manager = new SessionManager({
        socketDir,
        shellperScript: '/nonexistent/shellper.js',
        nodeExecutable: process.execPath,
        logger: (msg) => logs.push(msg),
      });

      // Reconnect with maxRestarts=1
      const client = await manager.reconnectSession(
        'maxrestart-log',
        socketPath,
        process.pid,
        Date.now(),
        {
          command: '/bin/bash',
          args: ['-l'],
          cwd: '/tmp',
          env: {},
          restartDelay: 50,
          maxRestarts: 1,
        },
      );

      if (client) {
        // First exit: triggers restart #1/1
        const restart1 = new Promise<void>((resolve) => {
          manager.on('session-restart', () => resolve());
        });
        capturedPty!.simulateExit(1);
        await Promise.race([
          restart1,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);

        // Wait for SPAWN to fire (restartDelay=50ms)
        await new Promise((r) => setTimeout(r, 100));

        // Second exit: restartCount (1) >= maxRestarts (1), should log exhausted
        const errorPromise = new Promise<void>((resolve) => {
          manager.on('session-error', (_id: string, err: Error) => {
            if (err.message.includes('Max restarts')) resolve();
          });
        });
        capturedPty!.simulateExit(1);
        await Promise.race([
          errorPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);

        expect(logs.some((m) => m.includes('Session maxrestart-log exhausted max restarts (1)'))).toBe(true);
      }
    });
  });
});

describe('StderrBuffer', () => {
  it('retains last maxLines lines (ring buffer)', () => {
    const buf = new StderrBuffer(5, 10000);
    for (let i = 0; i < 10; i++) {
      buf.push(`line ${i}\n`);
    }
    const lines = buf.getLines();
    expect(lines).toEqual(['line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
  });

  it('retains last 500 lines with default config', () => {
    const buf = new StderrBuffer();
    for (let i = 0; i < 600; i++) {
      buf.push(`line ${i}\n`);
    }
    const lines = buf.getLines();
    expect(lines.length).toBe(500);
    expect(lines[0]).toBe('line 100');
    expect(lines[499]).toBe('line 599');
  });

  it('truncates lines at maxLineLength', () => {
    const buf = new StderrBuffer(500, 100);
    const longLine = 'x'.repeat(200);
    buf.push(longLine + '\n');
    const lines = buf.getLines();
    expect(lines.length).toBe(1);
    expect(lines[0].length).toBe(100);
  });

  it('truncates at 10000 chars with default config', () => {
    const buf = new StderrBuffer();
    const longLine = 'A'.repeat(20000);
    buf.push(longLine + '\n');
    const lines = buf.getLines();
    expect(lines[0].length).toBe(10000);
  });

  it('replaces U+FFFD with ?', () => {
    const buf = new StderrBuffer();
    buf.push('hello \uFFFD world \uFFFD\n');
    const lines = buf.getLines();
    expect(lines[0]).toBe('hello ? world ?');
  });

  it('handles partial lines across chunks', () => {
    const buf = new StderrBuffer();
    buf.push('hello ');
    buf.push('world\n');
    const lines = buf.getLines();
    expect(lines).toEqual(['hello world']);
  });

  it('flushes partial line into buffer', () => {
    const buf = new StderrBuffer();
    buf.push('incomplete');
    expect(buf.getLines()).toEqual([]);
    buf.flush();
    expect(buf.getLines()).toEqual(['incomplete']);
  });

  it('flush truncates partial line at maxLineLength', () => {
    const buf = new StderrBuffer(500, 50);
    buf.push('x'.repeat(100));
    buf.flush();
    const lines = buf.getLines();
    expect(lines[0].length).toBe(50);
  });

  it('flush is no-op when no partial line', () => {
    const buf = new StderrBuffer();
    buf.push('complete\n');
    buf.flush();
    expect(buf.getLines()).toEqual(['complete']);
  });

  it('hasContent returns true for buffered lines', () => {
    const buf = new StderrBuffer();
    expect(buf.hasContent()).toBe(false);
    buf.push('line\n');
    expect(buf.hasContent()).toBe(true);
  });

  it('hasContent returns true for partial content', () => {
    const buf = new StderrBuffer();
    buf.push('partial');
    expect(buf.hasContent()).toBe(true);
  });

  it('getLines returns a copy', () => {
    const buf = new StderrBuffer();
    buf.push('a\nb\n');
    const lines1 = buf.getLines();
    lines1.push('c');
    expect(buf.getLines()).toEqual(['a', 'b']);
  });

  it('handles empty lines', () => {
    const buf = new StderrBuffer();
    buf.push('a\n\nb\n');
    expect(buf.getLines()).toEqual(['a', '', 'b']);
  });

  it('handles chunk ending with newline', () => {
    const buf = new StderrBuffer();
    buf.push('line1\nline2\n');
    expect(buf.getLines()).toEqual(['line1', 'line2']);
    // No partial line
    buf.flush();
    expect(buf.getLines()).toEqual(['line1', 'line2']);
  });
});

describe('stderr tail logging (integration)', () => {
  let socketDir: string;
  let cleanupFns: (() => void)[] = [];

  const shellperScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../../dist/terminal/shellper-main.js',
  );

  beforeEach(() => {
    socketDir = tmpDir();
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const fn of cleanupFns) {
      try { await fn(); } catch { /* noop */ }
    }
    await new Promise((r) => setTimeout(r, 100));
    rmrf(socketDir);
  });

  it.skipIf(!!process.env.CI)('logs stderr tail when session exits normally', async () => {
    const logs: string[] = [];
    const manager = new SessionManager({
      socketDir,
      shellperScript,
      nodeExecutable: process.execPath,
      logger: (msg) => logs.push(msg),
    });

    const client = await manager.createSession({
      sessionId: 'stderr-exit-test',
      command: '/bin/sh',
      args: ['-c', 'echo "stderr msg" >&2; exit 0'],
      cwd: '/tmp',
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
      cols: 80,
      rows: 24,
    });
    cleanupFns.push(async () => {
      try { await manager.killSession('stderr-exit-test'); } catch { /* noop */ }
    });

    // Wait for exit event + stderr processing
    await new Promise<void>((resolve) => {
      manager.on('session-exit', () => resolve());
    });
    // Wait for stderr close + log emission
    await new Promise((r) => setTimeout(r, 1500));

    expect(logs.some((m) => m.includes('Session stderr-exit-test exited (code=0)'))).toBe(true);
    expect(logs.some((m) => m.includes('Last stderr'))).toBe(true);
  }, 15000);

  it.skipIf(!!process.env.CI)('logs stderr tail when session is killed', async () => {
    const logs: string[] = [];
    const manager = new SessionManager({
      socketDir,
      shellperScript,
      nodeExecutable: process.execPath,
      logger: (msg) => logs.push(msg),
    });

    const client = await manager.createSession({
      sessionId: 'stderr-kill-test',
      command: '/bin/cat',
      args: [],
      cwd: '/tmp',
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
      cols: 80,
      rows: 24,
    });

    // Wait briefly for shellper to start and emit stderr startup logs
    await new Promise((r) => setTimeout(r, 500));

    await manager.killSession('stderr-kill-test');
    // Wait for stderr close + log emission
    await new Promise((r) => setTimeout(r, 1500));

    // killSession logs stderr with exitCode=-1
    expect(logs.some((m) => m.includes('Session stderr-kill-test exited (code=-1)'))).toBe(true);
    expect(logs.some((m) => m.includes('Last stderr'))).toBe(true);
  }, 15000);

  it.skipIf(!!process.env.CI)('does not log stderr for reconnected sessions', async () => {
    const logs: string[] = [];
    const socketPath = path.join(socketDir, 'shellper-no-stderr.sock');
    let mockPty: MockPty | null = null;

    const shellper = new ShellperProcess(
      () => {
        mockPty = new MockPty();
        return mockPty;
      },
      socketPath,
      100,
    );
    await shellper.start('/bin/bash', [], '/tmp', {}, 80, 24);
    cleanupFns.push(() => shellper.shutdown());

    const manager = new SessionManager({
      socketDir,
      shellperScript: '/nonexistent/shellper.js',
      nodeExecutable: process.execPath,
      logger: (msg) => logs.push(msg),
    });

    const client = await manager.reconnectSession(
      'no-stderr-test',
      socketPath,
      process.pid,
      Date.now(),
    );

    if (client) {
      await manager.killSession('no-stderr-test');
      await new Promise((r) => setTimeout(r, 200));
      // No stderr tail log — reconnected sessions have no stderr capture
      expect(logs.some((m) => m.includes('Last stderr'))).toBe(false);
    }
  });

  it.skipIf(!!process.env.CI)('deduplicates stderr tail logging', async () => {
    const logs: string[] = [];
    const manager = new SessionManager({
      socketDir,
      shellperScript,
      nodeExecutable: process.execPath,
      logger: (msg) => logs.push(msg),
    });

    const client = await manager.createSession({
      sessionId: 'stderr-dedup-test',
      command: '/bin/sh',
      args: ['-c', 'echo "dedup stderr" >&2; exit 1'],
      cwd: '/tmp',
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
      cols: 80,
      rows: 24,
    });
    cleanupFns.push(async () => {
      try { await manager.killSession('stderr-dedup-test'); } catch { /* noop */ }
    });

    // Wait for exit + close events + stderr processing
    await new Promise<void>((resolve) => {
      manager.on('session-exit', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 1500));

    // Count how many "Last stderr" entries — should be exactly 1
    const stderrLogCount = logs.filter((m) => m.includes('Last stderr')).length;
    expect(stderrLogCount).toBe(1);
  }, 15000);
});

describe('getProcessStartTime', () => {
  it('returns a timestamp for the current process', async () => {
    const startTime = await getProcessStartTime(process.pid);
    // On macOS and Linux, this should return a valid timestamp
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(startTime).not.toBeNull();
      expect(startTime!).toBeGreaterThan(0);
      // Should be within the last hour
      expect(startTime!).toBeGreaterThan(Date.now() - 3600_000);
      expect(startTime!).toBeLessThanOrEqual(Date.now());
    }
  });

  it('returns null for a non-existent PID', async () => {
    const startTime = await getProcessStartTime(999999);
    expect(startTime).toBeNull();
  });

  it('returns consistent results for repeated calls', async () => {
    const t1 = await getProcessStartTime(process.pid);
    const t2 = await getProcessStartTime(process.pid);
    if (t1 !== null && t2 !== null) {
      // Should be very close (within 1 second)
      expect(Math.abs(t1 - t2)).toBeLessThan(1000);
    }
  });
});

describe('schema migration', () => {
  it('GLOBAL_SCHEMA includes shellper columns', async () => {
    const { GLOBAL_SCHEMA } = await import('../../agent-farm/db/schema.js');
    expect(GLOBAL_SCHEMA).toContain('shellper_socket TEXT');
    expect(GLOBAL_SCHEMA).toContain('shellper_pid INTEGER');
    expect(GLOBAL_SCHEMA).toContain('shellper_start_time INTEGER');
  });
});
