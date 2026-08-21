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

/**
 * A fake `tea` implementing the slice of `tea api` the gitea script uses.
 *
 * Records argv per HTTP method (so a test can assert what was and wasn't
 * called) plus the POSTed request body, then answers:
 *   GET  repos/{owner}/{repo}        → {"default_branch":"trunk"}
 *   POST repos/{owner}/{repo}/pulls  → the created PR object
 *
 * The POST response carries both `html_url` (browser page) and `url` (API
 * endpoint) so the tests pin that the browser page is what reaches the contract.
 * Everything that isn't `tea api` exits non-zero — `tea pulls create`/`list`
 * must not be reachable.
 */
const TEA_API_STUB = [
  'if [ "$1" != "api" ]; then echo "unexpected: $*" >&2; exit 9; fi',
  'method=GET',
  'for a in "$@"; do case "$prev" in -X) method=$a ;; esac; prev=$a; done',
  'if [ "$method" = POST ]; then',
  '  printf "%s\\0" "$@" > post-args',
  '  cat > post-body',
  '  echo \'{"number":7,"html_url":"https://forge.example.com/o/r/pulls/7","url":"https://forge.example.com/api/v1/repos/o/r/pulls/7"}\'',
  'else',
  '  printf "%s\\0" "$@" > get-args',
  '  echo \'{"default_branch":"trunk"}\'',
  'fi',
  'exit 0',
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
      stub('tea', TEA_API_STUB.replace('"number":7', '"number":1'));

      // Absent: the script must fail before it ever reaches the forge CLI.
      expect(() => run(provider, { CODEV_PR_TITLE: 't', CODEV_PR_HEAD: 'b' })).toThrow();

      // Empty-but-set: allowed (jq only needed to build/read the gitea payload).
      if (provider !== 'gitea' || hasJq()) {
        const stdout = run(provider, {
          CODEV_PR_TITLE: 't',
          CODEV_PR_BODY: '',
          CODEV_PR_HEAD: 'b',
          CODEV_PR_BASE: 'main',
        });
        expect(JSON.parse(stdout).number).toBe(1);
      }
    },
  );

  it.skipIf(!hasJq())(
    'gitea: creates through `tea api` POST and reads the PR out of the response',
    () => {
      stub('tea', TEA_API_STUB);

      const stdout = run('gitea', {
        CODEV_PR_TITLE: 'Fix #1455',
        CODEV_PR_BODY: TRICKY_BODY,
        CODEV_PR_BASE: 'main',
        CODEV_PR_HEAD: 'my-branch',
      });

      // The created PR comes straight out of the create response — and `url` is
      // the browser page, never the API endpoint the stub also returns.
      expect(JSON.parse(stdout)).toEqual({
        number: 7,
        url: 'https://forge.example.com/o/r/pulls/7',
      });

      const args = recordedArgs('post-args');
      expect(args[0]).toBe('api');
      expect(args).toContain('-X');
      expect(args[args.indexOf('-X') + 1]).toBe('POST');
      expect(args).toContain('repos/{owner}/{repo}/pulls');
      // Body travels on stdin, not argv — nothing to quote-mangle.
      expect(args[args.indexOf('-d') + 1]).toBe('@-');

      // The payload is JSON, and the body survives it byte for byte.
      const payload = JSON.parse(fs.readFileSync(path.join(tmp, 'post-body'), 'utf-8'));
      expect(payload).toEqual({
        title: 'Fix #1455',
        body: TRICKY_BODY,
        head: 'my-branch',
        base: 'main',
      });
    },
  );

  it.skipIf(!hasJq())('gitea: never looks the created PR up with a truncating list call', () => {
    // The regression this pins: the lookup used to be `tea pulls list --limit
    // 200`. Gitea caps list responses at `max_response_items` (default 50 —
    // confirmed against Forgejo 15.0.2), so `--limit 200` silently truncates and
    // on a busy repo the just-created PR falls off the page. The script then
    // reported failure for a PR that exists, inviting a duplicate retry.
    // Reading the PR out of the create response removes the lookup entirely.
    stub('tea', TEA_API_STUB);

    run('gitea', {
      CODEV_PR_TITLE: 't',
      CODEV_PR_BODY: 'b',
      CODEV_PR_HEAD: 'my-branch',
      CODEV_PR_BASE: 'main',
    });

    const args = recordedArgs('post-args');
    expect(args).not.toContain('pulls'); // i.e. no `tea pulls list`
    expect(args).not.toContain('list');
    expect(args).not.toContain('--limit');
    expect(fs.existsSync(path.join(tmp, 'get-args')), 'made an unnecessary GET').toBe(false);
  });

  it.skipIf(!hasJq())('gitea: resolves the default branch when no base is given', () => {
    // `tea pulls create` defaulted the base client-side; the REST API rejects a
    // missing one outright (`[Base]: Required`), so the script has to ask.
    stub('tea', TEA_API_STUB);

    const stdout = run('gitea', {
      CODEV_PR_TITLE: 't',
      CODEV_PR_BODY: 'b',
      CODEV_PR_HEAD: 'my-branch',
    });
    expect(JSON.parse(stdout).number).toBe(7);

    expect(recordedArgs('get-args')).toContain('repos/{owner}/{repo}');
    const payload = JSON.parse(fs.readFileSync(path.join(tmp, 'post-body'), 'utf-8'));
    expect(payload.base).toBe('trunk');
  });

  it.skipIf(!hasJq())('gitea: marks a draft with a WIP: title prefix', () => {
    // Gitea has no draft flag on the create API — it silently ignores
    // `draft: true` (verified against Forgejo 15.0.2, which echoes back
    // `draft: false`). A `WIP:` title prefix is the marker, and it is what
    // `tea pulls create --draft` does too.
    stub('tea', TEA_API_STUB);

    run('gitea', {
      CODEV_PR_TITLE: 'Fix #1455',
      CODEV_PR_BODY: 'b',
      CODEV_PR_HEAD: 'my-branch',
      CODEV_PR_BASE: 'main',
      CODEV_PR_DRAFT: '1',
    });

    const payload = JSON.parse(fs.readFileSync(path.join(tmp, 'post-body'), 'utf-8'));
    expect(payload.title).toBe('WIP: Fix #1455');
    expect(payload).not.toHaveProperty('draft');
  });

  it.skipIf(!hasJq())('gitea: passes a cross-repo <user>:<branch> head through verbatim', () => {
    // The API resolves `owner:branch` itself (verified against Forgejo 15.0.2),
    // so there is no head-matching heuristic left to get wrong.
    stub('tea', TEA_API_STUB);

    const stdout = run('gitea', {
      CODEV_PR_TITLE: 't',
      CODEV_PR_BODY: 'b',
      CODEV_PR_HEAD: 'contributor:feature',
      CODEV_PR_BASE: 'main',
    });
    expect(JSON.parse(stdout).number).toBe(7);

    const payload = JSON.parse(fs.readFileSync(path.join(tmp, 'post-body'), 'utf-8'));
    expect(payload.head).toBe('contributor:feature');
  });

  it.skipIf(!hasJq())('gitea: forwards --repo and --login to tea', () => {
    stub('tea', TEA_API_STUB);

    run('gitea', {
      CODEV_PR_TITLE: 't',
      CODEV_PR_BODY: 'b',
      CODEV_PR_HEAD: 'my-branch',
      CODEV_PR_BASE: 'main',
      CODEV_PR_REPO: 'acme/widgets',
      CODEV_PR_LOGIN: 'work',
    });

    const args = recordedArgs('post-args');
    expect(args[args.indexOf('--repo') + 1]).toBe('acme/widgets');
    expect(args[args.indexOf('--login') + 1]).toBe('work');
  });

  it.skipIf(!hasJq())('gitea: fails loudly on an API error even though tea exits 0', () => {
    // `tea api` returns exit 0 for HTTP errors and prints the error body, so
    // exit status is not a usable signal — the response has to be inspected.
    // Verified live: a duplicate head answers `{"message":"pull request already
    // exists…"}` at exit 0.
    stub(
      'tea',
      [
        'if [ "$1" = "api" ]; then',
        '  for a in "$@"; do case "$prev" in -X) m=$a ;; esac; prev=$a; done',
        '  if [ "$m" = POST ]; then cat > /dev/null; fi',
        '  echo \'{"message":"pull request already exists for these targets","url":"https://forge.example.com/api/swagger"}\'',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
    );

    let stderr = '';
    try {
      run('gitea', {
        CODEV_PR_TITLE: 't',
        CODEV_PR_BODY: 'b',
        CODEV_PR_HEAD: 'dup',
        CODEV_PR_BASE: 'main',
      });
      expect.unreachable('the script exited 0 for a PR that was never created');
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toContain('pull request already exists');
  });

  it.skipIf(!hasJq())('gitea: rejects a 200-shaped response that is not a PR object', () => {
    // Every one of these comes back at exit 0. None of them is a created PR, so
    // none may be reported as one — that is #1455's silent success reappearing
    // inside the fix for it.
    const notPrs = [
      '{"message":"The target couldn\'t be found."}', // API error object
      '[]', // an array (e.g. a list endpoint answered instead)
      '{"number":"7","html_url":"https://forge.example.com/o/r/pulls/7"}', // number as a STRING
      '{"html_url":"https://forge.example.com/o/r/pulls/7"}', // no number at all
      'null',
      '',
    ];

    for (const payload of notPrs) {
      stub(
        'tea',
        ['if [ "$1" = "api" ]; then', `  printf '%s' '${payload}'`, '  exit 0', 'fi', 'exit 1'].join('\n'),
      );
      expect(
        () =>
          run('gitea', {
            CODEV_PR_TITLE: 't',
            CODEV_PR_BODY: 'b',
            CODEV_PR_HEAD: 'x',
            CODEV_PR_BASE: 'main',
          }),
        `reported success for a non-PR response: ${payload || '(empty)'}`,
      ).toThrow();
    }
  });

  it.skipIf(!hasJq())('gitea: a created PR with no URL warns against retrying', () => {
    // `number` but no `html_url`/`url` means the PR EXISTS and only the URL is
    // missing. Exiting 1 is right, but the message must not read as "nothing
    // happened" — that invites the duplicate retry this whole change is about.
    stub(
      'tea',
      [
        'if [ "$1" = "api" ]; then',
        '  echo \'{"number":7,"title":"t"}\'',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
    );

    let stderr = '';
    try {
      run('gitea', {
        CODEV_PR_TITLE: 't',
        CODEV_PR_BODY: 'b',
        CODEV_PR_HEAD: 'x',
        CODEV_PR_BASE: 'main',
      });
      expect.unreachable('emitted a result with no browser URL');
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toContain('#7 WAS CREATED');
    expect(stderr).toContain('do not retry');
  });

  it.skipIf(!hasJq())('gitea: names the remedy when the repo context does not resolve', () => {
    // With no Gitea remote and no CODEV_PR_REPO, `{owner}`/`{repo}` stay
    // unsubstituted and tea requests `repos//pulls`, which answers a bare
    // `404 page not found` — non-JSON, and still exit 0. Verified live.
    stub('tea', ['if [ "$1" = "api" ]; then', '  echo "404 page not found"', '  exit 0', 'fi', 'exit 1'].join('\n'));

    let stderr = '';
    try {
      run('gitea', {
        CODEV_PR_TITLE: 't',
        CODEV_PR_BODY: 'b',
        CODEV_PR_HEAD: 'x',
        CODEV_PR_BASE: 'main',
      });
      expect.unreachable('the script exited 0 for a PR that was never created');
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toContain('CODEV_PR_REPO=owner/repo');
  });

  it.skipIf(!hasJq())(
    'gitea: names CODEV_PR_REPO, not CODEV_PR_BASE, when base is unset and the repo does not resolve',
    () => {
      // Same unresolvable-repo 404 as above, but hit via the OTHER call site:
      // resolving the default branch because CODEV_PR_BASE was never set. The
      // remedy is still "the repo didn't resolve" — CODEV_PR_REPO — not
      // CODEV_PR_BASE, which is what this failure used to say.
      stub('tea', ['if [ "$1" = "api" ]; then', '  echo "404 page not found"', '  exit 0', 'fi', 'exit 1'].join('\n'));

      let stderr = '';
      try {
        run('gitea', {
          CODEV_PR_TITLE: 't',
          CODEV_PR_BODY: 'b',
          CODEV_PR_HEAD: 'x',
        });
        expect.unreachable('the script exited 0 for a PR that was never created');
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
      }
      expect(stderr).toContain('CODEV_PR_REPO=owner/repo');
      expect(stderr).not.toContain('set CODEV_PR_BASE');
    },
  );
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
