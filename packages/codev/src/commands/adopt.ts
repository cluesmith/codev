/**
 * codev adopt - Add codev to an existing project
 *
 * Creates a minimal codev structure. Framework files (protocols, roles)
 * are provided by the embedded skeleton at runtime, not copied to the project.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { getTemplatesDir } from '../lib/templates.js';
import { confirm } from '../lib/cli-prompts.js';
import {
  createUserDirs,
  copyProjectlist,
  copyProjectlistArchive,
  copyConsultTypes,
  copyResourceTemplates,
  copyRootFiles,
  updateGitignore,
} from '../lib/scaffold.js';

interface AdoptOptions {
  yes?: boolean;
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
 * Add codev to an existing project
 */
export async function adopt(options: AdoptOptions = {}): Promise<void> {
  const { yes = false } = options;
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

    const proceed = await confirm('Continue and skip conflicting files?', false);
    if (!proceed) {
      console.log(chalk.dim('Aborted.'));
      process.exit(0);
    }
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

  // Create projectlist.md - skip if exists
  const projectlistResult = copyProjectlist(targetDir, skeletonDir, { skipExisting: true });
  if (projectlistResult.copied) {
    console.log(chalk.green('  +'), 'codev/projectlist.md');
    fileCount++;
  }

  // Create projectlist-archive.md - skip if exists
  const archiveResult = copyProjectlistArchive(targetDir, skeletonDir, { skipExisting: true });
  if (archiveResult.copied) {
    console.log(chalk.green('  +'), 'codev/projectlist-archive.md');
    fileCount++;
  }

  // Copy resource templates - skip existing
  const resourcesResult = copyResourceTemplates(targetDir, skeletonDir, { skipExisting: true });
  for (const file of resourcesResult.copied) {
    console.log(chalk.green('  +'), `codev/resources/${file}`);
    fileCount++;
  }

  // Copy consult-types - skip existing
  const consultTypesResult = copyConsultTypes(targetDir, skeletonDir, { skipExisting: true });
  if (consultTypesResult.directoryCreated) {
    console.log(chalk.green('  +'), 'codev/consult-types/');
    fileCount++;
  }
  for (const file of consultTypesResult.copied) {
    console.log(chalk.green('  +'), `codev/consult-types/${file}`);
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
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log('');
  console.log('  git remote -v                # Verify remote is configured (required for builders)');
  console.log('  codev doctor                 # Check dependencies');
  console.log('  af start                     # Start the architect dashboard');
  console.log('');
  console.log(chalk.dim('For more info, see: https://github.com/cluesmith/codev'));

  // If there are root conflicts (CLAUDE.md, AGENTS.md), spawn Claude to merge
  if (rootResult.conflicts.length > 0) {
    console.log('');
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log(chalk.cyan('  Launching Claude to merge conflicts...'));
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log('');

    const mergePrompt = `Merge ${rootResult.conflicts.join(' and ')} from the .codev-new versions. Add new sections from the .codev-new files, preserve my customizations, then delete the .codev-new files when done.`;

    // Spawn Claude interactively with merge instructions as initial prompt
    const claude = spawn('claude', [mergePrompt], {
      stdio: 'inherit',
      cwd: targetDir,
    });

    claude.on('error', (err) => {
      console.error(chalk.red('Failed to launch Claude:'), err.message);
      console.log('');
      console.log('Please merge the conflicts manually:');
      for (const file of rootResult.conflicts) {
        console.log(chalk.dim(`  ${file} ← ${file}.codev-new`));
      }
    });
  }
}
