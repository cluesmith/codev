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
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import { realpathSync } from 'node:fs';
import {
  startTower,
  createTestWorkspace,
  cleanupTestWorkspace,
  encodeWorkspacePath,
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

describe.skipIf(!ENABLED)('send latency (Spec 1940, opt-in measurement)', () => {
  let tower: TowerHandle;
  let workspace: string;
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
  }, 120_000);

  afterAll(async () => {
    await tower?.stop();
    if (workspace) cleanupTestWorkspace(workspace);
  });

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
});
