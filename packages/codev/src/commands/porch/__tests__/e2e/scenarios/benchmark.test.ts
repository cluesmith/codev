/**
 * E2E Benchmark: Strict (porch) vs Soft (claude -p) mode
 *
 * Compares execution time and quality between:
 * - Strict mode: porch orchestrates build-verify cycles with 3-way consultation
 * - Soft mode: claude -p follows SPIR protocol autonomously
 *
 * Both modes use the same trivial spec (add a version constant).
 * Specs and plans are pre-approved to skip specify/plan phases.
 *
 * Run with: npm run test:e2e -- --grep benchmark
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createTestProject,
  cleanupTestProject,
  type TestContext,
} from '../helpers/setup.js';
import {
  runPorchWithAutoApprove,
  parseTimings,
  type PorchTimingEvent,
} from '../runner.js';

/** Persistent output directory for benchmark results (survives cleanup) */
const RESULTS_DIR = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'test-results', 'benchmark');

/** Pre-approved spec for the benchmark (trivial: add a version constant) */
const BENCHMARK_SPEC = `---
approved: ${new Date().toISOString().split('T')[0]}
validated: [gemini, codex, claude]
---

# Spec 9990: Benchmark Version Constant

## Problem

The project lacks a centralized version constant for benchmarking.

## Solution

Add a \`BENCHMARK_VERSION\` constant to \`src/version.ts\`.

## Acceptance Criteria

- [ ] \`src/version.ts\` exports \`BENCHMARK_VERSION = '1.0.0'\`
- [ ] Unit test verifies the constant format
- [ ] Existing tests still pass
`;

/** Pre-approved plan for the benchmark */
const BENCHMARK_PLAN = `---
approved: ${new Date().toISOString().split('T')[0]}
validated: [gemini, codex, claude]
---

# Plan 9990: Benchmark Version Constant

\`\`\`json
{"phases": [{"id": "phase_1", "title": "Add version constant"}, {"id": "phase_2", "title": "Add test"}]}
\`\`\`

## Phase 1: Add version constant

### Files to create
- \`src/version.ts\` — Export \`BENCHMARK_VERSION = '1.0.0'\`

## Phase 2: Add test

### Tests
- Add \`src/__tests__/version.test.ts\` that imports \`BENCHMARK_VERSION\` and verifies it matches \`/^\\d+\\.\\d+\\.\\d+$/\`
`;

/** Prompt for soft mode Claude to follow SPIR protocol */
const SOFT_MODE_PROMPT = `You are implementing Spec 9990 for a project. Follow the SPIR protocol:

1. Read the spec at codev/specs/9990-benchmark-version-constant.md
2. Read the plan at codev/plans/9990-benchmark-version-constant.md
3. Implement Phase 1: Create src/version.ts with BENCHMARK_VERSION = '1.0.0'
4. Implement Phase 2: Create src/__tests__/version.test.ts
5. Run \`npm run build\` and \`npm test\` to verify
6. Run 3-way consultation (consult commands) for impl review:
   - consult -m gemini --protocol spir --type impl
   - consult -m codex --protocol spir --type impl
   - consult -m claude --protocol spir --type impl
   Run all three in parallel.
7. Create a review document at codev/reviews/9990-benchmark-version-constant.md
8. Run 3-way pr consultation:
   - consult -m gemini --protocol spir --type pr
   - consult -m codex --protocol spir --type pr
   - consult -m claude --protocol spir --type pr
   Run all three in parallel.
9. Commit all changes with message "[Spec 9990] Benchmark version constant"

IMPORTANT: After EACH consultation set, wait for all three to complete before continuing.
`;

interface BenchmarkResult {
  mode: 'strict' | 'soft';
  durationMs: number;
  completed: boolean;
  timedOut: boolean;
  timings: PorchTimingEvent[];
  stdout: string;
}

/**
 * Set up a test project with pre-approved spec and plan.
 * This skips the specify and plan phases so we only benchmark implement+review.
 */
async function setupBenchmarkProject(
  projectId: string,
  title: string
): Promise<TestContext> {
  const ctx = await createTestProject(projectId, title);

  // Write pre-approved spec
  const specDir = path.join(ctx.tempDir, 'codev', 'specs');
  fs.writeFileSync(
    path.join(specDir, `${projectId}-${title}.md`),
    BENCHMARK_SPEC
  );

  // Write pre-approved plan
  const planDir = path.join(ctx.tempDir, 'codev', 'plans');
  fs.writeFileSync(
    path.join(planDir, `${projectId}-${title}.md`),
    BENCHMARK_PLAN
  );

  // Create src directory for the implementation
  fs.mkdirSync(path.join(ctx.tempDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ctx.tempDir, 'src', '__tests__'), { recursive: true });

  // Commit spec and plan so porch finds them
  const { exec: execCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execCb);
  await exec(
    `git add codev/specs/${projectId}-${title}.md codev/plans/${projectId}-${title}.md src`,
    { cwd: ctx.tempDir }
  );
  await exec('git commit -m "Add pre-approved spec and plan"', {
    cwd: ctx.tempDir,
  });

  return ctx;
}

/**
 * Run soft mode benchmark using claude -p.
 */
async function runSoftMode(
  ctx: TestContext,
  timeoutMs: number = 1200000
): Promise<BenchmarkResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const startMs = Date.now();

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    const proc = spawn(
      'claude',
      [
        '-p',
        SOFT_MODE_PROMPT,
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format',
        'stream-json',
      ],
      {
        cwd: ctx.tempDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      clearTimeout(timeout);
      resolve({
        mode: 'soft',
        durationMs: Date.now() - startMs,
        completed: !timedOut,
        timedOut,
        timings: [], // Soft mode doesn't emit __PORCH_TIMING__
        stdout,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        mode: 'soft',
        durationMs: Date.now() - startMs,
        completed: false,
        timedOut: false,
        timings: [],
        stdout: stdout + '\nERROR: ' + err.message,
      });
    });
  });
}

/**
 * Format timing summary for console output.
 */
function formatTimingSummary(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`\n=== ${result.mode.toUpperCase()} MODE ===`);
  lines.push(`Total: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Completed: ${result.completed}`);
  lines.push(`Timed out: ${result.timedOut}`);

  if (result.timings.length > 0) {
    lines.push('\nPhase breakdown:');
    for (const t of result.timings) {
      const phase = t.plan_phase ? `${t.phase}/${t.plan_phase}` : t.phase;
      const verdicts = t.verdicts
        ? Object.entries(t.verdicts).map(([m, v]) => `${m}:${v}`).join(' ')
        : '';
      lines.push(
        `  ${t.event} ${phase} iter${t.iteration}: ${(t.duration_ms / 1000).toFixed(1)}s ${verdicts}`
      );
    }

    // Aggregate stats
    const builds = result.timings.filter((t) => t.event === 'build');
    const verifies = result.timings.filter((t) => t.event === 'verify');
    const totalBuildMs = builds.reduce((s, t) => s + t.duration_ms, 0);
    const totalVerifyMs = verifies.reduce((s, t) => s + t.duration_ms, 0);
    lines.push(`\nTotal build time: ${(totalBuildMs / 1000).toFixed(1)}s (${builds.length} builds)`);
    lines.push(`Total verify time: ${(totalVerifyMs / 1000).toFixed(1)}s (${verifies.length} verifications)`);
    lines.push(`Total iterations: ${builds.length}`);
  }

  return lines.join('\n');
}

describe('Porch Benchmark: Strict vs Soft Mode', () => {
  let strictCtx: TestContext;
  let softCtx: TestContext;

  beforeAll(async () => {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    // Create both projects in parallel
    [strictCtx, softCtx] = await Promise.all([
      setupBenchmarkProject('9990', 'benchmark-strict'),
      setupBenchmarkProject('9991', 'benchmark-soft'),
    ]);
  }, 120000);

  afterAll(async () => {
    await Promise.all([
      cleanupTestProject(strictCtx),
      cleanupTestProject(softCtx),
    ]);
  }, 60000);

  it('strict mode completes full protocol', async () => {
    const result = await runPorchWithAutoApprove(strictCtx, 3600000); // 60 min

    const benchmarkResult: BenchmarkResult = {
      mode: 'strict',
      durationMs: result.durationMs,
      completed: result.completed,
      timedOut: result.timedOut,
      timings: result.timings,
      stdout: result.stdout,
    };

    console.log(formatTimingSummary(benchmarkResult));

    // Write results to file for later comparison
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'strict-result.json'),
      JSON.stringify(benchmarkResult, null, 2)
    );

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 3600000); // 60 min timeout

  it('soft mode completes implementation', async () => {
    const result = await runSoftMode(softCtx, 1200000); // 20 min

    console.log(formatTimingSummary(result));

    // Write results to file
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'soft-result.json'),
      JSON.stringify(result, null, 2)
    );

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 1200000); // 20 min timeout

  it('comparison summary', () => {
    // Read both results
    const strictResult: BenchmarkResult = JSON.parse(
      fs.readFileSync(path.join(RESULTS_DIR, 'strict-result.json'), 'utf-8')
    );
    const softResult: BenchmarkResult = JSON.parse(
      fs.readFileSync(path.join(RESULTS_DIR, 'soft-result.json'), 'utf-8')
    );

    console.log('\n' + '='.repeat(60));
    console.log('BENCHMARK COMPARISON');
    console.log('='.repeat(60));
    console.log(`Strict mode: ${(strictResult.durationMs / 1000).toFixed(1)}s`);
    console.log(`Soft mode:   ${(softResult.durationMs / 1000).toFixed(1)}s`);
    console.log(`Ratio:       ${(strictResult.durationMs / softResult.durationMs).toFixed(2)}x`);

    if (strictResult.timings.length > 0) {
      const builds = strictResult.timings.filter((t) => t.event === 'build');
      const verifies = strictResult.timings.filter((t) => t.event === 'verify');
      console.log(`\nStrict mode iterations: ${builds.length}`);
      console.log(`  Build time:  ${(builds.reduce((s, t) => s + t.duration_ms, 0) / 1000).toFixed(1)}s`);
      console.log(`  Verify time: ${(verifies.reduce((s, t) => s + t.duration_ms, 0) / 1000).toFixed(1)}s`);
    }

    console.log('='.repeat(60));

    // Both should have completed
    expect(strictResult.completed).toBe(true);
    expect(softResult.completed).toBe(true);
  });
});
