/**
 * Tips for the Tip of the Day banner.
 * Each tip is a plain string with backtick-delimited code spans.
 */
export const tips: string[] = [
  // af CLI shortcuts
  'Use `af spawn --task "description"` for quick one-off tasks that don\'t need a spec',
  'Run `af status` to see all active builders and their current phase',
  'Use `af send architect "message"` to notify the architect when you need guidance',
  'Run `af cleanup --project 0042` after merging a PR to clean up the worktree',
  'Use `af spawn --soft -p 42` for flexible, protocol-guided work without strict porch orchestration',
  'Run `af dash start` to launch the architect dashboard',
  'Use `af spawn 42 --resume` to resume an existing builder worktree instead of recreating it',
  'Use `af open file.ts` to open a file in the dashboard annotation viewer',
  'Run `af tower start` to start the Tower server — there is no `restart` command, use stop then start',
  'Check `af-config.json` at your project root to customize builder and architect commands',

  // porch commands
  'Run `porch pending` to see all gates waiting for your approval across all projects',
  'Use `porch status 42` to see detailed phase status for a specific project',
  'Run `porch next 42` to get the next tasks for a project',
  'Use `porch done 42` to signal that the current phase work is complete',
  'Gates like `spec-approval` and `plan-approval` require explicit human approval before advancing',
  'Porch tracks state in `codev/projects/<id>/status.yaml` — never edit this file directly',
  'Use `porch approve 42 spec-approval` to approve a gate (human only)',
  'Porch drives SPIR, TICK, and BUGFIX protocols via a state machine with automatic consultations',

  // consult usage
  'Use `consult -m gemini --type integration` for integration reviews with Gemini',
  'Run `consult -m gemini --protocol spir --type spec` to get a Gemini review of your specification',
  'Use `consult -m codex --protocol spir --type spec` for a focused specification review',
  'Run `consult -m claude --protocol spir --type plan` to get feedback on your implementation plan',
  'The `consult` CLI supports three models: `gemini`, `codex`, and `claude`',
  'Use `consult -m gemini --prompt "your question"` to ask Gemini a general question with codebase context',
  'Say "cmap the PR" to run all three consultations in parallel in the background',
  'Consultations are enabled by default in SPIR — say "without consultation" to skip them',

  // Workflow best practices
  'Commit specs and plans to `main` before spawning — builders branch from HEAD',
  'Always add files explicitly with `git add file1 file2` — never use `git add .` or `git add -A`',
  'Use SPIR for new features, TICK for amendments to existing specs, and BUGFIX for issue fixes',
  'Each SPIR feature produces exactly three documents: spec, plan, and review',
  'Specs define WHAT to build, plans define HOW — keep them as separate documents',
  'Add YAML frontmatter with `approved` and `validated` fields to skip phases in porch',
  'Run `codev doctor` to check that your environment is set up correctly',
  'Use `--merge` (not squash) when merging PRs — individual commits document the development process',
  'The TICK protocol modifies spec and plan in-place and creates a new review file',
  'BUGFIX protocol uses GitHub Issues as source of truth — no spec/plan artifacts needed',
  'Run `tokei -e "node_modules" -e ".git" -e "dist" .` to measure codebase size',
  'Use `codev adopt` to set up Codev in an existing project',

  // Dashboard features
  'Click a builder card in the Work view to jump to its terminal tab',
  'The file panel in Work view lets you browse project files without leaving the dashboard',
  'Use the Refresh button to update builder status, PRs, and backlog data',
  'The dashboard shows active builders, pending PRs, and backlog items in one view',
  'Click the file panel toggle arrow to expand or collapse the file browser',
  'The dashboard supports both desktop split-pane and mobile single-pane layouts',
  'Tab indicators show builder status at a glance — active, waiting, or implementing',
  'Use the `+ Shell` button to quickly open a new shell terminal tab',

  // Protocol tips
  'The SPIR protocol has four phases: Specify, Plan, Implement (IDE loop), and Review',
  'Each implementation phase follows the IDE cycle: Implement, Defend (test), Evaluate',
  'The EXPERIMENT protocol is for testing new approaches — use it for proof-of-concept work',
  'The MAINTAIN protocol handles code hygiene and documentation sync',
  'Run 3-way consultations at each SPIR checkpoint for spec, plan, and implementation reviews',
];
