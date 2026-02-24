/**
 * Tests for getPhaseChecks and getPhaseCompletionChecks with override support
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProtocol,
  getPhaseChecks,
  getPhaseCompletionChecks,
} from '../protocol.js';
import type { CheckOverrides } from '../types.js';

// ---------------------------------------------------------------------------
// Test protocol fixture
// ---------------------------------------------------------------------------

const TEST_PROTOCOL = {
  name: 'test-protocol',
  version: '1.0.0',
  phases: [
    {
      id: 'build',
      name: 'Build',
      type: 'once',
      checks: {
        build: { command: 'npm run build', cwd: 'packages/codev' },
        tests: { command: 'npm test' },
        e2e_tests: { command: 'npm run test:e2e' },
      },
    },
    {
      id: 'deploy',
      name: 'Deploy',
      type: 'once',
      // No checks
    },
  ],
  phase_completion: {
    build_succeeds: 'npm run build 2>&1',
    tests_pass: 'npm test 2>&1',
  },
};

describe('getPhaseChecks with overrides', () => {
  const testDir = path.join(tmpdir(), `porch-override-test-${Date.now()}`);
  const protocolsDir = path.join(testDir, 'codev/protocols/test-protocol');

  beforeEach(() => {
    fs.mkdirSync(protocolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(protocolsDir, 'protocol.json'),
      JSON.stringify(TEST_PROTOCOL)
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns protocol defaults when no overrides provided', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const checks = getPhaseChecks(protocol, 'build');

    expect(Object.keys(checks)).toHaveLength(3);
    expect(checks.build.command).toBe('npm run build');
    expect(checks.build.cwd).toBe('packages/codev');
    expect(checks.tests.command).toBe('npm test');
    expect(checks.e2e_tests.command).toBe('npm run test:e2e');
  });

  it('replaces command when override.command is set', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build: { command: 'cargo build' },
    };
    const checks = getPhaseChecks(protocol, 'build', overrides);

    expect(checks.build.command).toBe('cargo build');
    // cwd is preserved from protocol default when override doesn't specify cwd
    expect(checks.build.cwd).toBe('packages/codev');
    // other checks unchanged
    expect(checks.tests.command).toBe('npm test');
  });

  it('replaces cwd when override.cwd is set', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build: { cwd: 'custom/path' },
    };
    const checks = getPhaseChecks(protocol, 'build', overrides);

    // command is preserved from protocol when override doesn't specify it
    expect(checks.build.command).toBe('npm run build');
    expect(checks.build.cwd).toBe('custom/path');
  });

  it('omits check when skip is true', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      e2e_tests: { skip: true },
    };
    const checks = getPhaseChecks(protocol, 'build', overrides);

    expect(Object.keys(checks)).not.toContain('e2e_tests');
    expect(Object.keys(checks)).toHaveLength(2);
    expect(checks.build).toBeDefined();
    expect(checks.tests).toBeDefined();
  });

  it('handles command + cwd override together', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build: { command: 'make', cwd: 'src/' },
    };
    const checks = getPhaseChecks(protocol, 'build', overrides);

    expect(checks.build.command).toBe('make');
    expect(checks.build.cwd).toBe('src/');
  });

  it('handles mixed scenario: skip + command override + default coexisting', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build: { command: 'go build ./...' },
      tests: { command: 'go test ./...' },
      e2e_tests: { skip: true },
    };
    const checks = getPhaseChecks(protocol, 'build', overrides);

    expect(Object.keys(checks)).toHaveLength(2);
    expect(checks.build.command).toBe('go build ./...');
    expect(checks.tests.command).toBe('go test ./...');
    expect(checks.e2e_tests).toBeUndefined();
  });

  it('returns empty object when phase has no checks', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build: { command: 'go build ./...' },
    };
    const checks = getPhaseChecks(protocol, 'deploy', overrides);
    expect(Object.keys(checks)).toHaveLength(0);
  });

  it('returns empty object for unknown phase', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const checks = getPhaseChecks(protocol, 'nonexistent');
    expect(Object.keys(checks)).toHaveLength(0);
  });

  it('emits warning for unknown override check names (does not throw)', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      nonexistent_check: { command: 'echo nope' },
    };
    // Should not throw — just warn to stderr
    expect(() => getPhaseChecks(protocol, 'build', overrides)).not.toThrow();
    // All protocol checks still returned
    const checks = getPhaseChecks(protocol, 'build', overrides);
    expect(Object.keys(checks)).toHaveLength(3);
  });
});

describe('getPhaseCompletionChecks with overrides', () => {
  const testDir = path.join(tmpdir(), `porch-completion-override-test-${Date.now()}`);
  const protocolsDir = path.join(testDir, 'codev/protocols/test-protocol');

  beforeEach(() => {
    fs.mkdirSync(protocolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(protocolsDir, 'protocol.json'),
      JSON.stringify(TEST_PROTOCOL)
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns protocol defaults when no overrides provided', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const checks = getPhaseCompletionChecks(protocol);

    expect(Object.keys(checks)).toHaveLength(2);
    expect(checks.build_succeeds).toBe('npm run build 2>&1');
    expect(checks.tests_pass).toBe('npm test 2>&1');
  });

  it('replaces command when override.command is set', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build_succeeds: { command: 'cargo build 2>&1' },
    };
    const checks = getPhaseCompletionChecks(protocol, overrides);

    expect(checks.build_succeeds).toBe('cargo build 2>&1');
    expect(checks.tests_pass).toBe('npm test 2>&1');
  });

  it('removes gating condition when skip is true', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      tests_pass: { skip: true },
    };
    const checks = getPhaseCompletionChecks(protocol, overrides);

    expect(Object.keys(checks)).not.toContain('tests_pass');
    expect(checks.build_succeeds).toBe('npm run build 2>&1');
  });

  it('skipping does NOT auto-pass — condition is simply removed from gating', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build_succeeds: { skip: true },
      tests_pass: { skip: true },
    };
    const checks = getPhaseCompletionChecks(protocol, overrides);
    // Both conditions removed — result is empty (no gating conditions)
    expect(Object.keys(checks)).toHaveLength(0);
  });

  it('handles mixed: skip + command override', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      build_succeeds: { command: 'uv run pytest --co -q 2>&1' },
      tests_pass: { skip: true },
    };
    const checks = getPhaseCompletionChecks(protocol, overrides);

    expect(Object.keys(checks)).toHaveLength(1);
    expect(checks.build_succeeds).toBe('uv run pytest --co -q 2>&1');
    expect(checks.tests_pass).toBeUndefined();
  });

  it('emits warning for unknown override check names (does not throw)', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    const overrides: CheckOverrides = {
      nonexistent_check: { command: 'echo nope' },
    };
    // Should not throw — just warn to stderr
    expect(() => getPhaseCompletionChecks(protocol, overrides)).not.toThrow();
    // Known checks still returned
    const checks = getPhaseCompletionChecks(protocol, overrides);
    expect(Object.keys(checks)).toHaveLength(2);
  });
});

describe('protocol.json phase_completion loading', () => {
  const testDir = path.join(tmpdir(), `porch-proto-load-test-${Date.now()}`);
  const protocolsDir = path.join(testDir, 'codev/protocols/test-protocol');

  beforeEach(() => {
    fs.mkdirSync(protocolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(protocolsDir, 'protocol.json'),
      JSON.stringify(TEST_PROTOCOL)
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('loads phase_completion from protocol.json', () => {
    const protocol = loadProtocol(testDir, 'test-protocol');
    expect(protocol.phase_completion).toBeDefined();
    expect(protocol.phase_completion?.build_succeeds).toBe('npm run build 2>&1');
    expect(protocol.phase_completion?.tests_pass).toBe('npm test 2>&1');
  });

  it('phase_completion is undefined when not in protocol.json', () => {
    const withoutCompletion = { ...TEST_PROTOCOL, phase_completion: undefined };
    fs.writeFileSync(
      path.join(protocolsDir, 'protocol.json'),
      JSON.stringify(withoutCompletion)
    );
    const protocol = loadProtocol(testDir, 'test-protocol');
    expect(protocol.phase_completion).toBeUndefined();
  });
});
