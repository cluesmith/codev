import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { spawnMock, unrefMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  unrefMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { gate } from '../index.js';
import { getStatusPath, readState, writeState } from '../state.js';
import type { ProjectState } from '../types.js';

type ArtifactPhase = 'specify' | 'plan' | 'review';

const phaseCases: Array<{
  phase: ArtifactPhase;
  directory: 'specs' | 'plans' | 'reviews';
  gateName: string;
}> = [
  { phase: 'specify', directory: 'specs', gateName: 'spec-approval' },
  { phase: 'plan', directory: 'plans', gateName: 'plan-approval' },
  { phase: 'review', directory: 'reviews', gateName: 'pr' },
];

const testProtocol = {
  name: 'gate-auto-open-test',
  version: '1.0.0',
  phases: [
    { id: 'specify', name: 'Specify', gate: 'spec-approval' },
    { id: 'plan', name: 'Plan', gate: 'plan-approval' },
    { id: 'review', name: 'Review', gate: 'pr' },
    { id: 'implement', name: 'Implement', gate: 'dev-approval' },
  ],
};

let testDir: string;
let originalHome: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

function makeState(phase: string): ProjectState {
  const now = new Date().toISOString();
  return {
    id: '1216',
    title: 'gate-test',
    protocol: testProtocol.name,
    phase,
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: now,
    updated_at: now,
  };
}

function writeProtocol(): void {
  const protocolDir = path.join(testDir, 'codev', 'protocols', testProtocol.name);
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(
    path.join(protocolDir, 'protocol.json'),
    JSON.stringify(testProtocol, null, 2),
  );
}

function writeProjectConfig(autoOpenArtifacts: boolean): void {
  const configDir = path.join(testDir, '.codev');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ porch: { autoOpenArtifacts } }, null, 2),
  );
}

function writeProjectState(phase: string): string {
  const state = makeState(phase);
  const statusPath = getStatusPath(testDir, state.id, state.title);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
  return statusPath;
}

function writeArtifact(directory: string): string {
  const artifactPath = path.join(testDir, 'codev', directory, '1216-gate-test.md');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, '# Gate artifact\n');
  return artifactPath;
}

function output(): string {
  return logSpy.mock.calls.flat().join('\n');
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-gate-auto-open-'));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(testDir, 'fake-home');
  writeProtocol();

  spawnMock.mockReset();
  unrefMock.mockReset();
  spawnMock.mockReturnValue({ unref: unrefMock });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  process.env.HOME = originalHome;
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('porch gate artifact auto-open', () => {
  it.each([
    { label: 'unset', value: undefined },
    { label: 'true', value: true },
  ])('opens an existing artifact when the setting is $label', async ({ value }) => {
    const artifactPath = writeArtifact('specs');
    writeProjectState('specify');
    if (value !== undefined) writeProjectConfig(value);

    await gate(testDir, '1216');

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith('afx', ['open', artifactPath], {
      stdio: 'inherit',
      detached: true,
    });
    expect(unrefMock).toHaveBeenCalledOnce();
    expect(output()).toContain('Opening artifact for human review...');
  });

  it.each(phaseCases)(
    'does not open the $phase artifact when the setting is false',
    async ({ phase, directory, gateName }) => {
      const artifactPath = writeArtifact(directory);
      const statusPath = writeProjectState(phase);
      writeProjectConfig(false);

      await gate(testDir, '1216');

      expect(spawnMock).not.toHaveBeenCalled();
      expect(unrefMock).not.toHaveBeenCalled();
      expect(output()).toContain(`Artifact: ${path.relative(testDir, artifactPath)}`);
      expect(output()).not.toContain('Opening artifact for human review...');
      expect(output()).toContain('Human approval required. STOP and wait.');
      expect(output()).toContain(`To approve: porch approve 1216 ${gateName}`);

      const updated = readState(statusPath);
      expect(updated.gates[gateName]).toMatchObject({
        status: 'pending',
        requested_at: expect.any(String),
      });
    },
  );

  it.each([undefined, true, false])(
    'does not open a missing mapped artifact when the setting is %s',
    async (value) => {
      const statusPath = writeProjectState('plan');
      if (value !== undefined) writeProjectConfig(value);

      await gate(testDir, '1216');

      expect(spawnMock).not.toHaveBeenCalled();
      expect(output()).not.toContain('Opening artifact for human review...');
      expect(readState(statusPath).gates['plan-approval']).toMatchObject({
        status: 'pending',
        requested_at: expect.any(String),
      });
    },
  );

  it('does not open an artifact for a phase without an artifact mapping', async () => {
    writeProjectState('implement');
    writeProjectConfig(true);

    await gate(testDir, '1216');

    expect(spawnMock).not.toHaveBeenCalled();
    expect(output()).not.toContain('Opening artifact for human review...');
  });
});
