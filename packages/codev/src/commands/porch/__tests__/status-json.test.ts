/**
 * Tests for `porch status --json` (Issue 691).
 *
 * The JSON flag produces a single-line JSON object on stdout suitable for
 * consumption by the VSCode Needs Attention view (and any other tooling).
 * All human-readable console output is suppressed.
 *
 * Asserted shape (per the function's JSDoc in commands/porch/index.ts):
 *
 *   {
 *     "id": string,
 *     "title": string,
 *     "protocol": string,
 *     "phase": string,
 *     "iteration": number,
 *     "build_complete": boolean,
 *     "gate": string | null,
 *     "gate_status": "pending" | "approved" | null,
 *     "gate_requested_at": string | null,
 *     "gate_approved_at": string | null
 *   }
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { status } from '../index.js';
import { writeState, getStatusPath } from '../state.js';
import type { ProjectState } from '../types.js';

function createTestDir(): string {
  return path.join(
    tmpdir(),
    `porch-status-json-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function setupPirProtocol(testDir: string): void {
  const protocolDir = path.join(testDir, 'codev', 'protocols', 'pir');
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(
    path.join(protocolDir, 'protocol.json'),
    JSON.stringify({
      name: 'pir',
      version: '1.0.0',
      phases: [
        { id: 'plan', name: 'Plan', type: 'build_verify', gate: 'plan-approval', next: 'implement' },
        { id: 'implement', name: 'Implement', type: 'build_verify', gate: 'dev-approval', next: 'review' },
        { id: 'review', name: 'Review', type: 'build_verify', next: null },
      ],
    }),
  );
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: 'pir-842',
    title: 'fix-avatar-crop',
    protocol: 'pir',
    phase: 'plan',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('porch status --json', () => {
  let testDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = createTestDir();
    fs.mkdirSync(testDir, { recursive: true });
    setupPirProtocol(testDir);
    // Capture process.stdout.write to inspect the JSON output and prevent
    // it from leaking into the test runner's output.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Suppress chalk/console output from any non-JSON code paths so tests
    // don't print noise even if the suppression path regresses.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function parseStdoutJson(): Record<string, unknown> {
    // The last write should be the JSON line; previous writes may be empty.
    const calls = stdoutSpy.mock.calls
      .map(c => (typeof c[0] === 'string' ? c[0] : String(c[0])))
      .filter(s => s.trim().length > 0);
    expect(calls.length).toBeGreaterThan(0);
    return JSON.parse(calls[calls.length - 1]);
  }

  it('emits JSON object with all required fields when gate is pending', async () => {
    const state = makeState({
      gates: {
        'plan-approval': {
          status: 'pending',
          requested_at: '2026-05-12T14:23:00.000Z',
        },
      },
      build_complete: true,
    });
    writeState(getStatusPath(testDir, 'pir-842', 'fix-avatar-crop'), state);

    await status(testDir, 'pir-842', undefined, { json: true });

    const out = parseStdoutJson();
    expect(out.id).toBe('pir-842');
    expect(out.title).toBe('fix-avatar-crop');
    expect(out.protocol).toBe('pir');
    expect(out.phase).toBe('plan');
    expect(out.iteration).toBe(1);
    expect(out.build_complete).toBe(true);
    expect(out.gate).toBe('plan-approval');
    expect(out.gate_status).toBe('pending');
    expect(out.gate_requested_at).toBe('2026-05-12T14:23:00.000Z');
    expect(out.gate_approved_at).toBeNull();
  });

  it('emits gate_status approved with approved_at timestamp', async () => {
    const state = makeState({
      gates: {
        'plan-approval': {
          status: 'approved',
          requested_at: '2026-05-12T14:23:00.000Z',
          approved_at: '2026-05-12T14:35:00.000Z',
        },
      },
    });
    writeState(getStatusPath(testDir, 'pir-842', 'fix-avatar-crop'), state);

    await status(testDir, 'pir-842', undefined, { json: true });

    const out = parseStdoutJson();
    expect(out.gate_status).toBe('approved');
    expect(out.gate_requested_at).toBe('2026-05-12T14:23:00.000Z');
    expect(out.gate_approved_at).toBe('2026-05-12T14:35:00.000Z');
  });

  it('emits gate null for an ungated phase', async () => {
    const state = makeState({ phase: 'review' });
    writeState(getStatusPath(testDir, 'pir-842', 'fix-avatar-crop'), state);

    await status(testDir, 'pir-842', undefined, { json: true });

    const out = parseStdoutJson();
    expect(out.phase).toBe('review');
    expect(out.gate).toBeNull();
    expect(out.gate_status).toBeNull();
    expect(out.gate_requested_at).toBeNull();
    expect(out.gate_approved_at).toBeNull();
  });

  it('suppresses human-readable console output in json mode', async () => {
    const state = makeState();
    writeState(getStatusPath(testDir, 'pir-842', 'fix-avatar-crop'), state);

    await status(testDir, 'pir-842', undefined, { json: true });

    // No console.log calls should fire in JSON mode — all output goes via
    // process.stdout.write.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('reports the dev-approval gate correctly when in the implement phase', async () => {
    const state = makeState({
      phase: 'implement',
      gates: {
        'dev-approval': { status: 'pending', requested_at: '2026-05-12T15:00:00.000Z' },
      },
      build_complete: true,
    });
    writeState(getStatusPath(testDir, 'pir-842', 'fix-avatar-crop'), state);

    await status(testDir, 'pir-842', undefined, { json: true });

    const out = parseStdoutJson();
    expect(out.phase).toBe('implement');
    expect(out.gate).toBe('dev-approval');
    expect(out.gate_status).toBe('pending');
  });
});
