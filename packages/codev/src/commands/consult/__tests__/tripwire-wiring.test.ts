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
 * So this drives the real `consult()` entry point with a stubbed Agent SDK that
 * writes a file the way a misbehaving lane would, against a real git repo, and
 * asserts the banner reaches stderr and the review file. Remove the wrapper and
 * these fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

let mockQueryFn: ReturnType<typeof vi.fn>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  mockQueryFn = vi.fn();
  return { query: mockQueryFn };
});

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

/** A lane that writes to the tree mid-review, as the #1649 lane did. */
function laneThatWrites(write: () => void) {
  return () =>
    (async function* () {
      write();
      yield { type: 'assistant', message: { content: [{ text: 'Looks fine to me.\n\nVERDICT: APPROVE' }] } };
      yield { type: 'result', subtype: 'success' };
    })();
}

/** A well-behaved lane. */
function laneThatReads() {
  return () =>
    (async function* () {
      yield { type: 'assistant', message: { content: [{ text: 'Looks fine to me.\n\nVERDICT: APPROVE' }] } };
      yield { type: 'result', subtype: 'success' };
    })();
}

beforeEach(() => {
  cwdBefore = process.cwd();
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-wiring-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });

  fs.mkdirSync(path.join(repo, 'codev/roles'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'codev/roles/consultant.md'), '# Role: Consultant\n\nYou review; you do not write.');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const answer = 42;\n');
  git('init', '-q');
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
  // `mockQueryFn` is assigned by the vi.mock factory, which does not run until
  // the mocked module is first imported — inside each test, after resetModules.
});

afterEach(() => {
  process.chdir(cwdBefore);
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

const banner = () => stderr.join('\n');

describe('the tripwire is wired into consult() (#1649)', () => {
  it('fires when the lane modifies a tracked file under review', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    mockQueryFn.mockImplementation(
      laneThatWrites(() =>
        fs.writeFileSync(path.join(repo, 'app.ts'), '// REVERTED FOR VACUITY CHECK\n'),
      ),
    );

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).toContain('WORKING TREE CHANGED');
    expect(banner()).toContain('app.ts');
  });

  it('fires when the lane creates a file', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    mockQueryFn.mockImplementation(
      laneThatWrites(() => fs.writeFileSync(path.join(repo, 'suggested.patch'), 'diff…')),
    );

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).toContain('WORKING TREE CHANGED');
    expect(banner()).toContain('suggested.patch');
  });

  it('stays quiet when the lane only reads', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    mockQueryFn.mockImplementation(laneThatReads());

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).not.toContain('WORKING TREE CHANGED');
  });

  it('fires even when the lane throws — an unrestored edit is likeliest then', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    mockQueryFn.mockImplementation(() =>
      (async function* () {
        fs.writeFileSync(path.join(repo, 'app.ts'), 'half-applied edit\n');
        yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'] };
      })(),
    );

    await expect(consult({ model: 'claude', prompt: 'review app.ts' })).rejects.toThrow();

    expect(banner()).toContain('WORKING TREE CHANGED');
    expect(banner()).toContain('app.ts');
  });

  it('does not name the lane\'s own --output file', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    mockQueryFn.mockImplementation(laneThatReads());

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
    mockQueryFn.mockImplementation(laneThatReads());

    fs.mkdirSync(path.join(repo, 'subdir'), { recursive: true });
    process.chdir(path.join(repo, 'subdir'));

    await consult({ model: 'claude', prompt: 'review app.ts', output: 'review.txt' });

    expect(fs.existsSync(path.join(repo, 'subdir/review.txt'))).toBe(true);
    expect(banner()).not.toContain('WORKING TREE CHANGED');
  });

  it('appends the warning below the verdict in the review file', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    mockQueryFn.mockImplementation(
      laneThatWrites(() => fs.writeFileSync(path.join(repo, 'app.ts'), 'mutated\n')),
    );

    await consult({ model: 'claude', prompt: 'review app.ts', output: 'review.txt' });

    const written = fs.readFileSync(path.join(repo, 'review.txt'), 'utf-8');
    expect(written).toContain('VERDICT: APPROVE');
    expect(written).toContain('WORKING TREE CHANGED');
    expect(written.indexOf('VERDICT: APPROVE')).toBeLessThan(written.indexOf('WORKING TREE CHANGED'));
  });

  it('says so when the tree becomes unreadable, rather than reporting no changes', async () => {
    vi.resetModules();
    const { consult } = await import('../index.js');
    // The repository disappearing mid-review is not "nothing changed".
    mockQueryFn.mockImplementation(
      laneThatWrites(() => fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true })),
    );

    await consult({ model: 'claude', prompt: 'review app.ts' });

    expect(banner()).toContain('WORKING TREE UNREADABLE');
  });
});
