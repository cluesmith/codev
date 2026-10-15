/**
 * codev adopt - Add codev to an existing project
 *
 * Creates the minimal user-owned Codev structure and materializes missing
 * provider skills, root instructions, and governance starters from the
 * embedded skeleton. Framework files resolve from the package at runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { getTemplatesDir } from '../lib/templates.js';
import { confirm } from '../lib/cli-prompts.js';
import { shouldOfferBootstrap } from '../lib/governance-bootstrap.js';
import { spawnAgentProcess, type AgentExit } from '../lib/agent-process.js';
import {
  createUserDirs,
  createProjectsDir,
  copySkills,
  copyRootFiles,
  copyHotTierDefaults,
  copyColdTierDefaults,
} from '../lib/scaffold.js';
import { updateGitignore } from '../lib/gitignore.js';

interface AdoptOptions {
  yes?: boolean;
}

/** Seams for tests: every prompt and every child session is replaceable. */
export interface AdoptDeps {
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** Run the interactive conflict-merge session and wait for it to exit. */
  runMergeSession(prompt: string, cwd: string): Promise<AgentExit>;
  /** Whether `codev bootstrap-docs` has eligible files and something to document. */
  shouldOfferBootstrap(root: string): boolean;
  /** Run the bootstrap pass (it shows its own launch statement and confirm); returns its exit code. */
  runBootstrap(root: string): Promise<number>;
}

function defaultDeps(): AdoptDeps {
  return {
    confirm,
    runMergeSession: (prompt, cwd) => spawnAgentProcess({ executable: 'claude', args: [prompt] }, cwd),
    shouldOfferBootstrap: root => shouldOfferBootstrap(root, path.join(getTemplatesDir(), 'templates')),
    runBootstrap: async root => {
      // Loaded only when the user accepts the offer, so `codev` startup does not pay for it.
      const { runBootstrapDocs } = await import('./bootstrap-docs.js');
      return (await runBootstrapDocs({ cwd: root })).exitCode;
    },
  };
}

interface Conflict {
  file: string;
  type: 'file' | 'directory';
}

// confirm imported from ../lib/cli-prompts.js

/**
 * Detect conflicts with existing files
 */
function detectConflicts(targetDir: string): Conflict[] {
  const conflicts: Conflict[] = [];

  // Check for codev/ directory
  const codevDir = path.join(targetDir, 'codev');
  if (fs.existsSync(codevDir)) {
    conflicts.push({ file: 'codev/', type: 'directory' });
  }

  // Check for CLAUDE.md
  const claudeMd = path.join(targetDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    conflicts.push({ file: 'CLAUDE.md', type: 'file' });
  }

  // Check for AGENTS.md
  const agentsMd = path.join(targetDir, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    conflicts.push({ file: 'AGENTS.md', type: 'file' });
  }

  return conflicts;
}

/**
 * Add codev to an existing project.
 *
 * Once adoption succeeds, a bootstrap pass the human ran never fails adopt: its problems are
 * in its own summary (`codev bootstrap-docs` run directly keeps its non-zero exit).
 */
export async function adopt(options: AdoptOptions = {}, overrides: Partial<AdoptDeps> = {}): Promise<void> {
  const { yes = false } = options;
  const deps: AdoptDeps = { ...defaultDeps(), ...overrides };
  const targetDir = process.cwd();
  const projectName = path.basename(targetDir);

  console.log('');
  console.log(chalk.bold('Adding codev to existing project:'), projectName);
  console.log(chalk.dim('Location:'), targetDir);
  console.log('');

  // Check for codev/ directory - can't adopt if it exists
  const codevDir = path.join(targetDir, 'codev');
  if (fs.existsSync(codevDir)) {
    throw new Error("codev/ directory already exists. Use 'codev update' to update existing installation.");
  }

  // Detect other conflicts
  const conflicts = detectConflicts(targetDir).filter(c => c.file !== 'codev/');

  if (conflicts.length > 0 && !yes) {
    console.log(chalk.yellow('Potential conflicts detected:'));
    console.log('');
    for (const conflict of conflicts) {
      console.log(chalk.yellow('  ⚠'), conflict.file, chalk.dim(`(${conflict.type})`));
    }
    console.log('');

    const proceed = await deps.confirm('Continue and skip conflicting files?', false);
    if (!proceed) {
      console.log(chalk.dim('Aborted.'));
      process.exit(0);
    }
  }

  // Ask about permission mode
  let skipPermissions = false;
  if (!yes) {
    skipPermissions = await deps.confirm('Allow AI agents to run commands without confirmation prompts?', true);
  }

  // Create minimal codev structure using shared scaffold utilities
  let fileCount = 0;
  let skippedCount = 0;

  console.log(chalk.dim('Creating minimal codev structure...'));
  console.log(chalk.dim('(Framework files provided by @cluesmith/codev at runtime)'));
  console.log('');

  // Get skeleton directory for templates
  const skeletonDir = getTemplatesDir();

  // Create user data directories (specs, plans, reviews) - skip existing
  const dirsResult = createUserDirs(targetDir, { skipExisting: true });
  for (const dir of dirsResult.created) {
    console.log(chalk.green('  +'), `codev/${dir}/`);
    fileCount++;
  }

  // Create projects directory for porch state files - skip existing
  const projectsDirResult = createProjectsDir(targetDir, { skipExisting: true });
  if (projectsDirResult.created) {
    console.log(chalk.green('  +'), 'codev/projects/');
    fileCount++;
  }

  // Framework files (protocols, roles, consult-types, templates) are NOT copied.
  // They resolve at runtime from the installed npm package via the unified file resolver.
  // Existing local copies in codev/ are left in place — they take precedence via the resolution chain.

  // Copy provider-native skills, preserving existing skill directories.
  const skillsResult = copySkills(targetDir, skeletonDir, { skipExisting: true });
  for (const directory of skillsResult.directoriesCreated) {
    console.log(chalk.green('  +'), directory);
    fileCount++;
  }
  for (const skill of skillsResult.copied) {
    console.log(chalk.green('  +'), skill);
    fileCount++;
  }

  // Copy root files with conflict handling
  const rootResult = copyRootFiles(targetDir, skeletonDir, projectName, { handleConflicts: true });
  for (const file of rootResult.copied) {
    console.log(chalk.green('  +'), file);
    fileCount++;
  }
  for (const file of rootResult.conflicts) {
    console.log(chalk.yellow('  !'), file, chalk.dim('(conflict - .codev-new created)'));
    skippedCount++;
  }

  // Materialize the hot-tier files (Spec 987), skip-existing so a curated copy is preserved.
  // The interactive managed block is injected on the next `codev update` (which calls
  // syncHotContextBlock) — adopt intentionally does not modify a pre-existing CLAUDE.md/AGENTS.md
  // beyond the standard .codev-new conflict path.
  for (const file of copyHotTierDefaults(targetDir, skeletonDir, { skipExisting: true }).copied) {
    console.log(chalk.green('  +'), `codev/resources/${file}`);
    fileCount++;
  }

  // Materialize the cold-tier governance files (arch.md, lessons-learned.md) from the
  // skeleton's *.starter.md placeholders (issue #1012), skip-existing so a curated copy is preserved.
  for (const file of copyColdTierDefaults(targetDir, skeletonDir, { skipExisting: true }).copied) {
    console.log(chalk.green('  +'), `codev/resources/${file}`);
    fileCount++;
  }

  // Create .codev/config.json if it doesn't exist
  const codevConfigDir = path.join(targetDir, '.codev');
  const codevConfigPath = path.join(codevConfigDir, 'config.json');
  if (!fs.existsSync(codevConfigPath)) {
    if (!fs.existsSync(codevConfigDir)) {
      fs.mkdirSync(codevConfigDir, { recursive: true });
    }
    const codevConfig: Record<string, unknown> = {
      shell: {
        architect: skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude',
        builder: skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude',
        shell: 'bash',
      },
      worktree: {
        '//': 'Opt-in runnable worktree config. See CLAUDE.md > Runnable Worktrees for stack-specific recipes (pnpm, npm, yarn, bun, cargo, poetry/uv, go mod). Defaults shown below are no-ops; fill in to enable.',
        symlinks: [],
        postSpawn: [],
      },
    };
    fs.writeFileSync(codevConfigPath, JSON.stringify(codevConfig, null, 2) + '\n');
    console.log(chalk.green('  +'), '.codev/config.json');
    fileCount++;
  }

  // Update or create .gitignore
  const gitResult = updateGitignore(targetDir);
  if (gitResult.created) {
    console.log(chalk.green('  +'), '.gitignore');
    fileCount++;
  } else if (gitResult.updated) {
    console.log(chalk.green('  ~'), '.gitignore', chalk.dim('(updated)'));
  }

  console.log('');
  console.log(chalk.green.bold('✓'), `Created ${fileCount} files`);
  if (skippedCount > 0) {
    console.log(chalk.yellow('  ⚠'), `Skipped ${skippedCount} existing files`);
  }

  // If there are root conflicts (CLAUDE.md, AGENTS.md), launch Claude to merge them.
  const mergeConflicts = async (): Promise<void> => {
    console.log('');
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log(chalk.cyan('  Launching Claude to merge conflicts...'));
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log('');

    const mergePrompt = `Merge ${rootResult.conflicts.join(' and ')} from the .codev-new versions. Add new sections from the .codev-new files, preserve my customizations, then delete the .codev-new files when done.`;

    const mergeExit = await deps.runMergeSession(mergePrompt, targetDir);
    if (mergeExit.error !== undefined) {
      console.error(chalk.red('Failed to launch Claude:'), mergeExit.error);
      console.log('');
      console.log('Please merge the conflicts manually:');
      for (const file of rootResult.conflicts) {
        console.log(chalk.dim(`  ${file} ← ${file}.codev-new`));
      }
    }
  };
  const hasConflicts = rootResult.conflicts.length > 0;

  // Interactively, the merge session is awaited: the bootstrap offer below must never share
  // the terminal with a live session. Then offer the governance-doc bootstrap (Spec 1797)
  // on a project with something to document. With -y nothing is offered, so nothing waits on
  // the merge; it launches after "Next steps" as before, and the command is listed instead.
  if (hasConflicts && !yes) {
    await mergeConflicts();
  }
  let bootstrapPending = deps.shouldOfferBootstrap(targetDir);
  if (bootstrapPending && !yes) {
    console.log('');
    if (await deps.confirm('Draft the governance docs from this codebase now?', false)) {
      console.log('');
      // Adoption has succeeded by now; a pass that reports problems says so in its own
      // summary and does not turn adopt into a failure (`codev bootstrap-docs` run directly
      // keeps its non-zero exit).
      const bootstrapExit = await deps.runBootstrap(targetDir);
      if (bootstrapExit !== 0) {
        console.log('');
        console.log(chalk.yellow('Codev is adopted. The bootstrap pass reported problems (see its summary above); review the drafts before committing.'));
      }
      // A declined or manual pass leaves the placeholders, so the command is still worth listing.
      bootstrapPending = deps.shouldOfferBootstrap(targetDir);
    }
  }

  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log('');
  if (bootstrapPending) {
    console.log('  codev bootstrap-docs          # Draft the governance docs from this codebase');
  }
  console.log('  consult plan                 # Review the plan with an architect');
  console.log('  afx tower start               # Start the Tower daemon');
  console.log('  afx spawn                     # Spawn a builder to implement the plan');
  console.log('');
  console.log(chalk.dim('For more info, see: https://github.com/cluesmith/codev'));

  if (hasConflicts && yes) {
    mergeConflicts();
  }
}
