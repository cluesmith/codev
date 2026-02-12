/**
 * Tests for getGateStatusForProject (utils/gate-status.ts)
 *
 * Phase 3 (Spec 0099): Gate status is now read from porch YAML files
 * instead of hardcoded to { hasGate: false }.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { getGateStatusForProject } from '../utils/gate-status.js';

describe('getGateStatusForProject', () => {
  const testDir = path.join(tmpdir(), `codev-gate-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect pending spec-approval gate', () => {
    const projectDir = path.join(testDir, 'codev', 'projects', '0042-test-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'status.yaml'), `id: '0042'
title: test-feature
protocol: spir
phase: specify
gates:
  spec-approval:
    status: pending
  plan-approval:
    status: pending
  pr-ready:
    status: pending
`);

    const result = getGateStatusForProject(testDir);
    expect(result.hasGate).toBe(true);
    expect(result.gateName).toBe('spec-approval');
    expect(result.builderId).toBe('0042');
  });

  it('should skip approved gates and find next pending', () => {
    const projectDir = path.join(testDir, 'codev', 'projects', '0099-tower-hygiene');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'status.yaml'), `id: '0099'
title: tower-hygiene
protocol: spir
phase: plan
gates:
  spec-approval:
    status: approved
    approved_at: '2026-02-12T05:26:59.084Z'
  plan-approval:
    status: pending
  pr-ready:
    status: pending
`);

    const result = getGateStatusForProject(testDir);
    expect(result.hasGate).toBe(true);
    expect(result.gateName).toBe('plan-approval');
    expect(result.builderId).toBe('0099');
  });

  it('should return hasGate: false when all gates are approved', () => {
    const projectDir = path.join(testDir, 'codev', 'projects', '0050-all-approved');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'status.yaml'), `id: '0050'
title: all-approved
protocol: spir
phase: implement
gates:
  spec-approval:
    status: approved
    approved_at: '2026-02-12T05:26:59.084Z'
  plan-approval:
    status: approved
    approved_at: '2026-02-12T08:08:27.693Z'
  pr-ready:
    status: approved
    approved_at: '2026-02-12T10:00:00.000Z'
`);

    const result = getGateStatusForProject(testDir);
    expect(result.hasGate).toBe(false);
  });

  it('should return hasGate: false when codev/projects does not exist', () => {
    const result = getGateStatusForProject(testDir);
    expect(result.hasGate).toBe(false);
  });

  it('should extract builder ID from directory name', () => {
    const projectDir = path.join(testDir, 'codev', 'projects', '0077-some-feature');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'status.yaml'), `id: '0077'
title: some-feature
protocol: spir
phase: specify
gates:
  spec-approval:
    status: pending
`);

    const result = getGateStatusForProject(testDir);
    expect(result.builderId).toBe('0077');
  });

  it('should handle status.yaml without gates section', () => {
    const projectDir = path.join(testDir, 'codev', 'projects', '0010-no-gates');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'status.yaml'), `id: '0010'
title: no-gates
protocol: spir
phase: specify
`);

    const result = getGateStatusForProject(testDir);
    expect(result.hasGate).toBe(false);
  });
});
