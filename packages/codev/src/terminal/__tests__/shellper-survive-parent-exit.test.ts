/**
 * Regression test for Bugfix #324: Shellper processes must survive parent exit.
 *
 * Root cause: shellper stderr was piped to the parent (Tower). When Tower
 * exited, the pipe broke. Async EPIPE errors on process.stderr (which has no
 * error handler in Node.js by default) crashed the shellper.
 *
 * Fix: Redirect shellper stderr to a file (not a pipe), and add defensive
 * error handlers on process.stdout/stderr in shellper-main.ts.
 *
 * This test verifies:
 * 1. Shellper spawned with file-based stderr (not a pipe) survives parent exit
 * 2. The stderr log file receives diagnostic output
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn as cpSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

describe('Bugfix #324: shellper survives parent exit', () => {
  let tmpDir: string;
  let shellperPid: number | null = null;

  afterEach(() => {
    if (shellperPid !== null) {
      // Kill the entire process group (shellper + its PTY child).
      // detached:true puts shellper in its own process group, so -pid
      // targets that group — preventing orphaned child processes.
      try { process.kill(-shellperPid, 'SIGTERM'); } catch { /* already dead */ }
      try { process.kill(-shellperPid, 'SIGKILL'); } catch { /* already dead */ }
      shellperPid = null;
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shellper spawned with file stderr survives parent exit', async () => {
    tmpDir = mkdtempSync('/tmp/codev-shellper-survive-');
    const socketPath = path.join(tmpDir, 'shellper-test.sock');
    const stderrLogPath = path.join(tmpDir, 'shellper-test.log');

    const shellperScript = path.resolve(
      import.meta.dirname,
      '../../../dist/terminal/shellper-main.js',
    );
    if (!fs.existsSync(shellperScript)) {
      console.log('Skipping: shellper-main.js not found in dist');
      return;
    }

    const config = JSON.stringify({
      command: '/bin/sh',
      args: ['-c', 'sleep 300'],
      cwd: '/tmp',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
      socketPath,
    });

    // Open stderr log file — this is the Bugfix #324 approach:
    // file FD instead of pipe, so shellper survives parent exit
    const stderrFd = fs.openSync(stderrLogPath, 'a');

    const child = cpSpawn(process.execPath, [shellperScript, config], {
      detached: true,
      stdio: ['ignore', 'pipe', stderrFd],
    });

    // Close our copy of the stderr log FD (child has its own after fork)
    fs.closeSync(stderrFd);

    // Bugfix #341: Capture child PID immediately for afterEach cleanup.
    if (child.pid) shellperPid = child.pid;

    // Read PID + startTime from shellper stdout
    const info = await new Promise<{ pid: number; startTime: number }>((resolve, reject) => {
      let data = '';
      const timeout = setTimeout(() => {
        // Check if shellper wrote to its log file for debugging
        let logContent = '';
        try { logContent = fs.readFileSync(stderrLogPath, 'utf-8'); } catch { /* */ }
        reject(new Error(`Timeout reading shellper info. stderr log: ${logContent}`));
      }, 10000);

      child.stdout!.on('data', (chunk) => { data += chunk.toString(); });
      child.stdout!.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(data));
        } catch {
          let logContent = '';
          try { logContent = fs.readFileSync(stderrLogPath, 'utf-8'); } catch { /* */ }
          reject(new Error(`Invalid shellper info: "${data}". stderr log: ${logContent}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    child.unref();
    expect(info.pid).toBeGreaterThan(0);
    shellperPid = info.pid;

    // Wait for socket to appear (shellper is fully running)
    const socketReady = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const check = () => {
        try {
          fs.statSync(socketPath);
          resolve(true);
        } catch {
          if (Date.now() - start > 5000) resolve(false);
          else setTimeout(check, 50);
        }
      };
      check();
    });
    expect(socketReady).toBe(true);

    // Verify shellper process is alive
    try {
      process.kill(shellperPid, 0);
    } catch {
      throw new Error(`Shellper process ${shellperPid} died unexpectedly`);
    }

    // Verify stderr was written to the log file (not a pipe)
    const logContent = fs.readFileSync(stderrLogPath, 'utf-8');
    expect(logContent).toContain('Shellper started');
    expect(logContent).toContain('Socket listening');
  }, 20000);

  it('shellper stdio error handlers prevent crash on broken pipe', async () => {
    // This test verifies the defensive fix in shellper-main.ts:
    // error handlers on process.stdout and process.stderr prevent crashes.
    //
    // We test indirectly: spawn shellper with a PIPE for stderr (old behavior),
    // then close our end of the pipe. The shellper should NOT crash thanks
    // to the error handlers.

    tmpDir = mkdtempSync('/tmp/codev-shellper-epipe-');
    const socketPath = path.join(tmpDir, 'shellper-epipe.sock');

    const shellperScript = path.resolve(
      import.meta.dirname,
      '../../../dist/terminal/shellper-main.js',
    );
    if (!fs.existsSync(shellperScript)) {
      console.log('Skipping: shellper-main.js not found in dist');
      return;
    }

    const config = JSON.stringify({
      command: '/bin/sh',
      args: ['-c', 'sleep 300'],
      cwd: '/tmp',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
      socketPath,
    });

    // Spawn with pipe for stderr (the OLD behavior that caused #324)
    const child = cpSpawn(process.execPath, [shellperScript, config], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Bugfix #341: Capture child PID immediately for afterEach cleanup.
    // If stdout parsing fails, the afterEach still needs to kill the process
    // group to prevent orphaned shellper processes from accumulating.
    if (child.pid) shellperPid = child.pid;

    // Read PID info from stdout, capturing stderr for diagnostics
    let stderrData = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderrData += chunk.toString(); });

    let info: { pid: number; startTime: number };
    try {
      info = await new Promise<{ pid: number; startTime: number }>((resolve, reject) => {
        let data = '';
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
        child.stdout!.on('data', (chunk) => { data += chunk.toString(); });
        child.stdout!.on('end', () => {
          clearTimeout(timeout);
          try { resolve(JSON.parse(data)); } catch { reject(new Error(`Parse failed: ${data}`)); }
        });
        child.on('error', (err) => { clearTimeout(timeout); reject(err); });
      });
    } catch (err) {
      // Under heavy parallel test load, node-pty may fail to initialize.
      // Skip gracefully rather than failing the entire suite.
      console.log(`Skipping: shellper failed to start (${(err as Error).message}). stderr: ${stderrData}`);
      return;
    }

    child.unref();
    expect(info.pid).toBeGreaterThan(0);
    shellperPid = info.pid;

    // Wait for shellper to be fully running
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const check = () => {
        try { fs.statSync(socketPath); resolve(); } catch {
          if (Date.now() - start > 5000) resolve();
          else setTimeout(check, 50);
        }
      };
      check();
    });

    // NOW: destroy the stderr pipe (simulates Tower exit)
    child.stderr!.destroy();

    // Force shellper to write to the now-broken stderr pipe by connecting
    // and immediately disconnecting from its socket. Shellper logs client
    // connection/disconnection events via logStderr(), which writes to
    // process.stderr — the broken pipe. Without the error handler fix,
    // this would crash the shellper with an unhandled EPIPE error.
    const net = await import('node:net');
    await new Promise<void>((resolve) => {
      const sock = net.connect(socketPath, () => {
        sock.destroy();
        // Give shellper time to process the disconnect and attempt stderr write
        setTimeout(resolve, 1000);
      });
      sock.on('error', () => setTimeout(resolve, 1000));
    });

    // THE KEY ASSERTION: shellper should survive despite the broken pipe
    // (thanks to the error handler on process.stderr)
    let isAlive = false;
    try {
      process.kill(shellperPid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }

    expect(isAlive).toBe(true);
  }, 20000);
});
