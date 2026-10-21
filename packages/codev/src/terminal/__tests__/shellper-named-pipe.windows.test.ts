/**
 * Spec 1658 Phase 2, native Windows only (the on-demand `windows.yml` targeted
 * job runs it against the built checkout; it skips everywhere else):
 *
 * - A real `\\.\pipe\` shellper spawned by one SessionManager is reconnected,
 *   with replay, by a fresh SessionManager after the first is discarded.
 * - A connection without the secret receives zero bytes from a real pipe.
 * - Scenario 14: a second, non-admin local user opens the pipe and receives
 *   zero bytes, and frames it sends have no effect. This creates a local user,
 *   so it also requires CI (the runner account is an administrator).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager, isIdentityRefused } from '../session-manager.js';
import type { IShellperClient } from '../shellper-client.js';
import { isPipeEndpoint } from '../shellper-endpoint.js';
import { encodeData, encodeHello, PROTOCOL_VERSION } from '../shellper-protocol.js';

const onWindows = process.platform === 'win32';
const shellperScript = fileURLToPath(new URL('../../../dist/terminal/shellper-main.js', import.meta.url));
const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-pipe-'));
const killers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const kill of killers) {
    await kill().catch(() => {});
  }
  // Best effort: killing a shellper does not yet take its PTY tree with it on
  // Windows (Phase 3's tree teardown), so a lingering child can hold a log open.
  try {
    fs.rmSync(socketDir, { recursive: true, force: true });
  } catch {
    // Left for the runner's temp cleanup
  }
});

function makeManager(): SessionManager {
  return new SessionManager({ socketDir, shellperScript, nodeExecutable: process.execPath });
}

function collectOutput(client: IShellperClient): { text: () => string } {
  const chunks: Buffer[] = [];
  client.on('data', (buf: Buffer) => chunks.push(buf));
  return { text: () => Buffer.concat(chunks).toString('utf-8') };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startCmdSession(manager: SessionManager, marker: string): Promise<{ sessionId: string; client: IShellperClient }> {
  const sessionId = crypto.randomUUID();
  const client = await manager.createSession({
    sessionId,
    command: 'cmd.exe',
    args: ['/d', '/q', '/k', `echo ${marker}`],
    cwd: os.homedir(),
    env: process.env as Record<string, string>,
    cols: 80,
    rows: 24,
  });
  killers.push(() => manager.killSession(sessionId));
  return { sessionId, client };
}

describe.skipIf(!onWindows)('shellper over a real named pipe (Windows)', () => {
  it('a fresh SessionManager reconnects, with replay, after the first is discarded', async () => {
    const first = makeManager();
    const { sessionId, client } = await startCmdSession(first, 'MARK-1658-A');
    const output = collectOutput(client);
    const replay = await client.waitForReplay();
    await waitFor(() => (replay.toString('utf-8') + output.text()).includes('MARK-1658-A'), 15_000);

    const info = first.getSessionInfo(sessionId)!;
    expect(isPipeEndpoint(info.socketPath)).toBe(true);
    expect(info.secret).toMatch(/^[0-9a-f]{64}$/);

    // Discard the first manager without killing the shellper (a Tower stop).
    first.shutdown();

    const second = makeManager();
    const result = await second.reconnectSession('term-1658', info.socketPath, info.pid, info.startTime, undefined, {
      shellperSessionId: info.shellperSessionId,
      secret: info.secret,
    });
    expect(result).not.toBeNull();
    expect(isIdentityRefused(result)).toBe(false);
    const reconnected = result as IShellperClient;
    killers.push(() => second.killSession('term-1658'));
    const replayed = await reconnected.waitForReplay();
    expect(replayed.toString('utf-8')).toContain('MARK-1658-A');

    // Input still works over the new connection.
    const after = collectOutput(reconnected);
    reconnected.write('echo MARK-1658-B\r');
    await waitFor(() => after.text().includes('MARK-1658-B'), 15_000);
  }, 60_000);

  it('a reconnect expecting another session is identity-refused', async () => {
    const manager = makeManager();
    const { sessionId } = await startCmdSession(manager, 'MARK-1658-C');
    const info = manager.getSessionInfo(sessionId)!;
    const result = await makeManager().reconnectSession('term-1658-c', info.socketPath, info.pid, info.startTime, undefined, {
      shellperSessionId: 'some-other-session',
      secret: info.secret,
    });
    expect(isIdentityRefused(result)).toBe(true);
  }, 60_000);

  it('a connection without the secret receives zero bytes and is dropped', async () => {
    const manager = makeManager();
    const { sessionId } = await startCmdSession(manager, 'MARK-1658-D');
    const info = manager.getSessionInfo(sessionId)!;

    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(info.socketPath);
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      socket.on('close', () => resolve());
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(encodeData('echo INJECTED-1658\r'));
        socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: 'terminal' }));
      });
    });
    expect(Buffer.concat(received).length).toBe(0);
  }, 60_000);
});

/** Child script run as the second user: open the pipe, send frames, report what came back. */
const SECOND_USER_PROBE = `
const net = require('net');
const frame = (type, json) => {
  const payload = Buffer.from(json);
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
const out = { connected: false, bytes: 0, error: null };
const socket = net.createConnection(process.argv[2]);
socket.on('connect', () => {
  out.connected = true;
  socket.write(frame(0x01, 'echo INJECTED-1658-USER2\\r'));
  socket.write(frame(0x08, JSON.stringify({ version: 1, clientType: 'tower' })));
  socket.write(frame(0x01, 'echo INJECTED-1658-USER2\\r'));
});
socket.on('data', (d) => { out.bytes += d.length; });
socket.on('error', (e) => { out.error = e.code || e.message; });
setTimeout(() => { console.log(JSON.stringify(out)); process.exit(0); }, 2000);
`;

const RUN_AS_USER_PS = `
$ErrorActionPreference = 'Stop'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:PROBE_NODE
$psi.Arguments = '"' + $env:PROBE_SCRIPT + '" "' + $env:PROBE_PIPE + '"'
$psi.UserName = $env:PROBE_USER
$psi.Password = (ConvertTo-SecureString $env:PROBE_PASSWORD -AsPlainText -Force)
$psi.Domain = $env:COMPUTERNAME
$psi.UseShellExecute = $false
$psi.LoadUserProfile = $false
$psi.WorkingDirectory = 'C:\\'
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEnd()
$err = $p.StandardError.ReadToEnd()
$p.WaitForExit()
if ($err) { [Console]::Error.Write($err) }
[Console]::Out.Write($out)
`;

describe.skipIf(!onWindows || !process.env.CI)('scenario 14: a second local user (Windows CI)', () => {
  it('opens the pipe, receives zero bytes, and its frames have no effect', async () => {
    const manager = makeManager();
    const { sessionId, client } = await startCmdSession(manager, 'MARK-1658-E');
    await client.waitForReplay();
    const output = collectOutput(client);
    const info = manager.getSessionInfo(sessionId)!;

    const user = 'codev1658t';
    // At most 14 characters: a longer password makes `net user` stop on an
    // interactive compatibility prompt.
    const password = `Cv1!${crypto.randomBytes(4).toString('hex')}`;
    // A directory the second user can read: the runner's temp dir is private to its owner.
    const probeDir = path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'codev-1658-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    const probeScript = path.join(probeDir, 'probe.cjs');
    fs.writeFileSync(probeScript, SECOND_USER_PROBE);

    execFileSync('net', ['user', user, password, '/add'], { stdio: 'ignore' });
    try {
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RUN_AS_USER_PS], {
        env: {
          ...process.env,
          PROBE_NODE: process.execPath,
          PROBE_SCRIPT: probeScript,
          PROBE_PIPE: info.socketPath,
          PROBE_USER: user,
          PROBE_PASSWORD: password,
        },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      const result = JSON.parse(raw.trim()) as { connected: boolean; bytes: number; error: string | null };
      // Opening may be refused outright by the pipe's default DACL; either way
      // nothing may come back.
      expect(result.bytes).toBe(0);
    } finally {
      execFileSync('net', ['user', user, '/delete'], { stdio: 'ignore' });
      fs.rmSync(probeDir, { recursive: true, force: true });
    }

    // The injected input never reached the PTY (cmd.exe would echo it).
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(output.text()).not.toContain('INJECTED-1658-USER2');
  }, 90_000);
});
