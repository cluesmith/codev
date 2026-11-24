/**
 * Regression tests for issue #1853: a failed check printed the FIRST five lines
 * of its stderr — npm's config warnings, for the tests check — and kept nothing,
 * so the failing test was never named and a passing retry erased the evidence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  runPhaseChecks,
  formatCheckResults,
  MAX_CHECK_LOGS,
  type CheckEnv,
  type CheckLogTarget,
} from '../checks.js';
import { loadProtocol, getPhaseChecks } from '../protocol.js';

const env: CheckEnv = { PROJECT_ID: '1853', PROJECT_TITLE: 'check-output' };

// Single spaces only: the POSIX launcher collapses runs of whitespace in a check's command.
const FAILURE = 'FAIL src/thing.test.ts > thing > the named failing test';
const SUMMARY = 'Tests 1 failed | 41 passed (42)';

/**
 * Shaped like `npm test` under vitest: a stdout banner, 50 warnings on stderr,
 * then the failure block (stderr) and the summary (stdout).
 */
const NOISY_FAILING_CHECK = [
  'echo "> vitest run"',
  'for i in $(seq 1 50); do echo "npm warn Unknown env config $i" >&2; done',
  `echo "${FAILURE}" >&2`,
  `echo "${SUMMARY}"`,
  'exit 1',
].join('; ');

function logFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort() : [];
}

describe('bugfix #1853: a failed check names its failure and keeps its full output', () => {
  let root: string;
  let target: CheckLogTarget;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'porch-1853-'));
    target = { dir: path.join(root, 'codev/projects/1853-check-output/checks'), phase: 'implement-phase_2' };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prints the end of the output, where the failure is, and the path to the full log', async () => {
    const results = await runPhaseChecks({ tests: NOISY_FAILING_CHECK }, root, env, undefined, undefined, undefined, target);
    const printed = formatCheckResults(results);

    expect(results[0].passed).toBe(false);
    expect(printed).toContain(FAILURE);
    expect(printed).toContain(SUMMARY);
    expect(printed).not.toContain('npm warn Unknown env config 1\n');
    expect(printed).toContain('earlier lines');
    expect(printed).toContain(`Full output: ${results[0].log_path}`);
  });

  it('the log holds the complete stdout and stderr', async () => {
    const [result] = await runPhaseChecks({ tests: NOISY_FAILING_CHECK }, root, env, undefined, undefined, undefined, target);

    expect(path.dirname(result.log_path!)).toBe(target.dir);
    expect(path.basename(result.log_path!)).toMatch(/^\d{4}-\d\d-\d\dT[\d-]+Z-implement-phase_2-tests\.log$/);
    const log = fs.readFileSync(result.log_path!, 'utf-8');
    for (let i = 1; i <= 50; i++) expect(log).toContain(`npm warn Unknown env config ${i}\n`);
    expect(log).toContain('> vitest run');
    expect(log).toContain(FAILURE);
    expect(log).toContain(SUMMARY);
    expect(log).toContain(`command:  ${NOISY_FAILING_CHECK}\n`);
    expect(log).toContain('result:   Exit code 1');
  });

  it('a passing check writes nothing', async () => {
    const results = await runPhaseChecks({ build: 'echo ok' }, root, env, undefined, undefined, undefined, target);

    expect(results[0].passed).toBe(true);
    expect(results[0].log_path).toBeUndefined();
    expect(fs.existsSync(target.dir)).toBe(false);
  });

  it('a check killed at its timeout still saves what it printed', async () => {
    const [result] = await runPhaseChecks(
      { tests: { command: 'echo "printed before the hang"; sleep 30', timeout_ms: 300 } },
      root, env, undefined, undefined, undefined, target,
    );
    const printed = formatCheckResults([result]);

    expect(result.error).toContain('Timed out after 0.3s');
    expect(printed).toContain('Timed out after 0.3s');
    expect(printed).toContain('printed before the hang');
    expect(printed).toContain(`Full output: ${result.log_path}`);
    const log = fs.readFileSync(result.log_path!, 'utf-8');
    expect(log).toContain('printed before the hang');
    expect(log).toContain('result:   Timed out after 0.3s');
  }, 45_000);

  it('a porch.checks override that fails is saved like the protocol command', async () => {
    const dir = path.join(root, 'codev/protocols/p1853');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify({
      name: 'p1853', phases: [{ id: 'implement', checks: { tests: { command: 'true' } } }],
    }));
    const checks = getPhaseChecks(loadProtocol(root, 'p1853'), 'implement', {
      tests: { command: 'echo "override output"; exit 3' },
    });

    const [result] = await runPhaseChecks(checks, root, env, undefined, undefined, undefined, target);

    expect(result.passed).toBe(false);
    expect(fs.readFileSync(result.log_path!, 'utf-8')).toContain('override output');
  });

  it('keeps only the newest logs, and git never sees them', async () => {
    fs.mkdirSync(target.dir, { recursive: true });
    const old = Array.from({ length: MAX_CHECK_LOGS + 5 }, (_, i) =>
      `2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z-implement-tests.log`);
    for (const name of old) fs.writeFileSync(path.join(target.dir, name), 'old run');

    const [result] = await runPhaseChecks({ tests: 'exit 1' }, root, env, undefined, undefined, undefined, target);

    const kept = logFiles(target.dir);
    expect(kept).toHaveLength(MAX_CHECK_LOGS);
    expect(kept).toContain(path.basename(result.log_path!));
    expect(kept).not.toContain(old[5]);
    expect(kept).toContain(old[6]);

    execFileSync('git', ['init', '-q'], { cwd: root });
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf-8' });
    expect(status).not.toContain('checks/');
  });

  it('a log that cannot be written is reported, and the failure is still printed', async () => {
    fs.mkdirSync(path.dirname(target.dir), { recursive: true });
    fs.writeFileSync(target.dir, 'a file where the checks directory should be');

    const [result] = await runPhaseChecks({ tests: NOISY_FAILING_CHECK }, root, env, undefined, undefined, undefined, target);
    const printed = formatCheckResults([result]);

    expect(result.log_path).toBeUndefined();
    expect(printed).toContain(FAILURE);
    expect(printed).toMatch(/Full output could not be saved: .+/);
  });
});
