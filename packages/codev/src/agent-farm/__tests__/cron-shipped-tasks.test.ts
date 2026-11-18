// Issue #1921: the cron tasks we ship (our .af-cron/ci-health.yaml and the skeleton's
// ci-health.yaml.example) must parse under the platform shell Tower runs them in, and a
// failed run must never be reported as a CI failure.
//
// Tower runs a task command with child_process.exec — cmd.exe on Windows, /bin/sh
// elsewhere. cmd.exe does not treat single quotes as quotes, so a single-quoted jq
// expression containing `|` was split into a pipe, the command failed, and the
// `output != ''` condition reported the error text as "currently failing on main".
//
// This runs each shipped command for real through exec, with `gh` swapped for a stub
// that echoes the --jq argument it received, and checks each condition against a
// failed run.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceTasks, evaluateCondition, type CronTask } from '../servers/tower-cron.js';

const repoRoot = resolve(__dirname, '../../../../..');

let tmp: string;
let stubGh: string;

function loadTask(workspacePath: string, name: string): CronTask {
  const task = loadWorkspaceTasks(workspacePath).find(t => t.name === name);
  if (!task) throw new Error(`task '${name}' not found in ${workspacePath}`);
  return task;
}

/** Run the task's command through the real platform shell, with `gh` replaced by the stub. */
function jqArgumentReceived(task: CronTask): Promise<string> {
  expect(task.command.startsWith('gh ')).toBe(true);
  const command = `"${process.execPath}" "${stubGh}" ${task.command.slice('gh '.length)}`;
  return new Promise((resolvePromise, reject) => {
    exec(command, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`command failed (${error.code}): ${stderr || stdout}`));
      else resolvePromise(stdout);
    });
  });
}

// What cmd.exe printed for the old single-quoted command, with its exit code.
const SHELL_ERROR = "'map' is not recognized as an internal or external command,\noperable program or batch file.";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cron-1921-'));
  stubGh = join(tmp, 'gh-stub.cjs');
  writeFileSync(
    stubGh,
    "const i = process.argv.indexOf('--jq'); process.stdout.write(i < 0 ? '<no --jq>' : process.argv[i + 1]);\n",
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('shipped .af-cron/ci-health.yaml (#1921)', () => {
  const task = () => loadTask(repoRoot, 'CI Health Check');

  it('passes the jq expression to gh intact under the platform shell', async () => {
    expect(await jqArgumentReceived(task())).toBe(
      'group_by(.workflowName) | map(.[0]) | map(select(.conclusion == "failure")) | map(.workflowName) | join(", ")',
    );
  });

  it('alerts only for a clean run that names failing workflows', () => {
    const { condition } = task();
    expect(condition).toBeDefined();
    expect(evaluateCondition(condition!, 'Tests, Windows', 0)).toBe(true);
    expect(evaluateCondition(condition!, '', 0)).toBe(false);
    expect(evaluateCondition(condition!, SHELL_ERROR, 255)).toBe(false);
    expect(evaluateCondition(condition!, 'gh: command not found', 127)).toBe(false);
  });
});

describe('skeleton .af-cron/ci-health.yaml.example (#1921)', () => {
  const task = () => {
    const ws = join(tmp, 'skeleton-ws');
    mkdirSync(join(ws, '.af-cron'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'codev-skeleton', '.af-cron', 'ci-health.yaml.example'),
      join(ws, '.af-cron', 'ci-health.yaml'),
    );
    return loadTask(ws, 'CI Health Check');
  };

  it('passes the jq expression to gh intact under the platform shell', async () => {
    expect(await jqArgumentReceived(task())).toBe('[.[] | select(.conclusion == "failure")] | length');
  });

  it('alerts only for a clean run with a non-zero failure count', () => {
    const { condition } = task();
    expect(condition).toBeDefined();
    expect(evaluateCondition(condition!, '2', 0)).toBe(true);
    expect(evaluateCondition(condition!, '0', 0)).toBe(false);
    expect(evaluateCondition(condition!, SHELL_ERROR, 255)).toBe(false);
  });
});
