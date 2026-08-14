/**
 * Regression test for GitHub Issue #1455.
 *
 * `pr-create` was not a forge concept: it was absent from KNOWN_CONCEPTS, no
 * provider shipped a script for it, and every protocol prompt wrote `gh pr
 * create` literally. A project with `forge.provider: gitea` fully configured
 * still shelled out to `gh` at the single most important write in the protocol,
 * so PR creation only worked with a hand-maintained `gh`→forge shim on PATH.
 *
 * These tests pin all three halves of the fix:
 *   1. the concept resolves per provider (dispatcher + on-disk scripts),
 *   2. the scripts honour the contract — inputs as CODEV_* env, output as
 *      `{"number","url"}` — and carry the body through **byte for byte**
 *      (a shim that silently dropped the body exited 0 for months), and
 *   3. no prompt hardcodes `gh pr create` any more; they carry the
 *      `{{pr_create_command}}` token porch substitutes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getKnownConcepts,
  getForgeCommand,
  resolveAllConcepts,
  validateForgeConfig,
} from '../lib/forge.js';

const codevPkgRoot = path.resolve(import.meta.dirname, '..', '..');
const repoRoot = path.resolve(codevPkgRoot, '..', '..');
const forgeScripts = path.join(codevPkgRoot, 'scripts', 'forge');

/** A body with every character class that has broken a forge shim before. */
const TRICKY_BODY = [
  '## Summary',
  '',
  'Fixes #1455 — "quoted", \'single\', `backtick`, $VAR, \\backslash, 100% & <angle>.',
  '',
  '- [ ] checkbox',
].join('\n');

function hasJq(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('#1455 — pr-create is a forge concept', () => {
  it('is a known concept, so config and doctor can see it', () => {
    expect(getKnownConcepts()).toContain('pr-create');

    const results = validateForgeConfig({ 'pr-create': './my-pr-create.sh' });
    const entry = results.find((r) => r.concept === 'pr-create');
    expect(entry?.status).toBe('ok');
  });

  it.each(['github', 'gitea', 'gitlab'])(
    'the %s preset routes pr-create to its own script',
    (provider) => {
      const command = getForgeCommand('pr-create', { provider });
      expect(command, `${provider} has no pr-create route`).not.toBeNull();
      expect(command).toBe(path.join(forgeScripts, provider, 'pr-create.sh'));
      expect(fs.existsSync(command!)).toBe(true);
      expect(fs.statSync(command!).mode & 0o111, 'script is not executable').not.toBe(0);
    },
  );

  it.each([
    ['github', 'gh'],
    ['gitea', 'tea'],
    ['gitlab', 'glab'],
  ])('doctor resolves the %s pr-create executable as %s, not a shell builtin', (provider, tool) => {
    // extractExecutable reads the script and reports what must be on PATH. The
    // scripts open with `set -e`, so a builtin-blind reader answers "set" and
    // `codev doctor` then warns that `set` is missing instead of `tea`/`glab`.
    const resolution = resolveAllConcepts({ provider }).find((r) => r.concept === 'pr-create');
    expect(resolution?.executable).toBe(tool);
  });

  it('defaults to the github script and honours a manual override', () => {
    expect(getForgeCommand('pr-create', null)).toBe(
      path.join(forgeScripts, 'github', 'pr-create.sh'),
    );
    expect(getForgeCommand('pr-create', { 'pr-create': '/custom.sh' })).toBe('/custom.sh');
    expect(getForgeCommand('pr-create', { 'pr-create': null })).toBeNull();
  });
});

describe('#1455 — pr-create scripts honour the contract', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-create-1455-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Install a fake CLI on PATH that records its argv. */
  function stub(name: string, body: string): void {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }

  function run(provider: string, env: Record<string, string>): string {
    return execFileSync('sh', [path.join(forgeScripts, provider, 'pr-create.sh')], {
      cwd: tmp,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, ...env },
      encoding: 'utf-8',
    });
  }

  /** argv the stub recorded — NUL-separated, so multi-line bodies survive. */
  function recordedArgs(file: string): string[] {
    return fs.readFileSync(path.join(tmp, file), 'utf-8').split('\0').slice(0, -1);
  }

  it('github: passes title and body to gh and emits {number, url}', () => {
    stub('gh', 'printf "%s\\0" "$@" > args\necho https://github.com/o/r/pull/42');

    const stdout = run('github', {
      CODEV_PR_TITLE: 'Fix #1455: route pr-create through the forge',
      CODEV_PR_BODY: TRICKY_BODY,
      CODEV_PR_BASE: 'main',
      CODEV_PR_HEAD: 'builder/bugfix-1455',
    });

    expect(JSON.parse(stdout)).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
    });

    const args = recordedArgs('args');
    expect(args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(args[args.indexOf('--title') + 1]).toBe('Fix #1455: route pr-create through the forge');
    expect(args[args.indexOf('--body') + 1]).toBe(TRICKY_BODY);
    expect(args[args.indexOf('--base') + 1]).toBe('main');
    expect(args[args.indexOf('--head') + 1]).toBe('builder/bugfix-1455');
  });

  it('github: fails loudly when the forge prints no PR URL', () => {
    stub('gh', 'echo "nothing to see here"');
    expect(() =>
      run('github', { CODEV_PR_TITLE: 't', CODEV_PR_BODY: 'b' }),
    ).toThrow();
  });

  it('github: requires a title', () => {
    stub('gh', 'echo https://github.com/o/r/pull/1');
    expect(() => run('github', { CODEV_PR_TITLE: '', CODEV_PR_BODY: 'b' })).toThrow();
  });

  it.each(['github', 'gitea', 'gitlab'])(
    '%s: refuses an absent body but accepts a deliberately empty one',
    (provider) => {
      // `--body ""` succeeds on every forge, so an unset variable would open a
      // bodyless PR at exit 0 — the silent failure #1455 exists to close.
      stub('gh', 'echo https://github.com/o/r/pull/1');
      stub('glab', 'echo https://gitlab.com/o/r/-/merge_requests/1');
      stub(
        'tea',
        [
          'if [ "$2" = "create" ]; then exit 0; fi',
          'echo \'[{"index":"1","url":"https://forge.example.com/o/r/pulls/1","head":"b"}]\'',
        ].join('\n'),
      );

      // Absent: the script must fail before it ever reaches the forge CLI.
      expect(() => run(provider, { CODEV_PR_TITLE: 't', CODEV_PR_HEAD: 'b' })).toThrow();

      // Empty-but-set: allowed (jq only needed for the gitea lookup).
      if (provider !== 'gitea' || hasJq()) {
        const stdout = run(provider, { CODEV_PR_TITLE: 't', CODEV_PR_BODY: '', CODEV_PR_HEAD: 'b' });
        expect(JSON.parse(stdout).number).toBe(1);
      }
    },
  );

  it.skipIf(!hasJq())(
    'gitea: passes the body as --description and normalizes tea output to {number, url}',
    () => {
      // `tea pulls create` prints a rendered, line-wrapped, ANSI-decorated view;
      // the script must ignore it and look the PR up via `tea pulls list`.
      stub(
        'tea',
        [
          'if [ "$2" = "create" ]; then',
          '  printf "%s\\0" "$@" > create-args',
          '  echo "  # #7 rendered nonsense (open)"',
          '  exit 0',
          'fi',
          'if [ "$2" = "list" ]; then',
          '  printf "%s\\0" "$@" > list-args',
          '  echo \'[{"index":"7","url":"https://forge.example.com/o/r/pulls/7","head":"my-branch"},',
          '        {"index":"3","url":"https://forge.example.com/o/r/pulls/3","head":"other"}]\'',
          '  exit 0',
          'fi',
          'exit 1',
        ].join('\n'),
      );

      const stdout = run('gitea', {
        CODEV_PR_TITLE: 'Fix #1455',
        CODEV_PR_BODY: TRICKY_BODY,
        CODEV_PR_BASE: 'main',
        CODEV_PR_HEAD: 'my-branch',
      });

      expect(JSON.parse(stdout)).toEqual({
        number: 7,
        url: 'https://forge.example.com/o/r/pulls/7',
      });

      const args = recordedArgs('create-args');
      expect(args.slice(0, 2)).toEqual(['pulls', 'create']);
      expect(args[args.indexOf('--description') + 1]).toBe(TRICKY_BODY);
      expect(args).not.toContain('--body');
      expect(args[args.indexOf('--title') + 1]).toBe('Fix #1455');
      expect(args[args.indexOf('--head') + 1]).toBe('my-branch');
      expect(args[args.indexOf('--base') + 1]).toBe('main');

      // The lookup must page like every other gitea script; on tea's default
      // page a busy repo pushes the just-created PR off the list and the script
      // reports failure for a PR that exists.
      const listArgs = recordedArgs('list-args');
      expect(listArgs[listArgs.indexOf('--limit') + 1]).toBe('200');
    },
  );

  it.skipIf(!hasJq())('gitea: matches a cross-repo <user>:<branch> head', () => {
    stub(
      'tea',
      [
        'if [ "$2" = "create" ]; then exit 0; fi',
        'echo \'[{"index":"9","url":"https://forge.example.com/o/r/pulls/9","head":"feature"}]\'',
      ].join('\n'),
    );

    const stdout = run('gitea', {
      CODEV_PR_TITLE: 't',
      CODEV_PR_BODY: 'b',
      CODEV_PR_HEAD: 'contributor:feature',
    });
    expect(JSON.parse(stdout).number).toBe(9);
  });

  it.skipIf(!hasJq())('gitea: fails when the created PR cannot be found', () => {
    stub(
      'tea',
      ['if [ "$2" = "create" ]; then exit 0; fi', "echo '[]'"].join('\n'),
    );
    expect(() =>
      run('gitea', { CODEV_PR_TITLE: 't', CODEV_PR_BODY: 'b', CODEV_PR_HEAD: 'nope' }),
    ).toThrow();
  });
});

describe('#1455 — prompts route PR creation through the concept', () => {
  const promptFiles = [
    'protocols/air/prompts/pr.md',
    'protocols/aspir/prompts/review.md',
    'protocols/bugfix/prompts/pr.md',
    'protocols/maintain/prompts/review.md',
    'protocols/pir/prompts/review.md',
    'protocols/spir/prompts/review.md',
  ].flatMap((rel) => [`codev/${rel}`, `codev-skeleton/${rel}`]);

  it.each(promptFiles)('%s invokes {{pr_create_command}}', (rel) => {
    const content = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
    expect(content).toContain('{{pr_create_command}}');
    expect(content).toContain('CODEV_PR_TITLE=');
    expect(content).toContain('CODEV_PR_BODY=');
    // Exactly once — the invocation. Porch substitutes every occurrence, so a
    // second one in the prose renders as "…substitutes /path/to/pr-create.sh
    // with your forge's command", which is nonsense.
    expect(content.match(/\{\{pr_create_command\}\}/g)).toHaveLength(1);
  });

  it('no protocol file shells out to `gh pr create`', () => {
    const offenders: string[] = [];
    for (const tree of ['codev/protocols', 'codev-skeleton/protocols']) {
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.md')) {
            const content = fs.readFileSync(full, 'utf-8');
            // A command invocation, not the prose that names GitHub's default.
            if (/^\s*gh pr create\b/m.test(content)) {
              offenders.push(path.relative(repoRoot, full));
            }
          }
        }
      };
      walk(path.join(repoRoot, tree));
    }
    expect(offenders).toEqual([]);
  });
});
