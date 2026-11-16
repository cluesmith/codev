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

    expect(fetchIssue).toHaveBeenCalledWith('1903');
    expect(fetchIssue).not.toHaveBeenCalledWith('bugfix-1903');
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
    expect(fetchIssue).toHaveBeenCalledWith('builder-task-abc');
  });

  // The shipped prompts, rendered for real: no `{{issue.*}}` survives in either tree.
  const shipped = [
    ['pir', 'plan', 'plan.md', '1234'],
    ['pir', 'implement', 'implement.md', '1234'],
    ['pir', 'review', 'review.md', '1234'],
    ['air', 'implement', 'implement.md', '1234'],
    ['air', 'pr', 'pr.md', '1234'],
    ['bugfix', 'investigate', 'investigate.md', 'bugfix-1234'],
    ['bugfix', 'fix', 'fix.md', 'bugfix-1234'],
    ['bugfix', 'pr', 'pr.md', 'bugfix-1234'],
  ] as const;
  const cases = ['codev', 'codev-skeleton'].flatMap((tree) =>
    shipped.map(([proto, phase, file, id]) => ({ tree, proto, phase, file, id })),
  );

  it.each(cases)('$tree/protocols/$proto/prompts/$file renders every {{issue.*}} tag', async ({ tree, proto, phase, file, id }) => {
    const source = fs.readFileSync(path.join(repoRoot, tree, 'protocols', proto, 'prompts', file), 'utf-8');
    expect(source, 'fixture no longer uses an issue tag — drop it from this list').toMatch(ISSUE_TAG);
    writePrompt(proto, file, source);

    const prompt = await buildPhasePrompt(tmp, stateFor(id, proto, phase), protocolFor(proto, phase, file));

    expect(prompt).not.toMatch(ISSUE_TAG);
    expect(prompt).toContain('#1234');
  });
});
