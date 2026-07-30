/**
 * The `consult` command's flag registration and its mapping onto `ConsultOptions`.
 *
 * Extracted from cli.ts (spec 1286) because those two things drifting apart is a real failure
 * class, not a hypothetical one: `--model-id` shipped registered, parsed, documented in `--help`,
 * covered by passing unit tests at the runner level — and completely inert, because the action
 * built its options object field-by-field and simply didn't copy it across. Nothing failed loudly;
 * the flag just did nothing.
 *
 * Keeping the registration and the mapping in one file lets a unit test compare them directly:
 * commander can report every option it registered, so the test asserts each one is forwarded.
 * That check runs in the normal test suite, so the next dropped field fails at the phase that
 * introduces it rather than in a reviewer's manual run.
 */

import type { Command } from 'commander';
import type { ConsultOptions } from './index.js';

/**
 * Flags that belong to `consult stats`, not to a consultation.
 *
 * These are registered on the same command (stats is a subcommand argument, not a separate
 * commander command) but are handed to `handleStats`, so they are deliberately absent from
 * `ConsultOptions`. The forwarding test skips exactly these and nothing else.
 */
export const STATS_ONLY_FLAGS = ['days', 'project', 'last', 'json'] as const;

/** Register every `consult` flag on a command. */
export function registerConsultOptions(cmd: Command): Command {
  return cmd
    .option('-m, --model <model>', 'Model to use (gemini, codex, claude, hermes, or aliases: pro, gpt, opus)')
    .option('--prompt <text>', 'Inline prompt (general mode)')
    .option('--prompt-file <path>', 'Prompt file path (general mode)')
    .option('--protocol <name>', 'Protocol name: spir, aspir, air, bugfix, pir, maintain')
    .option('-t, --type <type>', 'Review type: spec, plan, impl, pr, phase, integration')
    .option('--issue <number>', 'Issue number (required from architect context)')
    .option('--branch <ref>', 'Read spec/plan artifacts from this git ref instead of the local workspace (e.g. `origin/builder/777-foo` or `builder/777-foo`). Defaults to the PR\'s head branch when --issue resolves to a PR. Note: this only changes the artifact source — for --type impl, the diff scope is always the PR\'s head→base, not the --branch ref.')
    .option('--base <ref>', 'For --type integration: anchor the diff on this base branch (e.g. `ci`), computed locally as `git diff origin/<base>...origin/<head>` (three-dot). Use in repos with a long-lived integration branch ahead of the default branch so the review sees only the PR\'s actual change, not the whole integration-over-trunk delta. Defaults to config `consult.integrationBranch`; unset → the PR\'s host base (`gh pr diff`).')
    .option('--model-id <id>', 'Override the provider model id for this invocation, outranking config `consult.models.<lane>` (e.g. `--model-id gpt-5.6-sol`). Applies to whichever lane `-m` selected. Codev validates syntax only — whether the id exists is the provider\'s call, and a rejection fails loudly with no fallback.')
    .option('--output <path>', 'Write consultation output to file (used by porch)')
    .option('--plan-phase <phase>', 'Scope review to a specific plan phase (used by porch)')
    .option('--context <path>', 'Context file with previous iteration feedback (used by porch)')
    .option('--project-id <id>', 'Project ID for metrics (used by porch)')
    .option('--days <n>', 'Stats: limit to last N days (default: 30)')
    .option('--project <id>', 'Stats: filter by project ID')
    .option('--last <n>', 'Stats: show last N individual invocations')
    .option('--json', 'Stats: output as JSON');
}

/**
 * Map commander's parsed flags onto `ConsultOptions`.
 *
 * Every non-stats flag registered above must appear here — `__tests__/cli-options.test.ts` fails if
 * one is missing. Add a flag, add its line here.
 */
export function buildConsultOptions(raw: Record<string, unknown>): ConsultOptions {
  return {
    model: raw.model as string,
    prompt: raw.prompt as string | undefined,
    promptFile: raw.promptFile as string | undefined,
    protocol: raw.protocol as string | undefined,
    type: raw.type as string | undefined,
    issue: raw.issue as string | undefined,
    branch: raw.branch as string | undefined,
    base: raw.base as string | undefined,
    modelId: raw.modelId as string | undefined,
    output: raw.output as string | undefined,
    planPhase: raw.planPhase as string | undefined,
    context: raw.context as string | undefined,
    projectId: raw.projectId as string | undefined,
  };
}
