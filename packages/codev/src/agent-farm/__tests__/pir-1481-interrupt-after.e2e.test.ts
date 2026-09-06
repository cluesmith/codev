/**
 * `afx send --interrupt-after <seconds>` end to end (Issue #1481).
 *
 * Everything else in this feature is proved against a fake clock and doubles. This suite exists
 * for the one claim those cannot make: that a REAL PTY, driven by a REAL Tower over HTTP,
 * receives a real `^C` followed by the real message body when the patience budget runs out —
 * and receives nothing at all when a clean prompt arrives in time.
 *
 * Isolation, per the standing constraints: a child Tower on port 14620 (never 4100), its own
 * `CODEV_AGENT_FARM_DIR` and DB, throwaway workspaces under `~/.agent-farm/test-workspaces`,
 * and only harness-owned processes are ever stopped.
 *
 * The recipient is a shellper-backed `stty raw -echo; cat` terminal: it echoes whatever is
 * written to its PTY input straight back into its output ring, so the test can (a) paint the
 * exact composer bytes the render gate classifies and (b) read back the exact bytes a delivery
 * or a force put on the line. Raw mode means `^C` is a byte, not a signal, so it survives to be
 * observed. This is the same pattern `send-integration.e2e.test.ts` uses for the #1265 cycle.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import {
  createIsolatedAgentFarmDir,
  removeIsolatedAgentFarmDir,
} from './helpers/tower-test-utils.js';

/** Unique to this suite — 14600 is send-integration's, 14700 is shellper-cleanup's. */
const PORT = 14620;
const STARTUP_TIMEOUT = 15_000;
const BASE = `http://localhost:${PORT}`;

const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js',
);

// ============================================================================
// Child-Tower lifecycle (harness-owned processes only)
// ============================================================================

let towerProcess: ChildProcess | null = null;
let agentFarmDir: string | null = null;

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((r) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); r(true); });
    socket.on('timeout', () => { socket.destroy(); r(false); });
    socket.on('error', () => r(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port: number, timeoutMs: number, want = true): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await isPortListening(port)) === want) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Start a child Tower against `dir`. Passing an existing dir models a RESTART of the same
 * Tower — same DB, same mailbox rows, new process lifetime — which is exactly the boundary
 * the force's authority is scoped to.
 */
async function startTower(dir: string): Promise<ChildProcess> {
  const proc = spawn('node', [TOWER_SERVER_PATH, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AF_TEST_DB: `test-${PORT}.db`,
      CODEV_AGENT_FARM_DIR: dir,
    },
  });
  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += d.toString()));
  if (!(await waitForPort(PORT, STARTUP_TIMEOUT))) {
    proc.kill();
    throw new Error(`Tower failed to start on ${PORT}. stderr: ${stderr}`);
  }
  return proc;
}

async function stopTower(proc: ChildProcess | null): Promise<void> {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((r) => {
    proc.on('exit', () => r());
    setTimeout(() => { proc.kill('SIGKILL'); r(); }, 2000);
  });
  await waitForPort(PORT, 5000, false);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const encodeWs = (p: string): string => Buffer.from(p).toString('base64url');

// ============================================================================
// Workspace + terminal helpers
// ============================================================================

const testBase = resolve(homedir(), '.agent-farm', 'test-workspaces');

/**
 * A throwaway workspace whose `.builder-start.sh` names `claude`, so the render gate resolves
 * the claude classifier profile for its terminals — a shellper session reports `command: ''`,
 * exactly as a real wrapped builder does, and the profile is recovered from the launch script.
 */
function createTestWorkspace(name: string): string {
  mkdirSync(testBase, { recursive: true });
  const ws = mkdtempSync(resolve(testBase, `${name}-`));
  mkdirSync(resolve(ws, 'codev'), { recursive: true });
  mkdirSync(resolve(ws, '.agent-farm'), { recursive: true });
  mkdirSync(resolve(ws, '.codev'), { recursive: true });
  writeFileSync(
    resolve(ws, '.codev', 'config.json'),
    JSON.stringify({ shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' } }),
  );
  writeFileSync(resolve(ws, '.builder-start.sh'), '#!/bin/bash\nexec claude\n');
  return ws;
}

function cleanupWorkspace(ws: string): void {
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function activateAndWait(ws: string): Promise<void> {
  const encoded = encodeWs(ws);
  let res: Response | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    res = await fetch(`${BASE}/api/workspaces/${encoded}/activate`, { method: 'POST' });
    if (res.ok) break;
    await sleep(500);
  }
  expect(res!.ok).toBe(true);
  for (let i = 0; i < 60; i++) {
    const data = await (await fetch(`${BASE}/api/workspaces`)).json();
    if (data.workspaces.find((w: { path: string }) => w.path === ws)) return;
    await sleep(500);
  }
  throw new Error(`Workspace ${ws} never appeared`);
}

/** A shellper-backed terminal that echoes its PTY input verbatim into its output ring. */
async function registerEchoTerminal(ws: string, roleId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'sh',
      args: ['-c', 'stty raw -echo 2>/dev/null; exec cat'],
      cwd: ws,
      cols: 110,
      rows: 32,
      workspacePath: ws,
      type: 'builder',
      roleId,
      persistent: true,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

async function writeToTerminal(terminalId: string, data: string): Promise<void> {
  const res = await fetch(`${BASE}/api/terminals/${terminalId}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  expect(res.ok).toBe(true);
}

/** Everything the terminal has emitted, as one string — including control bytes. */
async function terminalOutput(terminalId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/terminals/${terminalId}/output?lines=500`);
  expect(res.ok).toBe(true);
  return ((await res.json()).lines as string[]).join('\n');
}

interface SendResult { status: number; body: Record<string, any> }

async function send(
  ws: string,
  to: string,
  message: string,
  options: Record<string, unknown> = {},
): Promise<SendResult> {
  const res = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, message, from: 'architect', workspace: ws, fromWorkspace: ws, options }),
  });
  return { status: res.status, body: await res.json() };
}

async function inboxShow(id: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${BASE}/api/inbox/${id}`);
  if (!res.ok) return null;
  return res.json();
}

// ---- Composer screens the real render gate classifies (claude profile) ----

const ESC = '\x1b';
const CTRL_C = '\x03';
const COMPOSER_RULE = '─'.repeat(22);
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
/** A half-typed draft at normal intensity → gate: busy. */
const DRAFT_COMPOSER = `${CLEAR_SCREEN}❯ ${ESC}[0mdeploy the hotfix to prod\r\n${COMPOSER_RULE}\r\n`;
/** Marker + dim placeholder only → gate: clean. */
const CLEAN_COMPOSER = `${CLEAR_SCREEN}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${COMPOSER_RULE}\r\n`;

/** Poll `predicate` until it holds or the deadline passes. Returns whether it held. */
async function until(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(250);
  }
  return false;
}

// ============================================================================
// Tests
// ============================================================================

describe('afx send --interrupt-after, end to end (Issue #1481)', () => {
  let ws: string;

  beforeAll(async () => {
    agentFarmDir = createIsolatedAgentFarmDir();
    towerProcess = await startTower(agentFarmDir);
    ws = createTestWorkspace('pir-1481');
    await activateAndWait(ws);
  }, 120_000);

  afterAll(async () => {
    if (ws) {
      await fetch(`${BASE}/api/workspaces/${encodeWs(ws)}/deactivate`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
      cleanupWorkspace(ws);
    }
    await stopTower(towerProcess);
    towerProcess = null;
    if (agentFarmDir) removeIsolatedAgentFarmDir(agentFarmDir);
    agentFarmDir = null;
  }, 120_000);

  it('does NOT interrupt when a clean prompt arrives before the deadline', async () => {
    const agent = 'builder-pir-1481-clean';
    const term = await registerEchoTerminal(ws, agent);

    await writeToTerminal(term, DRAFT_COMPOSER);
    await sleep(400);

    const { body } = await send(ws, agent, 'clean-path-message', { interruptAfter: 6 });
    expect(body.held).toBe(true);
    expect(body.reason).toBe('busy');
    expect(typeof body.interruptAt).toBe('number');

    // The user submits well inside the budget: the gate opens and the ORDINARY path delivers.
    await sleep(500);
    await writeToTerminal(term, CLEAN_COMPOSER);

    const delivered = await until(
      async () => (await inboxShow(body.mailboxId))?.status === 'delivered',
      12_000,
    );
    expect(delivered).toBe(true);

    // Now sit past the deadline. The force must not fire for a row that is already terminal.
    const before = await terminalOutput(term);
    const ctrlCsBefore = before.split(CTRL_C).length - 1;
    await sleep(7_000);
    const after = await terminalOutput(term);

    expect(after.split(CTRL_C).length - 1).toBe(ctrlCsBefore); // no ^C, ever
    expect(after.split('clean-path-message').length - 1).toBe(
      before.split('clean-path-message').length - 1,
    ); // and exactly one body — no second copy from a late force
    const row = await inboxShow(body.mailboxId);
    expect(row?.status).toBe('delivered');
    // The clean prompt won at the claim edge, so the force was never claimed.
    expect(row?.interruptClaimedAt ?? null).toBeNull();
  }, 90_000);

  it('forces ^C + the ungated body onto a prompt that is STILL busy at the deadline', async () => {
    const agent = 'builder-pir-1481-forced';
    const term = await registerEchoTerminal(ws, agent);

    // A draft that never clears — the operator's message would otherwise wait forever.
    await writeToTerminal(term, DRAFT_COMPOSER);
    await sleep(400);
    const beforeSend = await terminalOutput(term);
    expect(beforeSend).not.toContain('forced-path-message');

    const { body } = await send(ws, agent, 'forced-path-message', { interruptAfter: 3 });
    expect(body.held).toBe(true);
    expect(typeof body.interruptAt).toBe('number');

    // Nothing may reach the line before the deadline: this is a gated send until then.
    await sleep(1_000);
    const midWindow = await terminalOutput(term);
    expect(midWindow).not.toContain('forced-path-message');
    expect(midWindow.split(CTRL_C).length - 1).toBe(beforeSend.split(CTRL_C).length - 1);

    // Past the deadline the escalation lands, on a screen the gate still calls busy.
    const landed = await until(
      async () => (await terminalOutput(term)).includes('forced-path-message'),
      20_000,
    );
    expect(landed).toBe(true);

    const out = await terminalOutput(term);
    const ctrlCs = out.split(CTRL_C).length - 1;
    expect(ctrlCs).toBe(beforeSend.split(CTRL_C).length - 1 + 1); // exactly one ^C
    // Order matters: the interrupt precedes the body it made room for.
    expect(out.lastIndexOf(CTRL_C)).toBeLessThan(out.indexOf('forced-path-message'));
    expect(out.split('forced-path-message').length - 1).toBe(1); // and exactly one body

    const row = await inboxShow(body.mailboxId);
    expect(row?.status).toBe('delivered');
    expect(typeof row?.interruptClaimedAt).toBe('number');
    // Audit, never receipt: the row says the force was claimed and the writer finished, and
    // says nothing about the agent having read anything.
    expect(['claimed', 'claimed-degraded', 'written-unverified', 'degraded-written-unverified'])
      .toContain(row?.interruptOutcome);
  }, 90_000);

  it('keeps every unrelated flag and rejects the combinations that have no reading', async () => {
    const agent = 'builder-pir-1481-flags';
    await registerEchoTerminal(ws, agent);

    // Validation, over the real HTTP boundary.
    for (const [value, fragment] of [
      [0, 'greater than zero'],
      [-1, 'greater than zero'],
      ['30', 'finite number'],
      [3601, 'at most 3600 seconds'],
    ] as Array<[unknown, string]>) {
      const { status, body } = await send(ws, agent, 'bad', { interruptAfter: value });
      expect(status).toBe(400);
      expect(body.error).toBe('INVALID_PARAMS');
      expect(String(body.message)).toContain(fragment);
    }

    // The three refused combinations.
    const withInterrupt = await send(ws, agent, 'x', { interrupt: true, interruptAfter: 5 });
    expect(withInterrupt.status).toBe(400);
    expect(String(withInterrupt.body.message)).toContain('cannot be combined with interrupt');

    const withEscape = await send(ws, agent, ESC, { escape: true, interruptAfter: 5 });
    expect(withEscape.status).toBe(400);
    expect(String(withEscape.body.message)).toContain('cannot be combined with escape');

    const withDelay = await send(ws, agent, 'x', { deliverAfter: 30, interruptAfter: 5 });
    expect(withDelay.status).toBe(400);
    expect(String(withDelay.body.message)).toContain('cannot be combined with a delay');

    // And an ordinary send is completely unchanged by the feature's presence.
    const plain = await send(ws, agent, 'ordinary send, no force');
    expect(plain.status).toBe(200);
    expect(plain.body.held).toBe(true);
    expect(plain.body).not.toHaveProperty('interruptAt');
    const row = await inboxShow(plain.body.mailboxId);
    expect(row?.interruptAt ?? null).toBeNull();
    expect(row?.interruptOutcome ?? null).toBeNull();
  }, 90_000);

  it('disarms an unfired force across a Tower restart, keeping the message as ordinary held mail', async () => {
    // The lifecycle boundary the plan chose: force authority belongs to the Tower lifetime that
    // accepted it. A restart must not resurrect a deadline and interrupt an unrelated later turn.
    const agent = 'builder-pir-1481-restart';
    const term = await registerEchoTerminal(ws, agent);
    await writeToTerminal(term, DRAFT_COMPOSER);
    await sleep(400);

    // A long budget, so the restart lands while the force is still armed and NOT yet due.
    const { body } = await send(ws, agent, 'restart-path-message', { interruptAfter: 600 });
    expect(body.held).toBe(true);
    expect(typeof body.interruptAt).toBe('number');
    expect((await inboxShow(body.mailboxId))?.interruptOutcome).toBe('armed');

    await stopTower(towerProcess);
    towerProcess = await startTower(agentFarmDir!);
    await activateAndWait(ws);

    const row = await inboxShow(body.mailboxId);
    expect(row?.status).toBe('held');                    // the MESSAGE survived...
    expect(row?.interruptOutcome).toBe('skipped-restart'); // ...the FORCE did not
    expect(row?.interruptAt).toBe(body.interruptAt);      // the deadline is kept as audit
    expect(row?.interruptClaimedAt ?? null).toBeNull();

    // And the disarmed row still delivers the ordinary way once the prompt clears.
    const term2 = await registerEchoTerminal(ws, agent);
    await writeToTerminal(term2, CLEAN_COMPOSER);
    const delivered = await until(
      async () => (await inboxShow(body.mailboxId))?.status === 'delivered',
      20_000,
    );
    expect(delivered).toBe(true);
    const out = await terminalOutput(term2);
    expect(out).toContain('restart-path-message');
    expect(out).not.toContain(CTRL_C); // delivered through the gate, never forced
  }, 120_000);
});
