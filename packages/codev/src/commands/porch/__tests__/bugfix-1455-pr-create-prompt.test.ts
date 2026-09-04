/**
 * Regression test for GitHub Issue #1455 — the prompt-rendering half.
 *
 * Phase prompts must not name a forge CLI. They carry `{{pr_create_command}}`,
 * and porch substitutes the resolved `pr-create` concept command, the same way
 * it already injects `pr-merge` into the merge task. Without the substitution
 * the token would reach the builder unrendered, or (before the fix) the prompt
 * would simply say `gh pr create` on a Gitea project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPhasePrompt } from '../prompts.js';
import type { ProjectState, Protocol } from '../types.js';

// No real `gh issue view` round-trip from getProjectSummary.
vi.mock('../../../lib/github.js', () => ({
  fetchIssue: vi.fn().mockResolvedValue(null),
}));

const forgeScripts = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'forge');

const protocol = {
  name: 'bugfix',
  phases: [{ id: 'pr', name: 'PR', type: 'once', build: { prompt: 'pr.md' } }],
} as unknown as Protocol;

const state = {
  id: '1455',
  title: 'pr-create-is-not-a-forge-concept',
  protocol: 'bugfix',
  phase: 'pr',
  plan_phases: [],
  current_plan_phase: null,
  gates: {},
  iteration: 1,
  build_complete: false,
  history: [],
  started_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as unknown as ProjectState;

describe('#1455 — porch substitutes {{pr_create_command}}', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-create-prompt-1455-'));
    const prompts = path.join(tmp, 'codev', 'protocols', 'bugfix', 'prompts');
    fs.mkdirSync(prompts, { recursive: true });
    fs.writeFileSync(
      path.join(prompts, 'pr.md'),
      'CODEV_PR_TITLE="t" CODEV_PR_BODY="b" {{pr_create_command}}\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeForgeConfig(forge: Record<string, unknown>): void {
    fs.mkdirSync(path.join(tmp, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.codev', 'config.json'), JSON.stringify({ forge }));
  }

  it('renders the gitea script for a project with forge.provider: gitea', async () => {
    writeForgeConfig({ provider: 'gitea' });
    const prompt = await buildPhasePrompt(tmp, state, protocol);

    expect(prompt).toContain(path.join(forgeScripts, 'gitea', 'pr-create.sh'));
    expect(prompt).not.toContain('{{pr_create_command}}');
    expect(prompt).not.toContain('gh pr create');
  });

  it('renders the github script when no forge is configured', async () => {
    const prompt = await buildPhasePrompt(tmp, state, protocol);
    expect(prompt).toContain(path.join(forgeScripts, 'github', 'pr-create.sh'));
    expect(prompt).not.toContain('{{pr_create_command}}');
  });

  it('renders a manual override', async () => {
    writeForgeConfig({ 'pr-create': '/opt/forge/open-pr.sh' });
    const prompt = await buildPhasePrompt(tmp, state, protocol);
    expect(prompt).toContain('/opt/forge/open-pr.sh');
  });

  it('tells the builder to open the PR by hand when the concept is disabled', async () => {
    writeForgeConfig({ 'pr-create': null });
    const prompt = await buildPhasePrompt(tmp, state, protocol);
    expect(prompt).toContain('open the PR manually');
    expect(prompt).not.toContain('{{pr_create_command}}');
    // And it must fail rather than being a comment the shell happily ignores —
    // otherwise running the block "succeeds" without opening anything.
    expect(prompt).toContain('false;');
    expect(prompt).not.toMatch(/^# pr-create is disabled/m);
  });

  /**
   * The shipped prompt block, executed for real.
   *
   * Inline commands are a documented override form (`"pr-merge": "glab mr merge
   * \"$CODEV_PR_NUMBER\" --yes"`). With the inputs written as an assignment
   * prefix (`CODEV_PR_TITLE=… cmd --title "$CODEV_PR_TITLE"`) the calling shell
   * expands the argument BEFORE applying the assignment, so an inline override
   * receives an empty title and body — while a script reading the environment
   * works fine, which is what makes it easy to miss.
   */
  it('an inline override receives the title and body the prompt sets', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
    fs.copyFileSync(
      path.join(repoRoot, 'codev/protocols/bugfix/prompts/pr.md'),
      path.join(tmp, 'codev', 'protocols', 'bugfix', 'prompts', 'pr.md'),
    );
    writeForgeConfig({
      'pr-create': `sh -c 'printf "%s" "$1" > title.txt; printf "%s" "$2" > body.txt' _ "$CODEV_PR_TITLE" "$CODEV_PR_BODY"`,
    });

    const prompt = await buildPhasePrompt(tmp, state, protocol);
    const block = prompt.match(/```bash\n(export CODEV_PR_TITLE[\s\S]*?)```/)?.[1];
    expect(block, 'PR-creating block not found in the rendered prompt').toBeTruthy();

    execFileSync('sh', ['-c', block!], { cwd: tmp });

    expect(fs.readFileSync(path.join(tmp, 'title.txt'), 'utf-8')).toContain('Fix #');
    const body = fs.readFileSync(path.join(tmp, 'body.txt'), 'utf-8');
    expect(body).toContain('## Summary');
    expect(body).toContain('Fixes #');
  });
});
