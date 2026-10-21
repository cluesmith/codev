/**
 * Spec 1658 Phase 6, native Windows only (the on-demand `windows.yml` targeted
 * job runs it against the built checkout; it skips everywhere else). Launcher
 * routing on a real runner, no fakes:
 *
 * - Read-only GitHub concepts run live through Git Bash, including a
 *   slash-prefixed `gh api /repos/...` argument (scenario 8).
 * - `afx tower start` reaches ready and the architect terminal runs its harness
 *   (an npm-style `.cmd` stub, so shim resolution is exercised); `afx shell`
 *   opens Windows PowerShell (scenario 3).
 * - `afx spawn --worktree` creates a builder whose launch script runs under Git
 *   Bash, after a multi-command `postSpawn` hook (scenarios 9 and 10); a CRLF
 *   hook either runs or fails naming the hook, and doctor flags it.
 * - porch runs shell-string checks through Git Bash and drives a BUGFIX project
 *   through a phase transition.
 * - `afx dev` teardown leaves no dev-server process (scenario 6).
 *
 * The CLI commands under test talk to the default Tower port, so this file's
 * Tower uses 4100 with an isolated state directory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { executeForgeCommand, executeForgeCommandDetailed } from '../lib/forge.js';
import { resolveGitBash } from '../lib/git-bash.js';
import { runPostSpawnHooks } from '../agent-farm/commands/spawn-worktree.js';
import { findCrlfHookScripts } from '../commands/doctor.js';
import { killSessionTree } from '../lib/process-tree.js';

const onWindows = process.platform === 'win32';
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const afx = fileURLToPath(new URL('../../bin/afx.js', import.meta.url));
const porch = fileURLToPath(new URL('../../bin/porch.js', import.meta.url));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-p6-'));
const binDir = path.join(workDir, 'bin');
const workspace = path.join(workDir, 'ws');
const stateDir = path.join(workDir, 'state');
const leftovers: number[] = [];

const env: NodeJS.ProcessEnv = {
  ...process.env,
  CODEV_AGENT_FARM_DIR: stateDir,
  SHELLPER_SOCKET_DIR: path.join(stateDir, 'run'),
  PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
};
delete env.CODEV_SHELLPER_SESSION;
// vitest sets NODE_ENV=test, which would point the daemon at test.db.
delete env.NODE_ENV;
delete env.AF_TEST_DB;

function run(file: string, args: string[], cwd: string): { code: number | null; output: string } {
  const r = spawnSync(process.execPath, [file, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const key = fs.readFileSync(path.join(stateDir, 'local-key'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: 4100, path: urlPath, method, timeout: 60_000, headers: { [TOWER_KEY_HEADER]: key, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // Not JSON
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

interface TerminalRow {
  id: string;
  type: string;
  role_id: string | null;
  command: string | null;
  shellper_pid: number | null;
}

function terminalRows(): TerminalRow[] {
  const db = new Database(path.join(stateDir, 'global.db'), { readonly: true });
  try {
    return db.prepare('SELECT id, type, role_id, command, shellper_pid FROM terminal_sessions').all() as TerminalRow[];
  } finally {
    db.close();
  }
}

async function terminalOutput(terminalId: string): Promise<string> {
  const r = await api('GET', `/api/terminals/${terminalId}/output?lines=200`);
  if (r.status !== 200) return '';
  return JSON.stringify(r.json);
}

/**
 * The agent stub, installed the way npm installs a CLI: an npm-style `.cmd`
 * shim (which ConPTY cannot start without the shim resolver) beside an
 * extensionless sh shim (what Git Bash runs).
 */
function installAgentStub(): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'stub-agent.cjs'), `
process.stdout.write('AGENT-READY ' + process.pid + ' args=' + JSON.stringify(process.argv.slice(2)) + '\\r\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d.trim() + '\\r\\n'));
setInterval(() => {}, 1000);
`);
  fs.writeFileSync(path.join(binDir, 'stub-agent.cmd'), '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%" "%dp0%\\stub-agent.cjs" %*\r\n');
  fs.writeFileSync(path.join(binDir, 'stub-agent'), '#!/bin/sh\nexec node "$(dirname "$0")/stub-agent.cjs" "$@"\n');
}

const DEV_SERVER = `
const { spawn } = require('child_process');
const fs = require('fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync('dev-pids.json', JSON.stringify({ server: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`;

function createWorkspace(): void {
  fs.mkdirSync(path.join(workspace, 'codev'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
  git(['init', '-b', 'main'], workspace);
  git(['config', 'user.email', 'ci@example.invalid'], workspace);
  git(['config', 'user.name', 'CI'], workspace);
  git(['config', 'core.autocrlf', 'false'], workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Spec 1658 Phase 6 workspace\n');
  fs.writeFileSync(path.join(workspace, 'codev', '.keep'), '');
  fs.writeFileSync(path.join(workspace, 'dev-server.cjs'), DEV_SERVER);
  fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), JSON.stringify({
    shell: { architect: 'stub-agent', builder: 'stub-agent', shell: 'powershell.exe' },
    worktree: {
      symlinks: [],
      // Multi-command, bash-only syntax: && chains, redirects, $(...) and test.
      postSpawn: ['echo one > post-spawn.txt && echo two >> post-spawn.txt && test "$(wc -l < post-spawn.txt)" -eq 2'],
      devCommand: 'node dev-server.cjs',
    },
    porch: {
      checks: {
        build: { command: 'test -n "$PROJECT_ID" && echo "built-$PROJECT_ID"' },
        tests: { command: 'printf "a\\nb\\n" | grep -c b | grep -q 1' },
        regression_test: { skip: true },
      },
    },
  }, null, 2));
  git(['add', 'README.md', 'codev/.keep', 'dev-server.cjs', '.codev/config.json'], workspace);
  git(['commit', '-m', 'init'], workspace);
}

beforeAll(() => {
  if (!onWindows) return;
  installAgentStub();
  createWorkspace();
});

afterAll(() => {
  if (onWindows && fs.existsSync(path.join(stateDir, 'local-key'))) {
    run(afx, ['tower', 'stop'], workspace);
  }
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone
    }
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // A just-killed process may still hold a handle
  }
});

describe.skipIf(!onWindows)('Launcher routing on native Windows', () => {
  it('scenario 8: read-only GitHub concepts run live through Git Bash', async () => {
    if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
      console.log('FORGE-SKIP no GH_TOKEN or GITHUB_TOKEN on this runner');
      return;
    }
    const options = { cwd: repoRoot, forgeConfig: { provider: 'github' } };
    const issue = await executeForgeCommand('issue-view', { CODEV_ISSUE_ID: '1658' }, options) as { title?: string; url?: string } | null;
    expect(issue?.url).toContain('/issues/1658');
    const prs = await executeForgeCommand('pr-list', undefined, options);
    expect(Array.isArray(prs)).toBe(true);
    const issues = await executeForgeCommand('issue-list', undefined, options);
    expect(Array.isArray(issues)).toBe(true);

    // A slash-prefixed API path must reach gh unmangled (MSYS conversion off).
    const repo = await executeForgeCommandDetailed('pr-list', undefined, {
      cwd: repoRoot,
      raw: true,
      forgeConfig: { 'pr-list': 'gh api /repos/cluesmith/codev --jq .full_name' },
    });
    expect(repo.error, JSON.stringify(repo.error)).toBeNull();
    expect(String(repo.data).trim()).toBe('cluesmith/codev');
  }, 120_000);

  it('scenario 3: Tower reaches ready, the architect runs its .cmd harness, afx shell opens PowerShell', async () => {
    const start = run(afx, ['tower', 'start'], workspace);
    expect(start.code, start.output).toBe(0);

    const ws = run(afx, ['workspace', 'start', '--no-browser'], workspace);
    expect(ws.code, ws.output).toBe(0);
    let architect: TerminalRow | undefined;
    await waitFor(() => {
      architect = terminalRows().find((r) => r.type === 'architect');
      return architect !== undefined;
    }, 60_000, 'the architect terminal row');
    if (architect!.shellper_pid !== null) leftovers.push(architect!.shellper_pid);
    await waitFor(async () => (await terminalOutput(architect!.id)).includes('AGENT-READY'), 60_000, 'the architect harness banner');
    const banner = (await terminalOutput(architect!.id)).match(/AGENT-READY (\d+)/);
    leftovers.push(Number(banner![1]));

    const shell = run(afx, ['shell'], workspace);
    expect(shell.code, shell.output).toBe(0);
    let shellRow: TerminalRow | undefined;
    await waitFor(() => {
      shellRow = terminalRows().find((r) => r.type === 'shell');
      return shellRow !== undefined;
    }, 60_000, 'the shell terminal row');
    if (shellRow!.shellper_pid !== null) leftovers.push(shellRow!.shellper_pid);
    expect(shellRow!.command?.toLowerCase()).toMatch(/windowspowershell\\v1\.0\\powershell\.exe$/);
    await waitFor(async () => /PS [A-Za-z]:\\\\/.test(await terminalOutput(shellRow!.id)), 60_000, 'a PowerShell prompt');
  }, 300_000);

  it('scenarios 9 and 10: afx spawn --worktree runs postSpawn and the launch script under Git Bash', async () => {
    const gitBash = resolveGitBash();
    const spawned = run(afx, ['spawn', '--worktree'], workspace);
    expect(spawned.code, spawned.output).toBe(0);
    const builderId = spawned.output.match(/worktree-[a-z0-9]+/i)?.[0];
    expect(builderId, spawned.output).toBeDefined();
    const worktree = path.join(workspace, '.builders', builderId!);

    // The multi-command hook ran in the worktree.
    expect(fs.readFileSync(path.join(worktree, 'post-spawn.txt'), 'utf8').split(/\r?\n/).filter(Boolean)).toEqual(['one', 'two']);

    const script = fs.readFileSync(path.join(worktree, '.builder-start.sh'), 'utf8');
    expect(script).toMatch(/^#!\/bin\/bash\ncd "\/[a-z]\//);
    expect(script).toContain(`export CLAUDE_CODE_GIT_BASH_PATH='${gitBash.path}'`);

    let builder: TerminalRow | undefined;
    await waitFor(() => {
      builder = terminalRows().find((r) => r.role_id === builderId);
      return builder !== undefined;
    }, 60_000, 'the builder terminal row');
    if (builder!.shellper_pid !== null) leftovers.push(builder!.shellper_pid);
    expect(builder!.command?.toLowerCase()).toBe(gitBash.path.toLowerCase());
    await waitFor(async () => (await terminalOutput(builder!.id)).includes('AGENT-READY'), 60_000, 'the builder harness banner');
    expect(fs.readFileSync(path.join(worktree, '.builder-session-id'), 'utf8').trim()).toMatch(/^[0-9a-f-]{36}$/);
  }, 300_000);

  it('scenario 10 (CRLF): a CRLF hook either runs or fails naming itself, and doctor flags it', async () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'crlf-'));
    fs.writeFileSync(path.join(dir, 'crlf-hook.sh'), 'echo crlf-hook-ran\r\nexit 0\r\n');
    const hook = 'bash ./crlf-hook.sh';
    expect(findCrlfHookScripts([hook], dir)).toEqual(['crlf-hook.sh']);
    let outcome = 'ran';
    try {
      await runPostSpawnHooks(dir, [hook], workspace);
    } catch (err) {
      outcome = (err as Error).message;
    }
    console.log(`CRLF-HOOK outcome=${JSON.stringify(outcome)}`);
    if (outcome !== 'ran') {
      expect(outcome).toContain('crlf-hook.sh');
    }
  }, 60_000);

  it('porch: shell-string checks run in Git Bash and a BUGFIX project moves through a phase transition', () => {
    const init = run(porch, ['init', 'bugfix', '9001', 'windows-launchers'], workspace);
    expect(init.code, init.output).toBe(0);
    const toFix = run(porch, ['done', '9001'], workspace);
    expect(toFix.code, toFix.output).toBe(0);
    const status = run(porch, ['status', '9001'], workspace);
    expect(status.output).toMatch(/fix/);

    const check = run(porch, ['check', '9001'], workspace);
    expect(check.code, check.output).toBe(0);
    expect(check.output).toContain('ALL CHECKS PASSED');
  }, 300_000);

  it('scenario 6: afx dev teardown leaves no dev-server process', async () => {
    const pidsFile = path.join(workspace, 'dev-pids.json');
    fs.rmSync(pidsFile, { force: true });
    const started = run(afx, ['dev', 'main'], workspace);
    expect(started.code, started.output).toBe(0);
    await waitFor(() => fs.existsSync(pidsFile), 60_000, 'the dev server to start');
    const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as { server: number; child: number };
    leftovers.push(pids.server, pids.child);
    expect(alive(pids.server)).toBe(true);
    expect(alive(pids.child)).toBe(true);

    const terminals = await api('GET', '/api/terminals');
    console.log(`DEV-TERMINALS ${JSON.stringify(terminals.json)}`);
    const stopped = run(afx, ['dev', '--stop'], workspace);
    console.log(`DEV-STOP ${JSON.stringify(stopped.output)}`);
    expect(stopped.code, stopped.output).toBe(0);
    expect(stopped.output).toContain('Stopped dev server');
    try {
      await waitFor(() => !alive(pids.server) && !alive(pids.child), 30_000, 'the dev server tree to exit');
    } catch (err) {
      const log = fs.readFileSync(path.join(stateDir, 'tower.log'), 'utf8').split('\n').slice(-40).join('\n');
      const ancestry = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pids.server} OR ProcessId=${pids.child}" | ForEach-Object { "$($_.ProcessId) ppid=$($_.ParentProcessId) $($_.CommandLine)" }`],
      { encoding: 'utf8', windowsHide: true });
      console.log(`DEV-TOWER-LOG\n${log}\nalive server=${alive(pids.server)} child=${alive(pids.child)}\n${ancestry.stdout}`);
      throw err;
    }
  }, 300_000);

  it('cleans up the spawned sessions', async () => {
    for (const row of terminalRows()) {
      if (row.shellper_pid !== null) {
        await killSessionTree(row.shellper_pid).catch(() => undefined);
      }
    }
  }, 120_000);
});
