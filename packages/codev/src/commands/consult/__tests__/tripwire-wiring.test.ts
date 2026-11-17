/**
 * Proof that the tripwire is actually wired into the production path (#1649).
 *
 * Both CMAP reviewers landed on the same gap and they were right: every other
 * tripwire test calls the exported functions directly, so deleting the wrapper
 * from `runConsultation()` — pointing `consult()` straight at
 * `dispatchConsultation()` — left the entire suite green. The issue's second
 * acceptance clause is "the tripwire fires when a write is simulated", and that
 * was carried only by unit tests and a manual CLI run.
 *
 * So this drives the real `consult()` entry point with a stub `claude` CLI that
 * acts on the tree the way a misbehaving lane would (a shell command it runs in
 * its cwd, the workspace, before it streams its review), against a real git
 * repo, and asserts the banner reaches stderr and the review file. Remove the
 * wrapper and these fail.
 *
 * Since #1912 the real claude lane has no write tools at all, so this stub is
 * playing a lane that does: the tripwire wraps every lane, whichever one that is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStubClaude, type StubClaude } from '../../../__tests__/helpers/stub-claude.js';

vi.mock('chalk', () => ({
  default: {
    red: Object.assign((s: string) => s, { bold: (s: string) => s }),
    dim: (s: string) => s,
    bold: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
  },
}));

let repo: string;
let cwdBefore: string;
let stderr: string[];
let claude: StubClaude | undefined;
const harnessClaudeBin = process.env.CODEV_CLAUDE_BIN;

const REVIEW_STREAM = [
  { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Looks fine to me.\n\nVERDICT: APPROVE' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'VERDICT: APPROVE' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Pin a claude lane that streams `stdout`, after running `write` (a shell command) in the workspace. */
function pinLane(write?: string, stdout = REVIEW_STREAM, exitCode = 0): void {
  claude = createStubClaude({ print: { stdout, exitCode, beforeOutput: write } });
  process.env.CODEV_CLAUDE_BIN = claude.bin;
}

/** A lane that writes to the tree mid-review, as the #1649 lane did. */
const laneThatWrites = (write: string) => pinLane(write);

/** A well-behaved lane. */
const laneThatReads = () => pinLane();

beforeEach(() => {
  cwdBefore = process.cwd();
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-wiring-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });

  fs.mkdirSync(path.join(repo, 'codev/roles'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'codev/roles/consultant.md'), '# Role: Consultant\n\nYou review; you do not write.');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const answer = 42;\n');
  git('init', '-q');
  // Pin the branch name rather than inheriting init.defaultBranch.
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'initial');

  process.chdir(repo);
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  claude?.cleanup();
  claude = undefined;
  if (harnessClaudeBin === undefined) delete process.env.CODEV_CLAUDE_BIN;
  else process.env.CODEV_CLAUDE_BIN = harnessClaudeBin;
  process.chdir(cwdBefore);
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

const banner = () => stderr.join('\n');

describe('the tripwire is wired into consult() (#1649)', () => {
  it('fires when the lane modifies a tracked file under review', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    laneThatWrites(`printf '// REVERTED FOR VACUITY CHECK\\n' > app.ts`);

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).toContain('WORKING TREE CHANGED');
    expect(banner()).toContain('app.ts');
  });

  it('fires when the lane creates a file', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    laneThatWrites(`printf 'diff' > suggested.patch`);

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).toContain('WORKING TREE CHANGED');
    expect(banner()).toContain('suggested.patch');
  });

  it('stays quiet when the lane only reads', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    laneThatReads();

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).not.toContain('WORKING TREE CHANGED');
  });

  it('fires even when the lane throws — an unrestored edit is likeliest then', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    pinLane(
      `printf 'half-applied edit\\n' > app.ts`,
      [
        { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read'] },
        { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n',
      1,
    );

    await expect(consult({ model: 'claude', prompt: 'review app.ts' })).rejects.toThrow();

    expect(banner()).toContain('WORKING TREE CHANGED');
    expect(banner()).toContain('app.ts');
  });

  it('does not name the lane\'s own --output file', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    laneThatReads();

    // Relative, as a human would type it — the case a raw workspaceRoot prefix
    // test used to miss, leaving the lane reporting its own review file.
    await consult({ model: 'claude', prompt: 'review app.ts', output: 'review.txt' });

    expect(fs.existsSync(path.join(repo, 'review.txt'))).toBe(true);
    expect(banner()).not.toContain('WORKING TREE CHANGED');
  });

  it('does not name its own --output when run from a subdirectory', async () => {
    // The case a workspaceRoot-based resolution got wrong: the file lands at
    // <subdir>/review.txt because lanes write with a bare fs.writeFileSync and
    // consult never chdirs, but the exclusion named `review.txt`.
    vi.resetModules();
    const { consult } = await import('../index.js');
    laneThatReads();

    fs.mkdirSync(path.join(repo, 'subdir'), { recursive: true });
    process.chdir(path.join(repo, 'subdir'));

    await consult({ model: 'claude', prompt: 'review app.ts', output: 'review.txt' });

    expect(fs.existsSync(path.join(repo, 'subdir/review.txt'))).toBe(true);
    expect(banner()).not.toContain('WORKING TREE CHANGED');
  });

  it('appends the warning below the verdict in the review file', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    laneThatWrites(`printf 'mutated\\n' > app.ts`);

    await consult({ model: 'claude', prompt: 'review app.ts', output: 'review.txt' });

    const written = fs.readFileSync(path.join(repo, 'review.txt'), 'utf-8');
    expect(written).toContain('VERDICT: APPROVE');
    expect(written).toContain('WORKING TREE CHANGED');
    expect(written.indexOf('VERDICT: APPROVE')).toBeLessThan(written.indexOf('WORKING TREE CHANGED'));
  });

  it('fires when the lane COMMITS, which leaves the tree clean', async () => {
    // A file comparison is a poor witness here: `git commit` takes the dirty
    // tree clean, so the lane's own edit disappears from `git status`.
    vi.resetModules();
    const { consult } = await import('../index.js');
    laneThatWrites(
      `printf 'export const answer = 43;\\n' > app.ts && git add app.ts && ` +
      `git commit -qm 'a commit the reviewer had no business making'`,
    );

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).toContain('REPOSITORY MOVED');
    expect(banner()).toContain('HEAD:');
  });

  it('fires on a clean ref switch, where nothing on disk changes at all', async () => {
    // No file differs, `git status` is identical either side, and the review is
    // still of a different ref than the builder believes.
    vi.resetModules();
    const { consult } = await import('../index.js');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
    git('branch', 'feature');

    laneThatWrites('git checkout -q feature');

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).not.toContain('WORKING TREE CHANGED');
    expect(banner()).toContain('REPOSITORY MOVED');
    expect(banner()).toContain('branch: main -> feature');
  });

  it('says so when the tree becomes unreadable, rather than reporting no changes', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    // The repository disappearing mid-review is not "nothing changed".
    laneThatWrites('rm -rf .git');

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).toContain('WORKING TREE UNREADABLE');
  });
});
