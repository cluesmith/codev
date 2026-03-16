/**
 * Unit tests for lib/forge.ts — forge concept command dispatcher.
 *
 * Tests: command resolution, config loading, concept execution with mock
 * scripts, validation, and edge cases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getForgeCommand,
  isConceptDisabled,
  executeForgeCommand,
  executeForgeCommandSync,
  getKnownConcepts,
  getKnownProviders,
  getDefaultCommand,
  validateForgeConfig,
  loadForgeConfig,
  resolveAllConcepts,
} from '../lib/forge.js';

// =============================================================================
// Test fixtures: mock scripts for deterministic execution tests
// =============================================================================

const TEST_DIR = join(tmpdir(), `forge-test-${process.pid}`);
const MOCK_SCRIPTS_DIR = join(TEST_DIR, 'scripts');

beforeAll(() => {
  mkdirSync(MOCK_SCRIPTS_DIR, { recursive: true });

  // Script that outputs valid JSON
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'json-output.sh'),
    '#!/bin/sh\necho \'{"title":"Test Issue","state":"open"}\'\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'json-output.sh'), 0o755);

  // Script that outputs a JSON array
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'json-array.sh'),
    '#!/bin/sh\necho \'[{"number":1,"title":"PR One"},{"number":2,"title":"PR Two"}]\'\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'json-array.sh'), 0o755);

  // Script that outputs plain text (not JSON)
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'text-output.sh'),
    '#!/bin/sh\necho "nharward"\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'text-output.sh'), 0o755);

  // Script that outputs nothing (empty stdout)
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'empty-output.sh'),
    '#!/bin/sh\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'empty-output.sh'), 0o755);

  // Script that exits with non-zero
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'fail.sh'),
    '#!/bin/sh\nexit 1\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'fail.sh'), 0o755);

  // Script that echoes a CODEV_* env var as JSON
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'echo-env.sh'),
    '#!/bin/sh\necho "{\\"issue_id\\": \\"$CODEV_ISSUE_ID\\", \\"branch\\": \\"$CODEV_BRANCH_NAME\\"}"\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'echo-env.sh'), 0o755);

  // Script that outputs invalid JSON
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'invalid-json.sh'),
    '#!/bin/sh\necho "not valid json {"\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'invalid-json.sh'), 0o755);

  // Script that outputs raw diff text
  writeFileSync(join(MOCK_SCRIPTS_DIR, 'diff-output.sh'),
    '#!/bin/sh\necho "diff --git a/file.ts b/file.ts"\necho "--- a/file.ts"\necho "+++ b/file.ts"\n');
  chmodSync(join(MOCK_SCRIPTS_DIR, 'diff-output.sh'), 0o755);

  // af-config.json with forge overrides
  writeFileSync(join(TEST_DIR, 'af-config.json'), JSON.stringify({
    forge: {
      'issue-view': join(MOCK_SCRIPTS_DIR, 'json-output.sh'),
      'pr-list': join(MOCK_SCRIPTS_DIR, 'json-array.sh'),
      'user-identity': join(MOCK_SCRIPTS_DIR, 'text-output.sh'),
      'team-activity': null,
      'pr-diff': join(MOCK_SCRIPTS_DIR, 'diff-output.sh'),
    },
  }));
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// =============================================================================
// Command resolution
// =============================================================================

describe('getForgeCommand', () => {
  it('returns default script path when no config provided', () => {
    const cmd = getForgeCommand('issue-view');
    expect(cmd).toContain('scripts/forge/github/issue-view.sh');
  });

  it('returns default script path when config has no override for concept', () => {
    const config = { 'pr-list': 'custom-pr-list' };
    const cmd = getForgeCommand('issue-view', config);
    expect(cmd).toContain('scripts/forge/github/issue-view.sh');
  });

  it('returns user override when configured', () => {
    const config = { 'issue-view': 'glab issue show $CODEV_ISSUE_ID --json' };
    const cmd = getForgeCommand('issue-view', config);
    expect(cmd).toBe('glab issue show $CODEV_ISSUE_ID --json');
  });

  it('returns null when concept is explicitly disabled', () => {
    const config = { 'issue-comment': null };
    const cmd = getForgeCommand('issue-comment', config);
    expect(cmd).toBeNull();
  });

  it('returns null for unknown concept with no default', () => {
    const cmd = getForgeCommand('nonexistent-concept');
    expect(cmd).toBeNull();
  });

  it('returns null for unknown concept even with unrelated config', () => {
    const config = { 'pr-list': 'custom' };
    const cmd = getForgeCommand('nonexistent-concept', config);
    expect(cmd).toBeNull();
  });
});

describe('isConceptDisabled', () => {
  it('returns false when no config provided', () => {
    expect(isConceptDisabled('issue-view')).toBe(false);
  });

  it('returns false when concept is not in config', () => {
    expect(isConceptDisabled('issue-view', { 'pr-list': 'custom' })).toBe(false);
  });

  it('returns true when concept is set to null', () => {
    expect(isConceptDisabled('team-activity', { 'team-activity': null })).toBe(true);
  });

  it('returns false when concept has a command string', () => {
    expect(isConceptDisabled('pr-list', { 'pr-list': 'custom' })).toBe(false);
  });
});

// =============================================================================
// Async execution with mock scripts
// =============================================================================

describe('executeForgeCommand', () => {
  it('parses valid JSON output from concept command', async () => {
    const result = await executeForgeCommand('issue-view', {}, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'json-output.sh') },
    });
    expect(result).toEqual({ title: 'Test Issue', state: 'open' });
  });

  it('parses JSON array output', async () => {
    const result = await executeForgeCommand('pr-list', {}, {
      forgeConfig: { 'pr-list': join(MOCK_SCRIPTS_DIR, 'json-array.sh') },
    });
    expect(result).toEqual([
      { number: 1, title: 'PR One' },
      { number: 2, title: 'PR Two' },
    ]);
  });

  it('returns null for non-JSON output when raw=false', async () => {
    const result = await executeForgeCommand('user-identity', {}, {
      forgeConfig: { 'user-identity': join(MOCK_SCRIPTS_DIR, 'text-output.sh') },
    });
    expect(result).toBeNull();
  });

  it('returns raw string for non-JSON output when raw=true', async () => {
    const result = await executeForgeCommand('user-identity', {}, {
      forgeConfig: { 'user-identity': join(MOCK_SCRIPTS_DIR, 'text-output.sh') },
      raw: true,
    });
    expect(result).toBe('nharward');
  });

  it('returns null for empty stdout', async () => {
    const result = await executeForgeCommand('issue-view', {}, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'empty-output.sh') },
    });
    expect(result).toBeNull();
  });

  it('returns null on non-zero exit code', async () => {
    const result = await executeForgeCommand('issue-view', {}, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'fail.sh') },
    });
    expect(result).toBeNull();
  });

  it('returns null for disabled concepts without executing', async () => {
    const result = await executeForgeCommand('team-activity', {}, {
      forgeConfig: { 'team-activity': null },
    });
    expect(result).toBeNull();
  });

  it('returns null for unknown concepts', async () => {
    const result = await executeForgeCommand('nonexistent-concept', {});
    expect(result).toBeNull();
  });

  it('passes CODEV_* environment variables to the command', async () => {
    const result = await executeForgeCommand('issue-view', {
      CODEV_ISSUE_ID: 'PROJ-42',
      CODEV_BRANCH_NAME: 'feature/foo',
    }, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'echo-env.sh') },
    }) as { issue_id: string; branch: string };

    expect(result).toBeTruthy();
    expect(result.issue_id).toBe('PROJ-42');
    expect(result.branch).toBe('feature/foo');
  });

  it('returns null for invalid JSON when not in raw mode', async () => {
    const result = await executeForgeCommand('issue-view', {}, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'invalid-json.sh') },
    });
    // Invalid JSON returns null (not raw string) to prevent downstream cast errors
    expect(result).toBeNull();
  });

  it('returns raw string when raw option is true', async () => {
    const result = await executeForgeCommand('pr-diff', {}, {
      forgeConfig: { 'pr-diff': join(MOCK_SCRIPTS_DIR, 'diff-output.sh') },
      raw: true,
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('diff --git');
  });

  it('loads forge config from workspaceRoot af-config.json', async () => {
    const result = await executeForgeCommand('issue-view', {}, {
      workspaceRoot: TEST_DIR,
    });
    expect(result).toEqual({ title: 'Test Issue', state: 'open' });
  });

  it('prefers explicit forgeConfig over workspaceRoot loading', async () => {
    const result = await executeForgeCommand('issue-view', {}, {
      workspaceRoot: TEST_DIR,
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'json-array.sh') },
    });
    // Should use the explicit config (array output), not the workspaceRoot config (object output)
    expect(Array.isArray(result)).toBe(true);
  });
});

// =============================================================================
// Sync execution with mock scripts
// =============================================================================

describe('executeForgeCommandSync', () => {
  it('parses valid JSON output', () => {
    const result = executeForgeCommandSync('issue-view', {}, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'json-output.sh') },
    });
    expect(result).toEqual({ title: 'Test Issue', state: 'open' });
  });

  it('returns null for unknown concepts', () => {
    const result = executeForgeCommandSync('nonexistent-concept', {});
    expect(result).toBeNull();
  });

  it('returns null on non-zero exit code', () => {
    const result = executeForgeCommandSync('issue-view', {}, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'fail.sh') },
    });
    expect(result).toBeNull();
  });

  it('passes environment variables', () => {
    const result = executeForgeCommandSync('issue-view', {
      CODEV_ISSUE_ID: 'TEST-99',
    }, {
      forgeConfig: { 'issue-view': join(MOCK_SCRIPTS_DIR, 'echo-env.sh') },
    }) as { issue_id: string };

    expect(result).toBeTruthy();
    expect(result.issue_id).toBe('TEST-99');
  });

  it('returns raw string when raw option is true', () => {
    const result = executeForgeCommandSync('pr-diff', {}, {
      forgeConfig: { 'pr-diff': join(MOCK_SCRIPTS_DIR, 'diff-output.sh') },
      raw: true,
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('diff --git');
  });
});

// =============================================================================
// Known concepts
// =============================================================================

describe('getKnownConcepts', () => {
  it('returns all 15 known concept names', () => {
    const concepts = getKnownConcepts();
    expect(concepts).toContain('issue-view');
    expect(concepts).toContain('pr-list');
    expect(concepts).toContain('issue-list');
    expect(concepts).toContain('issue-comment');
    expect(concepts).toContain('pr-exists');
    expect(concepts).toContain('recently-closed');
    expect(concepts).toContain('recently-merged');
    expect(concepts).toContain('user-identity');
    expect(concepts).toContain('team-activity');
    expect(concepts).toContain('on-it-timestamps');
    expect(concepts).toContain('pr-merge');
    expect(concepts).toContain('pr-search');
    expect(concepts).toContain('pr-view');
    expect(concepts).toContain('pr-diff');
    expect(concepts).toContain('auth-status');
    expect(concepts.length).toBe(15);
  });
});

describe('getDefaultCommand', () => {
  it('returns the on-disk script path for a known concept', () => {
    const cmd = getDefaultCommand('issue-view');
    expect(cmd).toContain('scripts/forge/github/issue-view.sh');
  });

  it('returns the on-disk script path for recently-closed', () => {
    const cmd = getDefaultCommand('recently-closed');
    expect(cmd).toContain('scripts/forge/github/recently-closed.sh');
  });

  it('returns the on-disk script path for recently-merged', () => {
    const cmd = getDefaultCommand('recently-merged');
    expect(cmd).toContain('scripts/forge/github/recently-merged.sh');
  });

  it('returns null for unknown concepts', () => {
    expect(getDefaultCommand('nonexistent')).toBeNull();
  });
});

// =============================================================================
// Config validation (for codev doctor)
// =============================================================================

describe('validateForgeConfig', () => {
  it('reports OK for valid overrides of known concepts', () => {
    const results = validateForgeConfig({ 'pr-list': 'glab mr list --json id,title' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    expect(results[0].concept).toBe('pr-list');
  });

  it('reports disabled for null concepts', () => {
    const results = validateForgeConfig({ 'team-activity': null, 'on-it-timestamps': null });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'disabled')).toBe(true);
  });

  it('reports unknown_concept for unrecognized concept names', () => {
    const results = validateForgeConfig({ 'made-up-concept': 'some command' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('unknown_concept');
  });

  it('reports empty_command for empty string commands', () => {
    const results = validateForgeConfig({ 'pr-list': '' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('empty_command');
  });

  it('handles mixed config with multiple statuses', () => {
    const results = validateForgeConfig({
      'pr-list': 'glab mr list',
      'team-activity': null,
      'unknown-thing': 'command',
      'issue-comment': '',
    });
    expect(results).toHaveLength(4);
    const statuses = results.map(r => r.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('disabled');
    expect(statuses).toContain('unknown_concept');
    expect(statuses).toContain('empty_command');
  });
});

// =============================================================================
// Config loading
// =============================================================================

describe('loadForgeConfig', () => {
  it('returns null when no af-config.json exists', () => {
    expect(loadForgeConfig('/nonexistent/path')).toBeNull();
  });

  it('returns forge section from af-config.json', () => {
    const config = loadForgeConfig(TEST_DIR);
    expect(config).toBeTruthy();
    expect(config!['team-activity']).toBeNull();
    expect(config!['issue-view']).toContain('json-output.sh');
  });

  it('returns null when af-config.json has no forge section', () => {
    // Create a temp config without forge section
    const noForgeDir = join(TEST_DIR, 'no-forge');
    mkdirSync(noForgeDir, { recursive: true });
    writeFileSync(join(noForgeDir, 'af-config.json'), JSON.stringify({ shell: {} }));
    expect(loadForgeConfig(noForgeDir)).toBeNull();
    rmSync(noForgeDir, { recursive: true, force: true });
  });
});

// =============================================================================
// Provider presets
// =============================================================================

describe('provider presets', () => {
  it('returns known providers', () => {
    const providers = getKnownProviders();
    expect(providers).toContain('github');
    expect(providers).toContain('gitlab');
    expect(providers).toContain('gitea');
  });

  it('uses provider preset when no manual override', () => {
    const config = { provider: 'gitlab' };
    const cmd = getForgeCommand('pr-merge', config);
    expect(cmd).toContain('scripts/forge/gitlab/pr-merge.sh');
  });

  it('manual override takes precedence over provider preset', () => {
    const config = { provider: 'gitlab', 'pr-merge': 'my-custom-merge $CODEV_PR_NUMBER' };
    const cmd = getForgeCommand('pr-merge', config);
    expect(cmd).toBe('my-custom-merge $CODEV_PR_NUMBER');
  });

  it('falls back to default when provider does not define concept', () => {
    // github preset uses on-disk scripts, same as defaults
    const config = { provider: 'github' };
    const cmd = getForgeCommand('issue-view', config);
    expect(cmd).toContain('scripts/forge/github/issue-view.sh');
  });

  it('returns null for concepts disabled in provider preset', () => {
    const config = { provider: 'gitlab' };
    // team-activity is null in gitlab preset
    const cmd = getForgeCommand('team-activity', config);
    expect(cmd).toBeNull();
  });

  it('validates unknown provider', () => {
    const results = validateForgeConfig({ provider: 'bitbucket' });
    expect(results[0].status).toBe('unknown_concept');
    expect(results[0].message).toContain('bitbucket');
  });

  it('validates known provider', () => {
    const results = validateForgeConfig({ provider: 'gitlab' });
    expect(results[0].status).toBe('provider');
    expect(results[0].message).toContain('gitlab');
  });
});

// =============================================================================
// Graceful degradation (no gh CLI)
// =============================================================================

describe('graceful degradation when command not found', () => {
  it('executeForgeCommand returns null when command fails', async () => {
    // Use a command that doesn't exist — simulates "no gh installed"
    const result = await executeForgeCommand('issue-view', {
      CODEV_ISSUE_ID: '42',
    }, {
      forgeConfig: { 'issue-view': 'nonexistent-cli-tool-that-does-not-exist view 42' },
    });
    expect(result).toBeNull();
  });

  it('executeForgeCommandSync returns null when command fails', () => {
    const result = executeForgeCommandSync('issue-view', {
      CODEV_ISSUE_ID: '42',
    }, {
      forgeConfig: { 'issue-view': 'nonexistent-cli-tool-that-does-not-exist view 42' },
    });
    expect(result).toBeNull();
  });

  it('disabled concepts return null immediately without executing', async () => {
    const result = await executeForgeCommand('team-activity', {}, {
      forgeConfig: { 'team-activity': null },
    });
    expect(result).toBeNull();
  });
});

// =============================================================================
// resolveAllConcepts (for codev doctor full reporting)
// =============================================================================

describe('resolveAllConcepts', () => {
  it('returns all 15 concepts with default source when no config', () => {
    const resolutions = resolveAllConcepts();
    expect(resolutions).toHaveLength(15);
    expect(resolutions.every(r => r.source === 'default')).toBe(true);
    expect(resolutions.every(r => r.executable !== null)).toBe(true);
  });

  it('marks overridden concepts as override source', () => {
    const config = { 'pr-list': 'my-custom-pr-list' };
    const resolutions = resolveAllConcepts(config);
    const prList = resolutions.find(r => r.concept === 'pr-list');
    expect(prList?.source).toBe('override');
    expect(prList?.executable).toBe('my-custom-pr-list');
  });

  it('marks disabled concepts correctly', () => {
    const config = { 'team-activity': null };
    const resolutions = resolveAllConcepts(config);
    const teamActivity = resolutions.find(r => r.concept === 'team-activity');
    expect(teamActivity?.source).toBe('disabled');
    expect(teamActivity?.command).toBeNull();
  });

  it('marks preset concepts when provider is set', () => {
    const config = { provider: 'gitlab' };
    const resolutions = resolveAllConcepts(config);
    const prMerge = resolutions.find(r => r.concept === 'pr-merge');
    expect(prMerge?.source).toBe('preset');
    expect(prMerge?.executable).toBe('glab');
  });

  it('marks preset-disabled concepts as disabled', () => {
    const config = { provider: 'gitlab' };
    const resolutions = resolveAllConcepts(config);
    const teamActivity = resolutions.find(r => r.concept === 'team-activity');
    expect(teamActivity?.source).toBe('disabled');
  });

  it('override takes precedence over preset', () => {
    const config = { provider: 'gitlab', 'pr-merge': 'my-merge-cmd' };
    const resolutions = resolveAllConcepts(config);
    const prMerge = resolutions.find(r => r.concept === 'pr-merge');
    expect(prMerge?.source).toBe('override');
    expect(prMerge?.command).toBe('my-merge-cmd');
  });

  it('extracts executable from shell conditionals', () => {
    const resolutions = resolveAllConcepts();
    const recentlyClosed = resolutions.find(r => r.concept === 'recently-closed');
    // Default command is: if [ -n "$CODEV_SINCE_DATE" ]; then gh issue list ...
    expect(recentlyClosed?.executable).toBe('gh');
  });
});
