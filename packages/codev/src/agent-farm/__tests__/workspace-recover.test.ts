/**
 * Tests for `afx workspace recover` — eligibility predicate, builder-info
 * derivation, worktree resolution, and listAllProjects precedence.
 *
 * Issue #829. Architect-attribution preservation (deriveBuilderInfoWithArchitect,
 * respawnEnv) is Issue #1140.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  evaluateEligibility,
  deriveBuilderInfo,
  deriveBuilderInfoWithArchitect,
  respawnEnv,
  resolveWorktreePath,
  formatRelativeAge,
  type EligibilityInputs,
  type BuilderInfo,
} from '../commands/workspace-recover.js';
import { listAllProjects } from '../../commands/porch/state.js';
import type { ProjectState } from '../../commands/porch/types.js';
import type { DbTerminalSession } from '../servers/tower-types.js';

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '0087',
    title: 'Test project',
    protocol: 'spir',
    phase: 'implement',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: '2026-05-20T00:00:00.000Z',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<DbTerminalSession> = {}): DbTerminalSession {
  return {
    id: 'term-123',
    workspace_path: '/workspace',
    type: 'builder',
    role_id: 'builder-spir-87',
    pid: null,
    shellper_socket: '/tmp/shellper.sock',
    shellper_pid: 12345,
    shellper_start_time: Date.now(),
    label: null,
    cwd: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeBuilderInfo(overrides: Partial<BuilderInfo> = {}): BuilderInfo {
  return {
    builderId: 'builder-spir-87',
    issueArg: '87',
    cliProtocol: 'spir',
    spawnedByArchitect: null,
    ...overrides,
  };
}

function defaults(): Omit<EligibilityInputs, 'state' | 'builderInfo' | 'sessions' | 'worktreeExists' | 'ageDays'> {
  return {
    maxAgeDays: 7,
    includeStale: false,
    isProcessAlive: () => false,
    socketExists: () => false,
  };
}

describe('evaluateEligibility', () => {
  it('skips terminal phase (verified) — comes before all other checks', () => {
    const result = evaluateEligibility({
      state: makeState({ phase: 'verified' }),
      builderInfo: makeBuilderInfo(),
      sessions: [makeSession()],
      worktreeExists: true,
      ageDays: 0,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: false, reason: 'terminal' });
  });

  it('skips terminal phase (complete)', () => {
    const result = evaluateEligibility({
      state: makeState({ phase: 'complete' }),
      builderInfo: makeBuilderInfo(),
      sessions: [makeSession()],
      worktreeExists: true,
      ageDays: 0,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: false, reason: 'terminal' });
  });

  it('skips when builderInfo is null (unsupported protocol)', () => {
    const result = evaluateEligibility({
      state: makeState({ protocol: 'experiment' }),
      builderInfo: null,
      sessions: [makeSession()],
      worktreeExists: true,
      ageDays: 0,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: false, reason: 'unsupported_protocol' });
  });

  it('revives when no session row exists (Tower already reconciled the dead row)', () => {
    // The common post-reboot case: Tower startup runs reconciliation, fails
    // to reconnect to the dead shellper, and deletes the row. By the time
    // `workspace recover` runs, the row is gone. Absence means "needs revival."
    const result = evaluateEligibility({
      state: makeState(),
      builderInfo: makeBuilderInfo(),
      sessions: [],
      worktreeExists: true,
      ageDays: 0,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: true });
  });

  describe('liveness probe (PID-first per Gemini #829 review)', () => {
    it('skips when shellper PID is alive (socket also present)', () => {
      const result = evaluateEligibility({
        state: makeState(),
        builderInfo: makeBuilderInfo(),
        sessions: [makeSession({ shellper_pid: 12345, shellper_socket: '/sock' })],
        worktreeExists: true,
        ageDays: 0,
        ...defaults(),
        isProcessAlive: () => true,
        socketExists: () => true,
      });
      expect(result).toEqual({ eligible: false, reason: 'shellper_alive' });
    });

    it('revives when PID is known dead even though stale socket file remains', () => {
      // Critical for reboot recovery: sockets live in ~/.codev/run/ which the
      // OS does not clear on reboot. The dead PID is definitive evidence.
      const result = evaluateEligibility({
        state: makeState(),
        builderInfo: makeBuilderInfo(),
        sessions: [makeSession({ shellper_pid: 12345, shellper_socket: '/sock' })],
        worktreeExists: true,
        ageDays: 0,
        ...defaults(),
        isProcessAlive: () => false,
        socketExists: () => true,
      });
      expect(result).toEqual({ eligible: true });
    });

    it('falls back to socket check when shellper_pid is null (legacy rows)', () => {
      const result = evaluateEligibility({
        state: makeState(),
        builderInfo: makeBuilderInfo(),
        sessions: [makeSession({ shellper_pid: null, shellper_socket: '/sock' })],
        worktreeExists: true,
        ageDays: 0,
        ...defaults(),
        isProcessAlive: () => false,
        socketExists: () => true,
      });
      expect(result).toEqual({ eligible: false, reason: 'shellper_alive' });
    });

    it('revives when shellper_pid is null AND no socket file', () => {
      const result = evaluateEligibility({
        state: makeState(),
        builderInfo: makeBuilderInfo(),
        sessions: [makeSession({ shellper_pid: null, shellper_socket: '/sock' })],
        worktreeExists: true,
        ageDays: 0,
        ...defaults(),
        isProcessAlive: () => false,
        socketExists: () => false,
      });
      expect(result).toEqual({ eligible: true });
    });
  });

  describe('duplicate row aggregation (Codex #829 review)', () => {
    it('treats builder as alive if ANY matching row has a live PID', () => {
      const result = evaluateEligibility({
        state: makeState(),
        builderInfo: makeBuilderInfo(),
        sessions: [
          makeSession({ id: 'dead-row', shellper_pid: 11111 }),
          makeSession({ id: 'live-row', shellper_pid: 22222 }),
        ],
        worktreeExists: true,
        ageDays: 0,
        ...defaults(),
        // pid 11111 dead, pid 22222 alive
        isProcessAlive: (pid) => pid === 22222,
      });
      expect(result).toEqual({ eligible: false, reason: 'shellper_alive' });
    });

    it('revives only when ALL matching rows look dead', () => {
      const result = evaluateEligibility({
        state: makeState(),
        builderInfo: makeBuilderInfo(),
        sessions: [
          makeSession({ id: 'row-a', shellper_pid: 11111 }),
          makeSession({ id: 'row-b', shellper_pid: 22222 }),
        ],
        worktreeExists: true,
        ageDays: 0,
        ...defaults(),
        isProcessAlive: () => false,
      });
      expect(result).toEqual({ eligible: true });
    });
  });

  it('skips when worktree is missing', () => {
    const result = evaluateEligibility({
      state: makeState(),
      builderInfo: makeBuilderInfo(),
      sessions: [makeSession()],
      worktreeExists: false,
      ageDays: 0,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: false, reason: 'worktree_missing' });
  });

  it('skips stale projects when --include-stale not set', () => {
    const result = evaluateEligibility({
      state: makeState(),
      builderInfo: makeBuilderInfo(),
      sessions: [makeSession()],
      worktreeExists: true,
      ageDays: 30,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: false, reason: 'stale' });
  });

  it('honors --include-stale on otherwise-stale projects', () => {
    const result = evaluateEligibility({
      state: makeState(),
      builderInfo: makeBuilderInfo(),
      sessions: [makeSession()],
      worktreeExists: true,
      ageDays: 30,
      ...defaults(),
      includeStale: true,
    });
    expect(result).toEqual({ eligible: true });
  });

  it('returns eligible when all conditions are met', () => {
    const result = evaluateEligibility({
      state: makeState(),
      builderInfo: makeBuilderInfo(),
      sessions: [makeSession()],
      worktreeExists: true,
      ageDays: 2,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: true });
  });

  it('checks predicates in cheap-first order (terminal beats unsupported)', () => {
    const result = evaluateEligibility({
      state: makeState({ phase: 'verified', protocol: 'experiment' }),
      builderInfo: null,
      sessions: [],
      worktreeExists: false,
      ageDays: 999,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: false, reason: 'terminal' });
  });

  it('skips a stale project even with no session row (post-reconciliation + old)', () => {
    // Without the predicate fix, this would have shown `no_session_row`;
    // with the new ordering, an old project past the recency window is
    // surfaced as `stale` — the more useful diagnostic for the operator.
    const result = evaluateEligibility({
      state: makeState(),
      builderInfo: makeBuilderInfo(),
      sessions: [],
      worktreeExists: true,
      ageDays: 30,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: false, reason: 'stale' });
  });

  it('revives a recent active project even with no session row (the PIR-at-gate case)', () => {
    // The motivating bug: a PIR builder sitting at plan-approval, killed by
    // a reboot, with its session row cleaned up by Tower's reconciliation.
    // Before the predicate fix, this incorrectly skipped with `no_session_row`.
    const result = evaluateEligibility({
      state: makeState({ protocol: 'pir', phase: 'plan' }),
      builderInfo: makeBuilderInfo({ builderId: 'builder-pir-1661', issueArg: '1661', cliProtocol: 'pir' }),
      sessions: [],
      worktreeExists: true,
      ageDays: 1,
      ...defaults(),
    });
    expect(result).toEqual({ eligible: true });
  });
});

describe('deriveBuilderInfo', () => {
  it('maps SPIR state to builder-spir-<stripped-id>', () => {
    expect(deriveBuilderInfo(makeState({ id: '0087', protocol: 'spir' }))).toEqual({
      builderId: 'builder-spir-87',
      issueArg: '87',
      cliProtocol: 'spir',
      spawnedByArchitect: null,
    });
  });

  it('handles bugfix project IDs (bugfix-693 → builder-bugfix-693, issue 693)', () => {
    expect(deriveBuilderInfo(makeState({ id: 'bugfix-693', protocol: 'bugfix' }))).toEqual({
      builderId: 'builder-bugfix-693',
      issueArg: '693',
      cliProtocol: 'bugfix',
      spawnedByArchitect: null,
    });
  });

  it('handles PIR projects', () => {
    expect(deriveBuilderInfo(makeState({ id: '0829', protocol: 'pir' }))).toEqual({
      builderId: 'builder-pir-829',
      issueArg: '829',
      cliProtocol: 'pir',
      spawnedByArchitect: null,
    });
  });

  it('handles ASPIR projects', () => {
    expect(deriveBuilderInfo(makeState({ id: '0438', protocol: 'aspir' }))).toEqual({
      builderId: 'builder-aspir-438',
      issueArg: '438',
      cliProtocol: 'aspir',
      spawnedByArchitect: null,
    });
  });

  it('handles AIR projects', () => {
    expect(deriveBuilderInfo(makeState({ id: '0501', protocol: 'air' }))).toEqual({
      builderId: 'builder-air-501',
      issueArg: '501',
      cliProtocol: 'air',
      spawnedByArchitect: null,
    });
  });

  describe('unsupported protocols return null', () => {
    it.each(['experiment', 'maintain', 'task', 'protocol', 'release', 'spider'])(
      'returns null for protocol: %s',
      (protocol) => {
        expect(deriveBuilderInfo(makeState({ protocol }))).toBeNull();
      },
    );
  });
});

describe('deriveBuilderInfoWithArchitect (Issue #1140)', () => {
  it('carries the recorded architect name through to BuilderInfo', () => {
    const info = deriveBuilderInfoWithArchitect(
      makeState({ id: '0087', protocol: 'spir' }),
      () => 'vscode',
    );
    expect(info).toEqual({
      builderId: 'builder-spir-87',
      issueArg: '87',
      cliProtocol: 'spir',
      spawnedByArchitect: 'vscode',
    });
  });

  it('passes the derived builderId to the lookup', () => {
    const seen: string[] = [];
    deriveBuilderInfoWithArchitect(makeState({ id: 'bugfix-693', protocol: 'bugfix' }), (id) => {
      seen.push(id);
      return 'main';
    });
    expect(seen).toEqual(['builder-bugfix-693']);
  });

  it('keeps null for legacy rows with a NULL spawned_by_architect column', () => {
    const info = deriveBuilderInfoWithArchitect(makeState(), () => null);
    expect(info?.spawnedByArchitect).toBeNull();
  });

  it('normalizes undefined (no builders row) to null', () => {
    const info = deriveBuilderInfoWithArchitect(makeState(), () => undefined);
    expect(info?.spawnedByArchitect).toBeNull();
  });

  it('preserves distinct attribution across builders in the same workspace', () => {
    const byBuilder: Record<string, string> = {
      'builder-spir-87': 'vscode',
      'builder-pir-829': 'main',
    };
    const a = deriveBuilderInfoWithArchitect(
      makeState({ id: '0087', protocol: 'spir' }),
      (id) => byBuilder[id],
    );
    const b = deriveBuilderInfoWithArchitect(
      makeState({ id: '0829', protocol: 'pir' }),
      (id) => byBuilder[id],
    );
    expect(a?.spawnedByArchitect).toBe('vscode');
    expect(b?.spawnedByArchitect).toBe('main');
  });

  it('returns null for unsupported protocols without invoking the lookup', () => {
    let called = false;
    const info = deriveBuilderInfoWithArchitect(makeState({ protocol: 'experiment' }), () => {
      called = true;
      return 'main';
    });
    expect(info).toBeNull();
    expect(called).toBe(false);
  });
});

describe('respawnEnv (Issue #1140)', () => {
  it('overrides an inherited CODEV_ARCHITECT_NAME with the recorded architect', () => {
    const env = respawnEnv('vscode', { CODEV_ARCHITECT_NAME: 'main', PATH: '/usr/bin' });
    expect(env.CODEV_ARCHITECT_NAME).toBe('vscode');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('sets CODEV_ARCHITECT_NAME even when the base env lacks it', () => {
    const env = respawnEnv('vscode', { PATH: '/usr/bin' });
    expect(env.CODEV_ARCHITECT_NAME).toBe('vscode');
  });

  it('does not mutate the base env when overriding', () => {
    const base = { CODEV_ARCHITECT_NAME: 'main' };
    respawnEnv('vscode', base);
    expect(base.CODEV_ARCHITECT_NAME).toBe('main');
  });

  it('passes the base env through unchanged when no architect was recorded', () => {
    const base = { CODEV_ARCHITECT_NAME: 'main', PATH: '/usr/bin' };
    expect(respawnEnv(null, base)).toBe(base);
  });

  it('does not invent CODEV_ARCHITECT_NAME for legacy rows when the base env lacks it', () => {
    const env = respawnEnv(null, { PATH: '/usr/bin' });
    expect('CODEV_ARCHITECT_NAME' in env).toBe(false);
  });
});

describe('resolveWorktreePath', () => {
  let tmp: string;
  let buildersDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'recover-test-'));
    buildersDir = join(tmp, '.builders');
    mkdirSync(buildersDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds ID-only worktree (Spec 653 layout)', () => {
    const wt = join(buildersDir, 'spir-87');
    mkdirSync(join(wt, '.git'), { recursive: true });
    const result = resolveWorktreePath(buildersDir, makeState({ id: '0087', protocol: 'spir' }));
    expect(result).toBe(wt);
  });

  it('falls back to legacy title-suffixed worktree', () => {
    const wt = join(buildersDir, 'spir-87-some-title-slug');
    mkdirSync(join(wt, '.git'), { recursive: true });
    const result = resolveWorktreePath(buildersDir, makeState({ id: '0087', protocol: 'spir' }));
    expect(result).toBe(wt);
  });

  it('returns null when no worktree matches', () => {
    const result = resolveWorktreePath(buildersDir, makeState({ id: '0087', protocol: 'spir' }));
    expect(result).toBeNull();
  });

  it('ignores directories with the right prefix but no .git', () => {
    mkdirSync(join(buildersDir, 'spir-87'), { recursive: true });
    const result = resolveWorktreePath(buildersDir, makeState({ id: '0087', protocol: 'spir' }));
    expect(result).toBeNull();
  });

  it('resolves bugfix worktree by issue number', () => {
    const wt = join(buildersDir, 'bugfix-693');
    mkdirSync(join(wt, '.git'), { recursive: true });
    const result = resolveWorktreePath(buildersDir, makeState({ id: 'bugfix-693', protocol: 'bugfix' }));
    expect(result).toBe(wt);
  });

  it('returns null for unsupported protocols without filesystem lookups', () => {
    // An experiment dir on disk would normally be found if the protocol were
    // supported — but for unsupported protocols we short-circuit to null.
    const wt = join(buildersDir, 'experiment-abcd');
    mkdirSync(join(wt, '.git'), { recursive: true });
    const result = resolveWorktreePath(buildersDir, makeState({ id: 'abcd', protocol: 'experiment' }));
    expect(result).toBeNull();
  });
});

describe('listAllProjects (precedence + diagnostics)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'recover-list-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeStatus(dir: string, state: Partial<ProjectState>): void {
    mkdirSync(dir, { recursive: true });
    const full = { ...makeState(state) };
    const yaml = [
      `id: '${full.id}'`,
      `title: '${full.title}'`,
      `protocol: ${full.protocol}`,
      `phase: ${full.phase}`,
      'plan_phases: []',
      'current_plan_phase: null',
      'gates: {}',
      `iteration: ${full.iteration}`,
      `build_complete: ${full.build_complete}`,
      'history: []',
      `started_at: '${full.started_at}'`,
      `updated_at: '${full.updated_at}'`,
    ].join('\n');
    writeFileSync(join(dir, 'status.yaml'), yaml + '\n', 'utf-8');
  }

  it('returns projects from codev/projects when no .builders copy exists', () => {
    writeStatus(join(tmp, 'codev', 'projects', '0087-foo'), { id: '0087', phase: 'implement' });
    const result = listAllProjects(tmp);
    expect(result).toHaveLength(1);
    expect(result[0].state.id).toBe('0087');
    expect(result[0].statusPath).toBe(join(tmp, 'codev', 'projects', '0087-foo', 'status.yaml'));
  });

  it('prefers .builders/ copy when same project id exists in both', () => {
    writeStatus(join(tmp, 'codev', 'projects', '0087-foo'), { id: '0087', phase: 'specify' });
    writeStatus(
      join(tmp, '.builders', 'spir-87', 'codev', 'projects', '0087-foo'),
      { id: '0087', phase: 'review' },
    );
    const result = listAllProjects(tmp);
    expect(result).toHaveLength(1);
    expect(result[0].state.phase).toBe('review');
    expect(result[0].statusPath).toContain('.builders');
  });

  it('returns empty array for a workspace with no projects', () => {
    expect(listAllProjects(tmp)).toEqual([]);
  });

  it('skips unparseable status.yaml files silently by default', () => {
    const dir = join(tmp, 'codev', 'projects', '0099-broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.yaml'), 'this is: not\n  valid:\nyaml: [\n', 'utf-8');
    writeStatus(join(tmp, 'codev', 'projects', '0087-foo'), { id: '0087' });
    const result = listAllProjects(tmp);
    expect(result).toHaveLength(1);
    expect(result[0].state.id).toBe('0087');
  });

  it('invokes onParseError callback when provided', () => {
    const dir = join(tmp, 'codev', 'projects', '0099-broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.yaml'), 'this is: not\n  valid:\nyaml: [\n', 'utf-8');
    const errors: Array<{ path: string; err: unknown }> = [];
    const result = listAllProjects(tmp, {
      onParseError: (path, err) => errors.push({ path, err }),
    });
    expect(result).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(join(dir, 'status.yaml'));
    expect(errors[0].err).toBeInstanceOf(Error);
  });
});

describe('formatRelativeAge', () => {
  it('formats minutes', () => {
    const iso = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(formatRelativeAge(iso)).toMatch(/^\d+m ago$/);
  });

  it('formats hours', () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRelativeAge(iso)).toMatch(/^\d+h ago$/);
  });

  it('formats days', () => {
    const iso = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(formatRelativeAge(iso)).toMatch(/^\d+d ago$/);
  });

  it('rounds days UP so the label aligns with --max-age (25h shows 2d, not 1d)', () => {
    const iso = new Date(Date.now() - 25 * 3600_000).toISOString();
    expect(formatRelativeAge(iso)).toBe('2d ago');
  });

  it('rounds 47h up to 2d (still within the ceil(2) bucket)', () => {
    const iso = new Date(Date.now() - 47 * 3600_000).toISOString();
    expect(formatRelativeAge(iso)).toBe('2d ago');
  });

  it('shows "2d ago" rather than "1d ago" for anything strictly older than 24h', () => {
    // Just past the boundary — ensures the predicate boundary
    // (`ageDays > maxAge`) matches what the label promises.
    const iso = new Date(Date.now() - (24 * 3600_000 + 1_000)).toISOString();
    expect(formatRelativeAge(iso)).toBe('2d ago');
  });

  it('returns placeholder for malformed ISO', () => {
    expect(formatRelativeAge('not a date')).toBe('—');
  });
});
