/**
 * Spec 1658 Phase 5: `codev doctor`'s Windows prerequisites (scenario 2), with
 * the real Git Bash resolver over a fake host. The section itself only prints
 * when the platform seam is `win32`; the POSIX doctor output is pinned in
 * doctor.test.ts, and the real runner's Git Bash and jq in
 * `windows-launch-resolvers.windows.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { checkWindowsPrerequisites, findCrlfHookScripts, splitShellWords, type WindowsPrereqDeps } from '../commands/doctor.js';
import { resolveGitBash, type GitBashHost } from '../lib/git-bash.js';

const SYSTEM32_BASH = 'C:\\Windows\\System32\\bash.exe';
const GIT = 'C:\\Program Files\\Git';

function host(files: string[], onPath: string[]): GitBashHost {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    isFile: (file) => set.has(file.toLowerCase()),
    gitVersion: () => 'git version 2.47.1.windows.1',
    findBashOnPath: () => onPath,
  };
}

function deps(overrides: Partial<WindowsPrereqDeps>): WindowsPrereqDeps {
  return {
    resolveGitBash: () => resolveGitBash({}, host([`${GIT}\\bin\\bash.exe`, `${GIT}\\cmd\\git.exe`], [])),
    findJq: () => 'C:\\ProgramData\\chocolatey\\bin\\jq.exe',
    jqVersion: () => 'jq-1.7.1',
    crlfScripts: () => [],
    ...overrides,
  };
}

describe('checkWindowsPrerequisites', () => {
  it('all green: reports the Git version, bash path and jq', () => {
    expect(checkWindowsPrerequisites(deps({}))).toEqual([
      { name: 'Git Bash', status: 'ok', version: '2.47.1.windows.1', note: `${GIT}\\bin\\bash.exe` },
      { name: 'jq', status: 'ok', version: '1.7.1', note: 'C:\\ProgramData\\chocolatey\\bin\\jq.exe' },
    ]);
  });

  it('scenario 2: only System32 bash present → a named failure; the WSL launcher is not accepted', () => {
    const results = checkWindowsPrerequisites(deps({
      resolveGitBash: () => resolveGitBash({}, host([SYSTEM32_BASH], [SYSTEM32_BASH])),
    }));
    const gitBash = results.find((r) => r.name === 'Git Bash');
    expect(gitBash?.status).toBe('fail');
    expect(gitBash?.version).toBe('not found');
    expect(gitBash?.note).toContain('Git for Windows');
    expect(gitBash?.note).not.toContain(SYSTEM32_BASH);
  });

  it('scenario 2: an override at System32 is an invalid-override failure', () => {
    const results = checkWindowsPrerequisites(deps({
      resolveGitBash: () => resolveGitBash({ configPath: SYSTEM32_BASH }, host([SYSTEM32_BASH], [])),
    }));
    expect(results[0]).toMatchObject({ name: 'Git Bash', status: 'fail', version: 'invalid override' });
    expect(results[0].note).toContain('WSL launcher');
  });

  it('scenario 2: jq missing → a named failure with an install hint', () => {
    const results = checkWindowsPrerequisites(deps({ findJq: () => null }));
    expect(results[1]).toMatchObject({ name: 'jq', status: 'fail', version: 'not found' });
    expect(results[1].note).toContain('winget install jqlang.jq');
  });

  it('jq that is found but does not run is a failure, not ok', () => {
    const results = checkWindowsPrerequisites(deps({ jqVersion: () => null }));
    expect(results[1]).toMatchObject({ name: 'jq', status: 'fail', version: 'not working' });
    expect(results[1].note).toContain('--version failed');
  });

  it('looks for jq in the resolved Git install', () => {
    const seen: Array<string | null> = [];
    checkWindowsPrerequisites(deps({ findJq: (root) => { seen.push(root); return null; } }));
    expect(seen).toEqual([GIT]);
  });

  it('CRLF hook scripts are warnings', () => {
    const results = checkWindowsPrerequisites(deps({ crlfScripts: () => ['scripts/setup.sh'] }));
    expect(results[2]).toMatchObject({ name: 'Hook script', status: 'warn', version: 'scripts/setup.sh has CRLF line endings' });
  });

  it('an unexpected resolver error is not swallowed', () => {
    expect(() => checkWindowsPrerequisites(deps({ resolveGitBash: () => { throw new TypeError('bug'); } }))).toThrow('bug');
  });
});

describe('findCrlfHookScripts', () => {
  const root = path.resolve('/work/repo');
  const files: Record<string, string> = {
    [path.join(root, 'scripts', 'setup.sh')]: '#!/bin/sh\r\npnpm install\r\n',
    [path.join(root, 'scripts', 'lf.sh')]: '#!/bin/sh\npnpm install\n',
    [path.join(root, 'dev.sh')]: 'pnpm dev\r\n',
    [path.join(root, 'scripts', 'my setup.sh')]: 'echo hi\r\n',
    [path.resolve('/etc/outside.sh')]: 'x\r\n',
  };
  const read = (file: string) => files[file] ?? null;

  it('finds CRLF scripts named in postSpawn and devCommand commands', () => {
    const found = findCrlfHookScripts(
      ['bash scripts/setup.sh --fast', './scripts/lf.sh', 'pnpm install', 'sh "dev.sh";'],
      root,
      read,
    );
    expect(found).toEqual([path.join('scripts', 'setup.sh'), 'dev.sh']);
  });

  it('ignores files outside the workspace and reports each script once', () => {
    expect(findCrlfHookScripts(['/etc/outside.sh', 'scripts/setup.sh && scripts/setup.sh'], root, read))
      .toEqual([path.join('scripts', 'setup.sh')]);
  });

  it('finds a quoted script path containing spaces', () => {
    expect(findCrlfHookScripts(['bash "scripts/my setup.sh" --x', "sh 'scripts/my setup.sh'"], root, read))
      .toEqual([path.join('scripts', 'my setup.sh')]);
  });
});

describe('splitShellWords', () => {
  it.each([
    ['pnpm install', ['pnpm', 'install']],
    ['bash "scripts/my setup.sh" --x', ['bash', 'scripts/my setup.sh', '--x']],
    ["sh 'a b.sh';./c.sh&&d", ['sh', 'a b.sh', './c.sh', 'd']],
    ['run my\\ file.sh', ['run', 'my file.sh']],
    ['echo "say \\"hi\\""', ['echo', 'say "hi"']],
    ['echo ""', ['echo', '']],
  ])('%s', (command, words) => {
    expect(splitShellWords(command)).toEqual(words);
  });
});
