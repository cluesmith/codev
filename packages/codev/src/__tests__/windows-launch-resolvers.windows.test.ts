/**
 * Spec 1658 Phase 5, native Windows only (the on-demand `windows.yml` targeted
 * job runs it; it skips everywhere else). The Phase 5 resolvers against the
 * real runner, no fakes:
 *
 * - Git Bash resolves to Git for Windows, never System32, and doctor's
 *   Windows prerequisites report it and jq.
 * - `resolveSpawnable` output runs through `CreateProcess` (spawn without a
 *   shell) for an npm-style `.cmd` shim, a plain `.cmd`, and a real npm shim
 *   (`npx`), with arguments containing spaces and cmd metacharacters intact.
 * - MSYS translation round-trips a real directory through Git Bash.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, resolveSpawnable } from '@cluesmith/codev-sdk/node/executable';
import { resolveGitBash, isWslLauncher } from '../lib/git-bash.js';
import { toMsysPath, fromMsysPath, withoutMsysPathConversion } from '../lib/msys-path.js';
import { checkWindowsPrerequisites, windowsPrereqDeps } from '../commands/doctor.js';

const onWindows = process.platform === 'win32';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-p5-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Run a resolved command without a shell, as ConPTY and `spawn` do. */
function runSpawnable(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const spawnable = resolveSpawnable(command, args, { env });
  const result = spawnSync(spawnable.command, spawnable.args, {
    encoding: 'utf-8',
    env,
    windowsHide: true,
    windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
    timeout: 30_000,
  });
  return { spawnable, result };
}

describe.runIf(onWindows)('Phase 5 resolvers on a real Windows host', () => {
  it('resolves Git for Windows, not the WSL launcher', () => {
    const gitBash = resolveGitBash();
    expect(isWslLauncher(gitBash.path)).toBe(false);
    expect(gitBash.gitVersion).toMatch(/\.windows\./);
    const version = spawnSync(gitBash.path, ['--version'], { encoding: 'utf-8', windowsHide: true });
    expect(version.stdout).toMatch(/GNU bash/);
    expect(version.stdout).not.toMatch(/linux-gnu/);
  });

  it('doctor reports the runner Git Bash and jq', () => {
    const results = checkWindowsPrerequisites(windowsPrereqDeps(null, null));
    const gitBash = results.find((r) => r.name === 'Git Bash');
    const jq = results.find((r) => r.name === 'jq');
    expect(gitBash).toMatchObject({ status: 'ok' });
    expect(gitBash?.note?.toLowerCase()).toContain('\\git\\');
    expect(jq).toMatchObject({ status: 'ok' });
    expect(jq?.version).toMatch(/^\d+\.\d+/);
  });

  it('an npm-style .cmd shim becomes node.exe <entry> and runs', () => {
    const binDir = path.join(workDir, 'npm-bin');
    fs.mkdirSync(path.join(binDir, 'node_modules', 'fake-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'node_modules', 'fake-cli', 'cli.js'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    fs.writeFileSync(
      path.join(binDir, 'fakecli.cmd'),
      '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"node"  "%dp0%\\node_modules\\fake-cli\\cli.js" %*\r\n',
    );
    const env = { ...process.env, PATH: `${binDir};${process.env.PATH ?? ''}` };
    const args = ['plain', 'with space', 'a&b', '100%', 'quote"d'];
    const { spawnable, result } = runSpawnable('fakecli', args, env);
    expect(spawnable.command.toLowerCase()).toMatch(/node\.exe$/);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it('a plain .cmd runs through cmd.exe /d /s /c with arguments intact', () => {
    const binDir = path.join(workDir, 'cmd-bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'echoargs.cmd'), '@echo off\r\necho [%1][%2]\r\n');
    const env = { ...process.env, PATH: `${binDir};${process.env.PATH ?? ''}` };
    const { spawnable, result } = runSpawnable('echoargs', ['with space', 'x&y'], env);
    expect(spawnable.windowsVerbatimArguments).toBe(true);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('["with space"]["x&y"]');
  });

  it('a real npm shim (npx) resolves through PATHEXT and runs without a shell', () => {
    expect(findExecutable('npx')?.toLowerCase()).toMatch(/npx\.cmd$/);
    const { result } = runSpawnable('npx', ['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);
  });

  it('round-trips a real directory through Git Bash', () => {
    const dir = path.join(workDir, 'dir with space');
    fs.mkdirSync(dir, { recursive: true });
    const gitBash = resolveGitBash();
    const result = spawnSync(gitBash.path, ['-c', 'cd "$1" && pwd', '_', toMsysPath(dir)], {
      encoding: 'utf-8',
      windowsHide: true,
      env: withoutMsysPathConversion(process.env),
    });
    expect(result.status).toBe(0);
    const back = fromMsysPath(result.stdout.trim());
    expect(fs.realpathSync.native(back).toLowerCase()).toBe(fs.realpathSync.native(dir).toLowerCase());
  });
});
