/**
 * Regression test for GitHub Issue #1903 — the issue lookup uses the workspace's forge.
 *
 * `{{issue.title}}` and the Goal header come from the forge's `issue-view` concept. Called
 * without the workspace, `fetchIssue` resolves no forge config and runs the GitHub default,
 * so a Linear / Jira / GitLab project never got its title. No mock here: the configured
 * concept command really runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPhasePrompt } from '../prompts.js';
import type { ProjectState, Protocol } from '../types.js';

const protocol = {
  name: 'pir',
  phases: [{ id: 'plan', name: 'Plan', type: 'once', build: { prompt: 'plan.md' } }],
} as unknown as Protocol;

const state = {
  id: 'ENG-7',
  title: 'the-slug',
  protocol: 'pir',
  phase: 'plan',
  plan_phases: [],
  current_plan_phase: null,
  gates: {},
  iteration: 1,
  build_complete: false,
  history: [],
  started_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as unknown as ProjectState;

describe('#1903 — {{issue.title}} comes from the configured forge', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-forge-1903-'));
    const prompts = path.join(tmp, 'codev', 'protocols', 'pir', 'prompts');
    fs.mkdirSync(prompts, { recursive: true });
    fs.writeFileSync(path.join(prompts, 'plan.md'), 'Issue {{issue.number}}: {{issue.title}}\n');
    fs.mkdirSync(path.join(tmp, '.codev'), { recursive: true });
    // A manual `issue-view` override that echoes the id it was asked for.
    fs.writeFileSync(
      path.join(tmp, '.codev', 'config.json'),
      JSON.stringify({
        forge: {
          'issue-view': `printf '{"title":"Tracker issue %s","body":"","state":"OPEN"}' "$CODEV_ISSUE_ID"`,
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('renders the title the workspace forge returns, in the variables and the Goal header', async () => {
    const prompt = await buildPhasePrompt(tmp, state, protocol);
    expect(prompt).toContain('Issue ENG-7: Tracker issue ENG-7');
    expect(prompt).toContain('## Goal\n\nTracker issue ENG-7');
  });
});

// PIR's merge step goes through the forge's `pr-merge` concept, like PR creation does (#1455).
describe('#1903 — porch substitutes {{pr_merge_command}}', () => {
  const forgeScripts = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'forge');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
  let tmp: string;

  // `issue-view` disabled throughout: no forge CLI or network for the issue lookup.
  function render(forge: Record<string, unknown> | null): Promise<string> {
    fs.mkdirSync(path.join(tmp, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.codev', 'config.json'), JSON.stringify({ forge: { 'issue-view': null, ...forge } }));
    return buildPhasePrompt(tmp, { ...state, id: '1234' } as ProjectState, protocol);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-merge-1903-'));
    const prompts = path.join(tmp, 'codev', 'protocols', 'pir', 'prompts');
    fs.mkdirSync(prompts, { recursive: true });
    fs.writeFileSync(path.join(prompts, 'plan.md'), 'export CODEV_PR_NUMBER=7\n{{pr_merge_command}}\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('renders the github script when no forge provider is configured', async () => {
    const prompt = await render(null);
    expect(prompt).toContain(path.join(forgeScripts, 'github', 'pr-merge.sh'));
    expect(prompt).not.toContain('{{pr_merge_command}}');
  });

  it('renders the configured provider and a manual override', async () => {
    expect(await render({ provider: 'gitea' })).toContain(path.join(forgeScripts, 'gitea', 'pr-merge.sh'));
    expect(await render({ 'pr-merge': '/opt/forge/merge.sh' })).toContain('/opt/forge/merge.sh');
  });

  it('fails loudly when the concept is disabled', async () => {
    const prompt = await render({ 'pr-merge': null });
    expect(prompt).toContain('merge the PR manually');
    expect(prompt).toContain('false;');
  });

  it.each(['codev', 'codev-skeleton'])('%s PIR review.md merges through the concept, not a gh command', (tree) => {
    const review = fs.readFileSync(path.join(repoRoot, tree, 'protocols/pir/prompts/review.md'), 'utf-8');
    expect(review.match(/\{\{pr_merge_command\}\}/g)).toHaveLength(1);
    expect(review).not.toMatch(/^\s*gh pr merge\b/m);
  });
});
