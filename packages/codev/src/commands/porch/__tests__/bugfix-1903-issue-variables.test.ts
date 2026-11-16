/**
 * Regression test for GitHub Issue #1903 — `{{issue.number}}` / `{{issue.title}}`.
 *
 * PIR, AIR and BUGFIX phase prompts name the driving issue as `{{issue.number}}` and
 * `{{issue.title}}`, but porch's renderer matched `\w+` only, so the dotted names reached
 * the builder literally ("Commit as `[PIR #{{issue.number}}] …`"). The porch id is not
 * always the issue id either: BUGFIX projects are `bugfix-<N>`, so a lookup by porch id
 * never found the issue and the Goal header fell back to the slug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPhasePrompt } from '../prompts.js';
import type { ProjectState, Protocol } from '../types.js';

const { fetchIssue } = vi.hoisted(() => ({ fetchIssue: vi.fn() }));
vi.mock('../../../lib/github.js', () => ({ fetchIssue }));

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');

function protocolFor(name: string, phase: string, prompt: string): Protocol {
  return {
    name,
    phases: [{ id: phase, name: phase, type: 'once', build: { prompt } }],
  } as unknown as Protocol;
}

function stateFor(id: string, protocol: string, phase: string): ProjectState {
  return {
    id,
    title: 'the-slug',
    protocol,
    phase,
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as ProjectState;
}

const ISSUE_TAG = /\{\{issue\.\w+\}\}/;

describe('#1903 — porch substitutes {{issue.number}} and {{issue.title}}', () => {
  let tmp: string;

  function writePrompt(protocol: string, file: string, content: string): void {
    const dir = path.join(tmp, 'codev', 'protocols', protocol, 'prompts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-vars-1903-'));
    fetchIssue.mockReset();
    fetchIssue.mockImplementation(async (id: string) =>
      id === 'bugfix-1903' || id === 'builder-task-abc' ? null : { title: `Title of ${id}`, body: '', state: 'OPEN' },
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('renders the issue for a PIR project, whose porch id is the issue number', async () => {
    writePrompt('pir', 'plan.md', 'Issue #{{issue.number}} — {{issue.title}}; commit as [PIR #{{issue.number}}]\n');
    const prompt = await buildPhasePrompt(tmp, stateFor('1234', 'pir', 'plan'), protocolFor('pir', 'plan', 'plan.md'));

    expect(prompt).toContain('Issue #1234 — Title of 1234; commit as [PIR #1234]');
    expect(prompt).not.toMatch(ISSUE_TAG);
  });

  it('derives the issue from a BUGFIX porch id (bugfix-<N>) for the variables and the Goal header', async () => {
    writePrompt('bugfix', 'investigate.md', '- **Issue**: #{{issue.number}} — {{issue.title}}\n');
    const prompt = await buildPhasePrompt(
      tmp,
      stateFor('bugfix-1903', 'bugfix', 'investigate'),
      protocolFor('bugfix', 'investigate', 'investigate.md'),
    );

    expect(fetchIssue).toHaveBeenCalledWith('1903', { cwd: tmp });
    expect(fetchIssue).not.toHaveBeenCalledWith('bugfix-1903', expect.anything());
    expect(prompt).toContain('- **Issue**: #1903 — Title of 1903');
    expect(prompt).toContain('## Goal\n\nTitle of 1903');
  });

  it('accepts a tracker key', async () => {
    writePrompt('bugfix', 'fix.md', 'Fix {{issue.number}}: {{issue.title}}\n');
    const prompt = await buildPhasePrompt(tmp, stateFor('bugfix-eng-12', 'bugfix', 'fix'), protocolFor('bugfix', 'fix', 'fix.md'));
    expect(prompt).toContain('Fix ENG-12: Title of ENG-12');
  });

  it('still renders the number when the issue cannot be fetched, and leaves the title visibly unrendered', async () => {
    fetchIssue.mockResolvedValue(null);
    writePrompt('pir', 'plan.md', '#{{issue.number}} — {{issue.title}}\n');
    const prompt = await buildPhasePrompt(tmp, stateFor('1234', 'pir', 'plan'), protocolFor('pir', 'plan', 'plan.md'));
    expect(prompt).toContain('#1234 — {{issue.title}}');
  });

  it('leaves the tags as written for a project that names no issue', async () => {
    writePrompt('spir', 'plan.md', '#{{issue.number}} {{project_id}}\n');
    const prompt = await buildPhasePrompt(
      tmp,
      stateFor('builder-task-abc', 'spir', 'plan'),
      protocolFor('spir', 'plan', 'plan.md'),
    );
    expect(prompt).toContain('#{{issue.number}} builder-task-abc');
    // The summary lookup still tries the raw id, as before.
    expect(fetchIssue).toHaveBeenCalledWith('builder-task-abc', { cwd: tmp });
  });

  // The shipped prompts, rendered for real: no `{{issue.*}}` survives in either tree. Every
  // prompt file of the protocols that name the issue, so a new one is covered automatically.
  // Each prompt's file name is its phase id; BUGFIX's porch id is `bugfix-<N>`.
  const cases = ['codev', 'codev-skeleton'].flatMap((tree) =>
    ['pir', 'air', 'bugfix'].flatMap((proto) =>
      fs
        .readdirSync(path.join(repoRoot, tree, 'protocols', proto, 'prompts'))
        .filter((file) => file.endsWith('.md'))
        .map((file) => ({
          tree,
          proto,
          file,
          phase: file.replace(/\.md$/, ''),
          id: proto === 'bugfix' ? 'bugfix-1234' : '1234',
        })),
    ),
  );

  it('found the shipped prompts that name the issue', () => {
    const names = cases.map(({ tree, proto, file }) => `${tree}/${proto}/${file}`);
    for (const tree of ['codev', 'codev-skeleton']) {
      for (const f of ['pir/plan.md', 'pir/implement.md', 'pir/review.md', 'air/implement.md', 'air/pr.md', 'bugfix/investigate.md', 'bugfix/fix.md', 'bugfix/pr.md']) {
        expect(names).toContain(`${tree}/${f}`);
      }
    }
  });

  it.each(cases)('$tree/protocols/$proto/prompts/$file renders every {{issue.*}} tag', async ({ tree, proto, phase, file, id }) => {
    const source = fs.readFileSync(path.join(repoRoot, tree, 'protocols', proto, 'prompts', file), 'utf-8');
    writePrompt(proto, file, source);

    const prompt = await buildPhasePrompt(tmp, stateFor(id, proto, phase), protocolFor(proto, phase, file));

    expect(prompt).not.toMatch(ISSUE_TAG);
    if (ISSUE_TAG.test(source)) expect(prompt).toContain('1234');
  });
});

// The PIR half of #1903: the PR-time consultation must load PIR's PR reviewer prompt (not the
// pre-dev-approval impl prompt) with three reviewers by default, identically in both trees.
describe('#1903 — PIR review consultation shape (both trees)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

  it.each(['codev', 'codev-skeleton'])('%s: review verify is type "pr" with three reviewers', (tree) => {
    const proto = JSON.parse(read(`${tree}/protocols/pir/protocol.json`));
    const review = proto.phases.find((p: { id: string }) => p.id === 'review');
    expect(review.verify.type).toBe('pr');
    expect(review.verify.models).toEqual(['gemini', 'codex', 'claude']);
    // consult resolves `--protocol pir --type pr` to this file.
    expect(fs.existsSync(path.join(repoRoot, tree, 'protocols/pir/consult-types/pr-review.md'))).toBe(true);
  });

  it('the PIR trees are byte-identical', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)).map((f) => path.join(e.name, f)) : [e.name],
      );
    const files = walk(path.join(repoRoot, 'codev-skeleton/protocols/pir')).sort();
    expect(walk(path.join(repoRoot, 'codev/protocols/pir')).sort()).toEqual(files);
    for (const f of files) {
      expect(read(`codev/protocols/pir/${f}`), f).toBe(read(`codev-skeleton/protocols/pir/${f}`));
    }
  });
});
