/**
 * Integration tests for POST /api/send → /ws/messages flow.
 * Spec 0110: Messaging Infrastructure — Phase 4
 *
 * Verifies that POST /api/send results in /ws/messages broadcast
 * with correct from.project, to.project, and message content.
 * Tests include single-workspace sends, tail match resolution,
 * project-filtered subscriptions, and cross-project messaging.
 *
 * Uses a real Tower server (spawned as child process) with
 * workspaces activated and builder terminals registered via API.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import WebSocket from 'ws';
import { towerWsProtocols } from './helpers/tower-test-utils.js';

// Use a unique port to avoid conflicts with other e2e test suites
// Port 14500 is used by cli-tower-mode.e2e.test.ts — use 14600 here
const TEST_TOWER_PORT = 14600;
const STARTUP_TIMEOUT = 15_000;

const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js'
);

let towerProcess: ChildProcess | null = null;

// ============================================================================
// Server lifecycle helpers (same pattern as tower-api.e2e.test.ts)
// ============================================================================

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((r) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); r(true); });
    socket.on('timeout', () => { socket.destroy(); r(false); });
    socket.on('error', () => { r(false); });
    socket.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function startTower(port: number): Promise<ChildProcess> {
  const proc = spawn('node', [TOWER_SERVER_PATH, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, NODE_ENV: 'test', AF_TEST_DB: `test-${port}.db` },
  });

  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += d.toString()));

  const started = await waitForPort(port, STARTUP_TIMEOUT);
  if (!started) {
    proc.kill();
    throw new Error(`Tower failed to start on port ${port}. stderr: ${stderr}`);
  }

  return proc;
}

async function stopServer(proc: ChildProcess | null): Promise<void> {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((r) => {
    proc.on('exit', () => r());
    setTimeout(() => { proc.kill('SIGKILL'); r(); }, 2000);
  });
}

function encodeWorkspacePath(workspacePath: string): string {
  return Buffer.from(workspacePath).toString('base64url');
}

// ============================================================================
// Workspace helpers
// ============================================================================

const testBase = resolve(homedir(), '.agent-farm', 'test-workspaces');

function createTestWorkspace(name: string): string {
  mkdirSync(testBase, { recursive: true });
  const workspacePath = mkdtempSync(resolve(testBase, `${name}-`));
  mkdirSync(resolve(workspacePath, 'codev'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.agent-farm'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.codev'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, '.codev', 'config.json'),
    JSON.stringify({ shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' } })
  );
  return workspacePath;
}

function cleanupWorkspace(workspacePath: string): void {
  try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Activate a workspace and wait for it to appear in the workspace list.
 * Does NOT wait for terminals — we register those explicitly via POST /api/terminals.
 */
async function activateAndWait(port: number, workspacePath: string): Promise<void> {
  const encoded = encodeWorkspacePath(workspacePath);

  // Retry activation — the server may be listening on the port before
  // initInstances() completes, returning 400 "Tower is still starting up".
  let res: Response | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    res = await fetch(`http://localhost:${port}/api/workspaces/${encoded}/activate`, {
      method: 'POST',
    });
    if (res.ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(res!.ok).toBe(true);

  // Wait for workspace entry to appear (activation is async)
  for (let i = 0; i < 60; i++) {
    const listRes = await fetch(`http://localhost:${port}/api/workspaces`);
    const data = await listRes.json();
    const ws = data.workspaces.find((w: { path: string }) => w.path === workspacePath);
    if (ws) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Workspace ${workspacePath} never appeared in workspace list`);
}

/**
 * Register a builder terminal in a workspace via POST /api/terminals.
 */
async function registerTerminal(
  port: number,
  workspacePath: string,
  type: string,
  roleId: string,
): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Spec 1313: an inert shell renders no agent composer, so the render-gate
      // (correctly) HOLDS a normal send to it. These routing tests therefore use
      // the explicit `interrupt` delivery path (gate-bypass, broadcasts as before);
      // the shell traps SIGINT and re-loops so it survives the Ctrl+C and stays
      // registered across sends. Gated deliver/hold is covered by
      // send-mailbox-repro.test.ts and tower-routes.test.ts.
      command: '/bin/sh',
      args: ['-c', 'trap "" INT; while true; do sleep 3600; done'],
      cwd: workspacePath,
      cols: 80,
      rows: 24,
      workspacePath,
      type,
      roleId,
      // Register via the shellper (persistent) backend — the same path Tower
      // uses for real builders/architects. The non-persistent fallback spawns
      // node-pty directly via `await import('node-pty')`, which resolves the
      // module's live named bindings to `undefined` inside Tower's deep ESM
      // graph when run from the built `dist/` (a pre-existing Node ESM↔CJS
      // interop quirk in `terminal/pty-session.ts`, unrelated to Spec 1313 —
      // `terminal/shellper-main.ts` already works around it with createRequire).
      // Shellper spawns in its own process, so it is immune. A shellper-backed
      // session reports `command: ''` (see pty-manager.createSessionRaw), which
      // still resolves to `no-profile` for the held-behavior assertion below.
      persistent: true,
    }),
  });
  expect(res.status).toBe(201);
  const data = await res.json();
  return data.id;
}

// ---- Spec 1313: composer-rendering helpers for the #1265 full-cycle e2e ----

const ESC = '\x1b';
const COMPOSER_RULE = '─'.repeat(22);
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
/** An OCCUPIED claude composer: a half-typed draft at normal intensity → gate: busy. */
const DRAFT_COMPOSER = `${CLEAR_SCREEN}❯ ${ESC}[0mdeploy the hotfix to prod\r\n${COMPOSER_RULE}\r\n`;
/** A CLEAN claude composer: marker + a dim placeholder only → gate: clean. */
const CLEAN_COMPOSER = `${CLEAR_SCREEN}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${COMPOSER_RULE}\r\n`;

/**
 * Register a shellper-backed "echo" terminal: `stty raw -echo; cat` re-emits
 * whatever we write to its PTY input verbatim into its output ring buffer, so the
 * test can render the exact composer bytes the real render-gate classifies (the
 * same screens send-mailbox-repro.test.ts proves against the gate in-process).
 * Persistent backend (see registerTerminal) → immune to the node-pty ESM quirk.
 */
async function registerEchoTerminal(port: number, workspacePath: string, roleId: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'sh',
      args: ['-c', 'stty raw -echo 2>/dev/null; exec cat'],
      cwd: workspacePath,
      cols: 110,
      rows: 32,
      workspacePath,
      type: 'builder',
      roleId,
      persistent: true,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

/** Write raw bytes to a terminal's PTY input (POST /api/terminals/:id/write). */
async function writeToTerminal(port: number, terminalId: string, data: string): Promise<void> {
  const res = await fetch(`http://localhost:${port}/api/terminals/${terminalId}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  expect(res.ok).toBe(true);
}

/**
 * Connect to the /ws/messages WebSocket and return a promise-based helper
 * for waiting on the next message.
 */
function connectMessageBus(
  port: number,
  projectFilter?: string,
): { ws: WebSocket; nextMessage: () => Promise<any>; close: () => void } {
  const url = projectFilter
    ? `ws://localhost:${port}/ws/messages?project=${encodeURIComponent(projectFilter)}`
    : `ws://localhost:${port}/ws/messages`;

  const ws = new WebSocket(url, towerWsProtocols());
  const messageQueue: any[] = [];
  let waitingResolve: ((msg: any) => void) | null = null;

  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve(parsed);
    } else {
      messageQueue.push(parsed);
    }
  });

  function nextMessage(): Promise<any> {
    if (messageQueue.length > 0) {
      return Promise.resolve(messageQueue.shift());
    }
    return new Promise((resolve, reject) => {
      waitingResolve = resolve;
      setTimeout(() => {
        waitingResolve = null;
        reject(new Error('Timed out waiting for WebSocket message (5s)'));
      }, 5000);
    });
  }

  function close() {
    ws.close();
  }

  return { ws, nextMessage, close };
}

/**
 * Wait for a WebSocket to reach OPEN state.
 */
function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
    setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
  });
}

// ============================================================================
// Tests — single Tower instance for all tests
// ============================================================================

describe('send integration (POST /api/send → /ws/messages)', () => {
  let workspaceA: string;
  let workspaceB: string;

  beforeAll(async () => {
    towerProcess = await startTower(TEST_TOWER_PORT);

    // Create and activate two workspaces
    workspaceA = createTestWorkspace('send-int-a');
    workspaceB = createTestWorkspace('send-int-b');
    await activateAndWait(TEST_TOWER_PORT, workspaceA);
    await activateAndWait(TEST_TOWER_PORT, workspaceB);

    // Register builder terminals explicitly (reliable, no waiting for auto-spawn)
    await registerTerminal(TEST_TOWER_PORT, workspaceA, 'builder', 'builder-spir-109');
    await registerTerminal(TEST_TOWER_PORT, workspaceA, 'builder', 'builder-bugfix-42');
    await registerTerminal(TEST_TOWER_PORT, workspaceB, 'builder', 'builder-spir-200');
  }, 120_000);

  afterAll(async () => {
    // Guard against setup failure — variables may be undefined
    if (workspaceA) {
      const encA = encodeWorkspacePath(workspaceA);
      await fetch(`http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encA}/deactivate`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
      cleanupWorkspace(workspaceA);
    }
    if (workspaceB) {
      const encB = encodeWorkspacePath(workspaceB);
      await fetch(`http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encB}/deactivate`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
      cleanupWorkspace(workspaceB);
    }

    await stopServer(towerProcess);
    towerProcess = null;
    // Clean up test database
    const dbBase = resolve(homedir(), '.agent-farm', `test-${TEST_TOWER_PORT}`);
    try { rmSync(`${dbBase}.db`, { force: true }); } catch { /* ignore */ }
    try { rmSync(`${dbBase}.db-wal`, { force: true }); } catch { /* ignore */ }
    try { rmSync(`${dbBase}.db-shm`, { force: true }); } catch { /* ignore */ }
    // 120s to match beforeAll — the old explicit 10s override was tighter than
    // the two deactivate calls + stopServer's SIGTERM wait can guarantee on a
    // loaded CI runner, and a slow teardown failed the whole green suite.
  }, 120_000);

  // ---- Single-workspace send tests ----

  it('sends to builder via POST /api/send and receives broadcast on /ws/messages', async () => {
    const bus = connectMessageBus(TEST_TOWER_PORT);
    await waitForOpen(bus.ws);

    const sendRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'builder-spir-109',
        message: 'Hello from integration test',
        from: 'architect',
        workspace: workspaceA,
        fromWorkspace: workspaceA,
        options: { interrupt: true }, // Spec 1313: explicit-delivery path (see registerTerminal)
      }),
    });
    expect(sendRes.ok).toBe(true);
    const sendData = await sendRes.json();
    expect(sendData.ok).toBe(true);
    expect(sendData.resolvedTo).toBe('builder-spir-109');

    // Verify the broadcast message on WebSocket
    const frame = await bus.nextMessage();
    expect(frame.type).toBe('message');
    expect(frame.from.agent).toBe('architect');
    expect(frame.to.agent).toBe('builder-spir-109');
    expect(frame.content).toBe('Hello from integration test');
    expect(frame.metadata.source).toBe('api');

    bus.close();
  });

  it('resolves bare numeric ID (tail match) and broadcasts resolved agent name', async () => {
    const bus = connectMessageBus(TEST_TOWER_PORT);
    await waitForOpen(bus.ws);

    const sendRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: '109',
        message: 'Tail match test',
        from: 'architect',
        workspace: workspaceA,
        fromWorkspace: workspaceA,
        options: { interrupt: true }, // Spec 1313: explicit-delivery path (see registerTerminal)
      }),
    });
    expect(sendRes.ok).toBe(true);
    const sendData = await sendRes.json();
    expect(sendData.resolvedTo).toBe('builder-spir-109');

    const frame = await bus.nextMessage();
    expect(frame.to.agent).toBe('builder-spir-109');
    expect(frame.content).toBe('Tail match test');

    bus.close();
  });

  it('project-filtered subscriber receives only matching messages', async () => {
    const projectAName = workspaceA.split('/').pop()!;
    const busMatching = connectMessageBus(TEST_TOWER_PORT, projectAName);
    const busNonMatching = connectMessageBus(TEST_TOWER_PORT, 'nonexistent-project');
    await Promise.all([waitForOpen(busMatching.ws), waitForOpen(busNonMatching.ws)]);

    await fetch(`http://localhost:${TEST_TOWER_PORT}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'builder-spir-109',
        message: 'Filter test',
        from: 'architect',
        workspace: workspaceA,
        fromWorkspace: workspaceA,
        options: { interrupt: true }, // Spec 1313: explicit-delivery path (see registerTerminal)
      }),
    });

    // Matching filter should receive
    const frame = await busMatching.nextMessage();
    expect(frame.content).toBe('Filter test');
    expect(frame.from.project).toBe(projectAName);

    // Non-matching filter should NOT receive (wait 1s to confirm)
    const noMessage = await Promise.race([
      busNonMatching.nextMessage().then(() => false),
      new Promise<true>((r) => setTimeout(() => r(true), 1000)),
    ]);
    expect(noMessage).toBe(true);

    busMatching.close();
    busNonMatching.close();
  });

  // ---- Cross-project send tests ----

  it('cross-project send: broadcasts correct from.project and to.project', async () => {
    const projectAName = workspaceA.split('/').pop()!;
    const projectBName = workspaceB.split('/').pop()!;

    const bus = connectMessageBus(TEST_TOWER_PORT);
    await waitForOpen(bus.ws);

    // Send from workspace A to workspaceB:builder-spir-200
    const sendRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: `${projectBName}:builder-spir-200`,
        message: 'Cross-project hello',
        from: 'architect',
        workspace: workspaceA,
        fromWorkspace: workspaceA,
        options: { interrupt: true }, // Spec 1313: explicit-delivery path (see registerTerminal)
      }),
    });
    expect(sendRes.ok).toBe(true);
    const sendData = await sendRes.json();
    expect(sendData.ok).toBe(true);
    expect(sendData.resolvedTo).toBe('builder-spir-200');

    // Verify broadcast provenance
    const frame = await bus.nextMessage();
    expect(frame.type).toBe('message');

    // (b) from.project is workspace A's name (the sender's project)
    expect(frame.from.project).toBe(projectAName);
    expect(frame.from.agent).toBe('architect');

    // (c) to.project is workspace B's name (the target's project)
    expect(frame.to.project).toBe(projectBName);
    expect(frame.to.agent).toBe('builder-spir-200');

    expect(frame.content).toBe('Cross-project hello');

    bus.close();
  });

  it('cross-project: filtered subscriber for target project receives the message', async () => {
    const projectBName = workspaceB.split('/').pop()!;

    // Subscribe filtered to project B
    const busProjB = connectMessageBus(TEST_TOWER_PORT, projectBName);
    await waitForOpen(busProjB.ws);

    // Send from A → B:builder-spir-200
    await fetch(`http://localhost:${TEST_TOWER_PORT}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: `${projectBName}:builder-spir-200`,
        message: 'Filtered cross-project',
        from: 'builder-spir-42',
        workspace: workspaceA,
        fromWorkspace: workspaceA,
        options: { interrupt: true }, // Spec 1313: explicit-delivery path (see registerTerminal)
      }),
    });

    // Project B subscriber should receive it (to.project matches)
    const frame = await busProjB.nextMessage();
    expect(frame.to.project).toBe(projectBName);
    expect(frame.from.agent).toBe('builder-spir-42');
    expect(frame.content).toBe('Filtered cross-project');

    busProjB.close();
  });

  // ---- Spec 1313: mailbox-first hold behavior (HTTP contract) ----

  it('holds a NORMAL (gated) send to an inert terminal instead of writing to it (Spec 1313)', async () => {
    // No `interrupt` here: the render-gate sees a shell with no agent composer and
    // holds the message rather than corrupting the line. The send is persisted and
    // the response reports the real first outcome — held, with a why-held reason.
    const sendRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'builder-spir-109',
        message: 'this should be held, not written',
        from: 'architect',
        workspace: workspaceA,
        fromWorkspace: workspaceA,
      }),
    });
    expect(sendRes.ok).toBe(true);
    const data = await sendRes.json();
    expect(data.ok).toBe(true);
    expect(data.held).toBe(true);
    expect(data.resolvedTo).toBe('builder-spir-109');
    expect(typeof data.mailboxId).toBe('string');
    // An inert shell resolves to no measured agent profile → held `no-profile`.
    expect(data.reason).toBe('no-profile');
  });

  // ---- Spec 1313: the #1265 corruption repro, end-to-end over HTTP ----

  it('#1265 full cycle: a draft holds the send (busy), then it delivers cleanly once the composer clears', async () => {
    // A dedicated workspace whose `.builder-start.sh` names `claude`, so the
    // render-gate resolves the claude profile for this terminal (a shellper session
    // reports command='', so the profile is recovered from the launch script exactly
    // as it is for a real wrapped builder). Torn down in `finally`.
    const ws = createTestWorkspace('send-int-repro');
    writeFileSync(resolve(ws, '.builder-start.sh'), '#!/bin/bash\nexec claude\n');
    try {
      await activateAndWait(TEST_TOWER_PORT, ws);
      const termId = await registerEchoTerminal(TEST_TOWER_PORT, ws, 'builder-spir-777');

      // 1. Render an OCCUPIED composer (a half-typed draft at normal intensity).
      await writeToTerminal(TEST_TOWER_PORT, termId, DRAFT_COMPOSER);
      await new Promise((r) => setTimeout(r, 300)); // let it render into the ring buffer

      // Subscribe BEFORE sending so we catch the eventual redelivery broadcast.
      const bus = connectMessageBus(TEST_TOWER_PORT);
      await waitForOpen(bus.ws);

      // 2. A NORMAL (gated) send lands on the busy line → HELD (busy). The draft is
      //    never written to, and a held send broadcasts nothing (only delivery does).
      const sendRes = await fetch(`http://localhost:${TEST_TOWER_PORT}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: 'builder-spir-777',
          message: 'ship it',
          from: 'architect',
          workspace: ws,
          fromWorkspace: ws,
        }),
      });
      expect(sendRes.ok).toBe(true);
      const sendData = await sendRes.json();
      expect(sendData.held).toBe(true);
      expect(sendData.reason).toBe('busy');
      expect(typeof sendData.mailboxId).toBe('string');

      // 3. The user submits: the composer renders clean (dim placeholder only).
      await writeToTerminal(TEST_TOWER_PORT, termId, CLEAN_COMPOSER);

      // 4. The backstop redelivers on the first clean render-gate → delivery
      //    broadcast. Held sends never broadcast, so the mailbox-sourced message
      //    frame is unambiguously the redelivery of exactly this held message.
      let delivered: { content?: string } | null = null;
      const deadline = Date.now() + 12_000;
      while (!delivered && Date.now() < deadline) {
        try {
          const frame = await bus.nextMessage();
          if (frame.type === 'message' && frame.to?.agent === 'builder-spir-777' && frame.metadata?.source === 'mailbox') {
            delivered = frame;
          }
        } catch {
          /* nextMessage's internal 5s timeout — loop again until our own deadline */
        }
      }
      expect(delivered).not.toBeNull();
      expect(delivered!.content).toBe('ship it');

      bus.close();
    } finally {
      const encWs = encodeWorkspacePath(ws);
      await fetch(`http://localhost:${TEST_TOWER_PORT}/api/workspaces/${encWs}/deactivate`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
      cleanupWorkspace(ws);
    }
  }, 60_000);
});
