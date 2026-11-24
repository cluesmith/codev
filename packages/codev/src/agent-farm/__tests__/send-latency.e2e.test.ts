/**
 * Send latency measurement (Spec 1940, stage 1 non-functional scenario).
 *
 * The spec's bound: "Stage 1 does not slow a same-workspace send. Measured as the median
 * of 100 sends to a recipient whose mail is held, so that no terminal write is timed, on
 * the commit before stage 1 and on stage 1: the second is within 5%, or 1 ms, of the
 * first, whichever is larger."
 *
 * This file is a MEASUREMENT, not a regression test, so it is opt-in:
 *
 *   pnpm build
 *   CODEV_SEND_LATENCY=1 pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/send-latency.e2e.test.ts --reporter=verbose
 *
 * It prints one `SEND_LATENCY …` line per scenario (the verbose reporter is what shows it
 * when output is piped). A single run on a busy machine can read twice the quiet figure,
 * so take several and use the median of their medians. To compare against a baseline taken
 * earlier on the same machine, pass that median and the bound is asserted:
 *
 *   CODEV_SEND_LATENCY=1 CODEV_SEND_LATENCY_BASELINE_MS=2.2 pnpm exec vitest run …
 *
 * The same-workspace scenario drives only `POST /api/send` with fields that exist before
 * Spec 1940, so the file runs unchanged on the pre-stage-1 commit and on the finished
 * branch. That is what makes the two numbers comparable.
 *
 * Each timed send is to an inert builder terminal, which the render gate holds
 * (`no-profile`): the message is resolved, formatted and persisted, and nothing is typed.
 * The held row is dismissed after each sample, outside the timed region, so every sample
 * does the same work and the pile of held mail does not grow under the measurement.
 *
 * A second scenario times the same number of sends to a named architect in ANOTHER
 * workspace (`<workspace>:architect:<name>`), also held. The spec sets no bound for it; the
 * figure is for the record, so that the cost of the name lookup is known and not assumed.
 * Its workspace is started only after the same-workspace scenario has been measured, so
 * that scenario still runs under the conditions its baseline was taken in.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startTower,
  createTestWorkspace,
  cleanupTestWorkspace,
  encodeWorkspacePath,
  pidsNamingSocketDir,
  type TowerHandle,
} from './helpers/tower-test-utils.js';

const ENABLED = process.env.CODEV_SEND_LATENCY === '1';
const SAMPLES = 100;
const WARMUP = 15;

/** The spec's bound: within 5% of the baseline, or 1 ms, whichever is larger. */
function withinBound(baselineMs: number, measuredMs: number): boolean {
  return measuredMs <= Math.max(baselineMs * 1.05, baselineMs + 1);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function summarize(samples: number[]): { median: number; p90: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: median(sorted),
    p90: sorted[Math.floor(sorted.length * 0.9)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function activate(port: number, workspacePath: string): Promise<void> {
  const encoded = encodeWorkspacePath(workspacePath);
  let res: Response | null = null;
  // The port can accept connections before Tower's instances are initialised.
  for (let attempt = 0; attempt < 30; attempt++) {
    res = await fetch(`http://localhost:${port}/api/workspaces/${encoded}/activate`, { method: 'POST' });
    if (res.ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`workspace ${workspacePath} did not activate: ${res?.status}`);
}

/** An inert, shellper-backed builder terminal: no agent composer, so the gate holds its mail. */
async function registerInertBuilder(port: number, workspacePath: string, roleId: string): Promise<void> {
  const res = await fetch(`http://localhost:${port}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: '/bin/sh',
      args: ['-c', 'trap "" INT; while true; do sleep 3600; done'],
      cwd: workspacePath,
      cols: 80,
      rows: 24,
      workspacePath,
      type: 'builder',
      roleId,
      persistent: true,
    }),
  });
  if (res.status !== 201) throw new Error(`terminal registration failed: ${res.status} ${await res.text()}`);
}

interface SendBody {
  to: string;
  message: string;
  from: string;
  workspace: string;
  fromWorkspace: string;
}

/**
 * Time one send, then dismiss the row it left held. Returns the elapsed milliseconds of
 * the send alone. Throws if the message was not held: a delivered sample would have
 * timed a terminal write, which is exactly what this measurement excludes.
 */
async function timedHeldSend(port: number, body: SendBody): Promise<number> {
  const payload = JSON.stringify(body);
  const start = performance.now();
  const res = await fetch(`http://localhost:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  const data = await res.json();
  const elapsed = performance.now() - start;
  if (!res.ok || data.held !== true || typeof data.mailboxId !== 'string') {
    throw new Error(`expected a held send, got ${res.status} ${JSON.stringify(data)}`);
  }
  const dismissed = await fetch(`http://localhost:${port}/api/inbox/${encodeURIComponent(data.mailboxId)}/dismiss`, {
    method: 'POST',
  });
  if (!dismissed.ok) throw new Error(`dismiss failed: ${dismissed.status}`);
  return elapsed;
}

async function measure(port: number, body: SendBody): Promise<ReturnType<typeof summarize>> {
  for (let i = 0; i < WARMUP; i++) await timedHeldSend(port, body);
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await timedHeldSend(port, body));
  return summarize(samples);
}

function report(label: string, s: ReturnType<typeof summarize>): void {
  const f = (n: number) => n.toFixed(3);
  // One greppable line. This is the number that goes in the thread log and the review.
  console.log(
    `SEND_LATENCY ${label} n=${SAMPLES} median=${f(s.median)}ms p90=${f(s.p90)}ms min=${f(s.min)}ms max=${f(s.max)}ms`,
  );
}

/**
 * A second workspace, `<root>/latency-other`, whose architects are inert: the program is
 * one executable file, because a workspace's architect command is split on whitespace and
 * given further arguments by Tower.
 */
function createWorkspaceWithInertArchitects(root: string): string {
  const agent = join(root, 'inert-agent.sh');
  writeFileSync(agent, '#!/bin/sh\ntrap "" INT; while true; do sleep 3600; done\n', { mode: 0o755 });
  const workspacePath = join(root, 'latency-other');
  mkdirSync(join(workspacePath, 'codev'), { recursive: true });
  mkdirSync(join(workspacePath, '.agent-farm'), { recursive: true });
  mkdirSync(join(workspacePath, '.codev'), { recursive: true });
  writeFileSync(
    join(workspacePath, '.codev', 'config.json'),
    JSON.stringify({ shell: { architect: agent, builder: 'bash', shell: 'bash' } }),
  );
  return workspacePath;
}

describe.skipIf(!ENABLED)('send latency (Spec 1940, opt-in measurement)', () => {
  let tower: TowerHandle;
  let workspace: string;
  let otherRoot: string | undefined;
  let otherWorkspace: string | undefined;
  const BUILDER = 'builder-spir-9001';

  beforeAll(async () => {
    tower = await startTower();
    // The temp dir is behind a symlink on macOS (/var → /private/var); Tower lists the
    // workspace by its real path, and the sends below must name the same one.
    workspace = realpathSync(createTestWorkspace());
    await activate(tower.port, workspace);
    await registerInertBuilder(tower.port, workspace, BUILDER);
    // Ready when a send to the builder is held. (A workspace under the temp dir is left out
    // of `GET /api/workspaces`, so the listing cannot be used to wait.)
    const probe = { to: BUILDER, message: 'ready?', from: 'architect:main', workspace, fromWorkspace: workspace };
    let ready: unknown;
    for (let i = 0; i < 60; i++) {
      try {
        await timedHeldSend(tower.port, probe);
        ready = true;
        break;
      } catch (err) {
        ready = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (ready !== true) throw ready;
    // The teardown asserts that this list ends empty. Seeing the live shellpers in it now
    // is what makes that assertion mean something.
    expect(pidsNamingSocketDir(tower.socketDir).length).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    if (!tower) return;
    // Shellpers outlive Tower by design: stopping Tower alone leaves the architect's and
    // the builder's running for good. Deactivating the workspace is what ends them. A
    // failed deactivation is not swallowed: the assertion below is what reports it.
    for (const started of [workspace, otherWorkspace]) {
      if (!started) continue;
      await fetch(`http://localhost:${tower.port}/api/workspaces/${encodeWorkspacePath(started)}/deactivate`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      }).catch(() => {});
    }
    const { socketDir } = tower;
    await tower.stop();
    if (workspace) cleanupTestWorkspace(workspace);
    if (otherRoot) rmSync(otherRoot, { recursive: true, force: true });

    let survivors = pidsNamingSocketDir(socketDir);
    for (let i = 0; i < 40 && survivors.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      survivors = pidsNamingSocketDir(socketDir);
    }
    expect(survivors, `shellpers started by this run's Tower (${socketDir}) are still alive`).toEqual([]);
  }, 120_000);

  it('same-workspace send to a recipient whose mail is held', async () => {
    const stats = await measure(tower.port, {
      to: BUILDER,
      message: 'latency probe: forty bytes of body text.',
      from: 'architect:main',
      workspace,
      fromWorkspace: workspace,
    });
    report('same-workspace', stats);

    const baseline = process.env.CODEV_SEND_LATENCY_BASELINE_MS;
    if (baseline !== undefined) {
      const baselineMs = Number(baseline);
      expect(Number.isFinite(baselineMs) && baselineMs > 0).toBe(true);
      expect(
        withinBound(baselineMs, stats.median),
        `median ${stats.median.toFixed(3)}ms is outside the bound for a ${baselineMs}ms baseline ` +
          `(max ${Math.max(baselineMs * 1.05, baselineMs + 1).toFixed(3)}ms)`,
      ).toBe(true);
    }
  }, 300_000);

  it('cross-workspace send to a named architect whose mail is held (no bound: for the record)', async () => {
    otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'codev-latency-')));
    otherWorkspace = createWorkspaceWithInertArchitects(otherRoot);
    await activate(tower.port, otherWorkspace);
    const added = await fetch(
      `http://localhost:${tower.port}/api/workspaces/${encodeWorkspacePath(otherWorkspace)}/architects`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'tunnel' }) },
    );
    if (!added.ok) throw new Error(`add-architect failed: ${added.status} ${await added.text()}`);

    const body: SendBody = {
      to: 'latency-other:architect:tunnel',
      message: 'latency probe: forty bytes of body text.',
      from: 'architect:main',
      workspace,
      fromWorkspace: workspace,
    };
    // Ready when the send is held by the gate (`timedHeldSend` throws until it is).
    let ready: unknown;
    for (let i = 0; i < 60; i++) {
      try {
        await timedHeldSend(tower.port, body);
        ready = true;
        break;
      } catch (err) {
        ready = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (ready !== true) throw ready;

    report('cross-workspace-named-architect', await measure(tower.port, body));
  }, 300_000);
});
