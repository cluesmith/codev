/**
 * codev init - Create a new codev project
 *
 * Creates a codev structure with protocols, roles, consult-types, and
 * resource templates copied from the embedded skeleton.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { getTemplatesDir } from '../lib/templates.js';
import { prompt, confirm } from '../lib/cli-prompts.js';
import {
  createUserDirs,
  createProjectsDir,
  copyProjectlist,
  copyProjectlistArchive,
  copyConsultTypes,
  copyResourceTemplates,
  copyRoles,
  copyProtocols,
  copySkills,
  copyRootFiles,
  createGitignore,
} from '../lib/scaffold.js';

interface InitOptions {
  yes?: boolean;
}

// prompt and confirm imported from ../lib/cli-prompts.js

/**
 * Initialize a new codev project
 */
export async function init(projectName?: string, options: InitOptions = {}): Promise<void> {
  const { yes = false } = options;

  // Determine project directory
  let targetDir: string;
  if (projectName) {
    targetDir = path.resolve(projectName);
  } else if (yes) {
    throw new Error('Project name is required when using --yes flag');
  } else {
    const name = await prompt('Project name', 'my-project');
    targetDir = path.resolve(name);
  }

  const projectBaseName = path.basename(targetDir);

  // Check if directory already exists
  if (fs.existsSync(targetDir)) {
    throw new Error(`Directory '${projectBaseName}' already exists. Use 'codev adopt' to add codev to an existing project.`);
  }

  console.log('');
  console.log(chalk.bold('Creating new codev project:'), projectBaseName);
  console.log(chalk.dim('Location:'), targetDir);
  console.log('');

  // Get configuration (interactive or defaults)
  let initGit = true;
  let skipPermissions = false;

  if (!yes) {
    initGit = await confirm('Initialize git repository?', true);
    skipPermissions = await confirm('Allow AI agents to run commands without confirmation prompts?', true);
  }

  // Create directory
  fs.mkdirSync(targetDir, { recursive: true });

  // Create minimal codev structure using shared scaffold utilities
  let fileCount = 0;

  console.log(chalk.dim('Creating minimal codev structure...'));
  console.log(chalk.dim('(Framework files provided by @cluesmith/codev at runtime)'));
  console.log('');

  // Get skeleton directory for templates
  const skeletonDir = getTemplatesDir();

  // Create user data directories (specs, plans, reviews)
  const dirsResult = createUserDirs(targetDir);
  for (const dir of dirsResult.created) {
    console.log(chalk.green('  +'), `codev/${dir}/`);
    fileCount++;
  }

  // Create projects directory for porch state files
  const projectsDirResult = createProjectsDir(targetDir);
  if (projectsDirResult.created) {
    console.log(chalk.green('  +'), 'codev/projects/');
    fileCount++;
  }

  // Create projectlist.md
  const projectlistResult = copyProjectlist(targetDir, skeletonDir);
  if (projectlistResult.copied) {
    console.log(chalk.green('  +'), 'codev/projectlist.md');
    fileCount++;
  }

  // Create projectlist-archive.md
  const archiveResult = copyProjectlistArchive(targetDir, skeletonDir);
  if (archiveResult.copied) {
    console.log(chalk.green('  +'), 'codev/projectlist-archive.md');
    fileCount++;
  }

  // Copy resource templates (lessons-learned.md, arch.md)
  const resourcesResult = copyResourceTemplates(targetDir, skeletonDir);
  for (const file of resourcesResult.copied) {
    console.log(chalk.green('  +'), `codev/resources/${file}`);
    fileCount++;
  }

  // Copy consult-types (review type prompts)
  const consultTypesResult = copyConsultTypes(targetDir, skeletonDir);
  if (consultTypesResult.directoryCreated) {
    console.log(chalk.green('  +'), 'codev/consult-types/');
    fileCount++;
  }
  for (const file of consultTypesResult.copied) {
    console.log(chalk.green('  +'), `codev/consult-types/${file}`);
    fileCount++;
  }

  // Copy role definitions (architect, builder, consultant prompts)
  const rolesResult = copyRoles(targetDir, skeletonDir);
  if (rolesResult.directoryCreated) {
    console.log(chalk.green('  +'), 'codev/roles/');
    fileCount++;
  }
  for (const file of rolesResult.copied) {
    console.log(chalk.green('  +'), `codev/roles/${file}`);
    fileCount++;
  }

  // Copy protocol definitions (required for porch orchestration)
  const protocolsResult = copyProtocols(targetDir, skeletonDir);
  if (protocolsResult.directoryCreated) {
    console.log(chalk.green('  +'), 'codev/protocols/');
    fileCount++;
  }
  for (const protocol of protocolsResult.copied) {
    console.log(chalk.green('  +'), `codev/protocols/${protocol}`);
    fileCount++;
  }

  // Copy .claude/skills/ (Claude Code slash commands)
  const skillsResult = copySkills(targetDir, skeletonDir);
  if (skillsResult.directoryCreated) {
    console.log(chalk.green('  +'), '.claude/skills/');
    fileCount++;
  }
  for (const skill of skillsResult.copied) {
    console.log(chalk.green('  +'), `.claude/skills/${skill}/`);
    fileCount++;
  }

  // Copy root files (CLAUDE.md, AGENTS.md)
  const rootResult = copyRootFiles(targetDir, skeletonDir, projectBaseName);
  for (const file of rootResult.copied) {
    console.log(chalk.green('  +'), file);
    fileCount++;
  }

  // Create .gitignore
  createGitignore(targetDir);
  console.log(chalk.green('  +'), '.gitignore');
  fileCount++;

  // Create af-config.json
  const afConfig: Record<string, unknown> = {
    shell: {
      architect: skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude',
      builder: skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude',
      shell: 'bash',
    },
  };
  fs.writeFileSync(
    path.join(targetDir, 'af-config.json'),
    JSON.stringify(afConfig, null, 2) + '\n'
  );
  console.log(chalk.green('  +'), 'af-config.json');
  fileCount++;

  // Initialize git if requested
  if (initGit) {
    const { execSync } = await import('node:child_process');
    try {
      execSync('git init', { cwd: targetDir, stdio: 'pipe' });
      console.log(chalk.green('  ✓'), 'Git repository initialized');
    } catch {
      console.log(chalk.yellow('  ⚠'), 'Failed to initialize git repository');
    }
  }

  console.log('');
  console.log(chalk.green.bold('✓'), `Created ${fileCount} files`);
  console.log('');

  // Run doctor to check dependencies
  console.log(chalk.bold('Checking environment...'));
  console.log('');
  try {
    const { execSync } = await import('node:child_process');
    execSync('codev doctor', { cwd: targetDir, stdio: 'inherit' });
  } catch {
    // doctor returns exit code 1 on failures, but init should still succeed
  }

  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log('');
  console.log(`  cd ${projectBaseName}`);
  console.log('  git remote add origin <url>  # Required for builders to create PRs');
  console.log('  af tower start               # Start the Tower daemon');
  console.log('');
  console.log(chalk.dim('For more info, see: https://github.com/cluesmith/codev'));
}
