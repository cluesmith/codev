/**
 * E2E Test Runner
 *
 * Runs porch commands and monitors for gates/completion.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { TestContext } from './helpers/setup.js';

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  hitGate: string | null;
  completed: boolean;
  timedOut: boolean;
}

/**
 * Run porch until it hits a gate or completes.
 *
 * @param ctx Test context
 * @param timeoutMs Timeout in milliseconds (default: 10 minutes)
 * @returns Result of the run
 */
export async function runPorchUntilGate(
  ctx: TestContext,
  timeoutMs: number = 600000
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let hitGate: string | null = null;
    let completed = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      porch.kill('SIGTERM');
    }, timeoutMs);

    // Get the porch binary path
    const porchBin = path.resolve(__dirname, '../../../../../bin/porch.js');

    const porch = spawn('node', [porchBin, 'run', ctx.projectId], {
      cwd: ctx.tempDir,
      env: {
        ...process.env,
        // Auto-approve gates for testing
        PORCH_AUTO_APPROVE: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    porch.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      // Check for gate
      const gateMatch = text.match(/GATE:\s*(\S+)/);
      if (gateMatch) {
        hitGate = gateMatch[1];
        porch.kill('SIGTERM');
      }

      // Check for completion
      if (text.includes('PROTOCOL COMPLETE')) {
        completed = true;
        porch.kill('SIGTERM');
      }
    });

    porch.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    porch.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        hitGate,
        completed,
        timedOut,
      });
    });

    porch.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        hitGate: null,
        completed: false,
        timedOut: false,
      });
    });
  });
}

/**
 * Approve a gate programmatically.
 * In E2E tests, we pass hasHumanFlag=true to simulate human approval.
 */
export async function approveGate(
  ctx: TestContext,
  gateName: string
): Promise<void> {
  const { approve } = await import('../../index.js');
  await approve(ctx.tempDir, ctx.projectId, gateName, true /* hasHumanFlag */);
}

/**
 * Run porch with auto-approve enabled (for full lifecycle tests).
 */
export async function runPorchWithAutoApprove(
  ctx: TestContext,
  timeoutMs: number = 1200000 // 20 minutes
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let completed = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      porch.kill('SIGTERM');
    }, timeoutMs);

    const porchBin = path.resolve(__dirname, '../../../../../bin/porch.js');

    const porch = spawn('node', [porchBin, 'run', ctx.projectId], {
      cwd: ctx.tempDir,
      env: {
        ...process.env,
        PORCH_AUTO_APPROVE: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    porch.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      if (text.includes('PROTOCOL COMPLETE')) {
        completed = true;
        porch.kill('SIGTERM');
      }
    });

    porch.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    porch.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        hitGate: null,
        completed,
        timedOut,
      });
    });

    porch.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        hitGate: null,
        completed: false,
        timedOut: false,
      });
    });
  });
}

/**
 * Run a single porch iteration (for testing specific phases).
 */
/**
 * Parsed result from __PORCH_RESULT__ JSON output.
 */
export interface SinglePhaseResult {
  phase: string;
  plan_phase: string | null;
  iteration: number;
  status: 'advanced' | 'gate_needed' | 'verified' | 'iterating';
  gate: string | null;
  verdicts?: Record<string, string>;
  artifact?: string;
}

/**
 * Run porch in --single-phase mode (Builder/Enforcer pattern).
 * Returns the structured result JSON.
 */
export async function runPorchSinglePhase(
  ctx: TestContext,
  timeoutMs: number = 600000
): Promise<RunResult & { singlePhaseResult: SinglePhaseResult | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let hitGate: string | null = null;
    let timedOut = false;
    let singlePhaseResult: SinglePhaseResult | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      porch.kill('SIGTERM');
    }, timeoutMs);

    const porchBin = path.resolve(__dirname, '../../../../../bin/porch.js');

    const porch = spawn('node', [porchBin, 'run', ctx.projectId, '--single-phase'], {
      cwd: ctx.tempDir,
      env: {
        ...process.env,
        PORCH_AUTO_APPROVE: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    porch.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      // Parse __PORCH_RESULT__ JSON
      const resultMatch = text.match(/__PORCH_RESULT__({.*})/);
      if (resultMatch) {
        try {
          singlePhaseResult = JSON.parse(resultMatch[1]);
        } catch { /* ignore parse errors */ }
      }

      const gateMatch = text.match(/GATE:\s*(\S+)/);
      if (gateMatch) {
        hitGate = gateMatch[1];
      }
    });

    porch.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    porch.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        hitGate,
        completed: false,
        timedOut,
        singlePhaseResult,
      });
    });

    porch.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        hitGate: null,
        completed: false,
        timedOut: false,
        singlePhaseResult: null,
      });
    });
  });
}

/**
 * Run a single porch iteration (for testing specific phases).
 */
export async function runPorchOnce(
  ctx: TestContext,
  timeoutMs: number = 300000 // 5 minutes
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let hitGate: string | null = null;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      porch.kill('SIGTERM');
    }, timeoutMs);

    const porchBin = path.resolve(__dirname, '../../../../../bin/porch.js');

    const porch = spawn('node', [porchBin, 'run', ctx.projectId, '--once'], {
      cwd: ctx.tempDir,
      env: {
        ...process.env,
        PORCH_AUTO_APPROVE: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    porch.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      const gateMatch = text.match(/GATE:\s*(\S+)/);
      if (gateMatch) {
        hitGate = gateMatch[1];
      }
    });

    porch.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    porch.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        hitGate,
        completed: false,
        timedOut,
      });
    });

    porch.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        hitGate: null,
        completed: false,
        timedOut: false,
      });
    });
  });
}
