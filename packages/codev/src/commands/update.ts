/**
 * codev update - Update codev templates and protocols
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import {
  getTemplatesDir,
  getTemplateFiles,
  hashFile,
  loadHashStore,
  saveHashStore,
  isUserDataPath,
  isUpdatableFile,
} from '../lib/templates.js';

interface UpdateOptions {
  dryRun?: boolean;
  force?: boolean;
}

interface UpdateResult {
  updated: string[];
  skipped: string[];
  conflicts: string[];
  newFiles: string[];
  rootConflicts: string[]; // CLAUDE.md, AGENTS.md conflicts
}

/**
 * Update codev templates in current project
 */
export async function update(options: UpdateOptions = {}): Promise<void> {
  const { dryRun = false, force = false } = options;
  const targetDir = process.cwd();
  const codevDir = path.join(targetDir, 'codev');

  // Check if codev exists
  if (!fs.existsSync(codevDir)) {
    throw new Error("No codev/ directory found. Use 'codev init' or 'codev adopt' first.");
  }

  console.log('');
  console.log(chalk.bold('Updating codev templates'));
  if (dryRun) {
    console.log(chalk.yellow('(dry run - no files will be changed)'));
  }
  console.log('');

  const templatesDir = getTemplatesDir();
  const templateFiles = getTemplateFiles(templatesDir);
  const currentHashes = loadHashStore(targetDir);
  const newHashes: Record<string, string> = { ...currentHashes };

  const result: UpdateResult = {
    updated: [],
    skipped: [],
    conflicts: [],
    newFiles: [],
    rootConflicts: [],
  };

  for (const relativePath of templateFiles) {
    // Skip user data files
    if (isUserDataPath(relativePath)) {
      continue;
    }

    // Only update updatable files (protocols, roles, agents, etc.)
    if (!isUpdatableFile(relativePath)) {
      continue;
    }

    const srcPath = path.join(templatesDir, relativePath);
    const destPath = path.join(codevDir, relativePath);

    // New file - copy it
    if (!fs.existsSync(destPath)) {
      if (!dryRun) {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(srcPath, destPath);
        newHashes[relativePath] = hashFile(destPath);
      }
      result.newFiles.push(relativePath);
      console.log(chalk.green('  + (new)'), `codev/${relativePath}`);
      continue;
    }

    // File exists - check if it was modified by user
    const currentHash = hashFile(destPath);
    const storedHash = currentHashes[relativePath];
    const newHash = hashFile(srcPath);

    // If the template hasn't changed, skip
    if (currentHash === newHash) {
      result.skipped.push(relativePath);
      continue;
    }

    // If force mode, overwrite everything
    if (force) {
      if (!dryRun) {
        fs.copyFileSync(srcPath, destPath);
        newHashes[relativePath] = hashFile(destPath);
      }
      result.updated.push(relativePath);
      console.log(chalk.blue('  ~ (force)'), `codev/${relativePath}`);
      continue;
    }

    // Check if user modified the file
    const userModified = storedHash && currentHash !== storedHash;

    if (userModified) {
      // User modified the file - write as .codev-new and mark as conflict
      if (!dryRun) {
        fs.copyFileSync(srcPath, destPath + '.codev-new');
      }
      result.conflicts.push(relativePath);
      console.log(chalk.yellow('  ! (conflict)'), `codev/${relativePath}`);
      console.log(chalk.dim('    New version saved as:'), `codev/${relativePath}.codev-new`);
    } else {
      // File unchanged by user - safe to overwrite
      if (!dryRun) {
        fs.copyFileSync(srcPath, destPath);
        newHashes[relativePath] = hashFile(destPath);
      }
      result.updated.push(relativePath);
      console.log(chalk.blue('  ~'), `codev/${relativePath}`);
    }
  }

  // Save updated hash store
  if (!dryRun) {
    saveHashStore(targetDir, newHashes);
  }

  // Handle root-level files (CLAUDE.md, AGENTS.md)
  const rootFiles = ['CLAUDE.md', 'AGENTS.md'];
  const skeletonTemplatesDir = path.join(templatesDir, 'templates');

  for (const fileName of rootFiles) {
    const srcPath = path.join(skeletonTemplatesDir, fileName);
    const destPath = path.join(targetDir, fileName);

    // Skip if source doesn't exist
    if (!fs.existsSync(srcPath)) {
      continue;
    }

    // New file - copy it (replacing {{PROJECT_NAME}} placeholder)
    if (!fs.existsSync(destPath)) {
      if (!dryRun) {
        const projectName = path.basename(targetDir);
        let content = fs.readFileSync(srcPath, 'utf-8');
        content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
        fs.writeFileSync(destPath, content);
      }
      result.newFiles.push(fileName);
      console.log(chalk.green('  + (new)'), fileName);
      continue;
    }

    // File exists - check if template has changed
    const currentContent = fs.readFileSync(destPath, 'utf-8');
    const projectName = path.basename(targetDir);
    let templateContent = fs.readFileSync(srcPath, 'utf-8');
    templateContent = templateContent.replace(/\{\{PROJECT_NAME\}\}/g, projectName);

    // If content is identical, skip
    if (currentContent === templateContent) {
      result.skipped.push(fileName);
      continue;
    }

    // If force mode, overwrite
    if (force) {
      if (!dryRun) {
        fs.writeFileSync(destPath, templateContent);
      }
      result.updated.push(fileName);
      console.log(chalk.blue('  ~ (force)'), fileName);
      continue;
    }

    // Content differs - save as .codev-new for merge
    if (!dryRun) {
      fs.writeFileSync(destPath + '.codev-new', templateContent);
    }
    result.rootConflicts.push(fileName);
    console.log(chalk.yellow('  ! (conflict)'), fileName);
    console.log(chalk.dim('    New version saved as:'), `${fileName}.codev-new`);
  }

  // Summary
  console.log('');
  console.log(chalk.bold('Summary:'));

  if (result.newFiles.length > 0) {
    console.log(chalk.green(`  + ${result.newFiles.length} new files`));
  }
  if (result.updated.length > 0) {
    console.log(chalk.blue(`  ~ ${result.updated.length} updated`));
  }
  if (result.skipped.length > 0) {
    console.log(chalk.dim(`  - ${result.skipped.length} unchanged (skipped)`));
  }
  if (result.conflicts.length > 0) {
    console.log(chalk.yellow(`  ! ${result.conflicts.length} codev/ conflicts`));
  }
  if (result.rootConflicts.length > 0) {
    console.log(chalk.yellow(`  ! ${result.rootConflicts.length} root conflicts`));
  }

  if (result.newFiles.length === 0 && result.updated.length === 0 && result.conflicts.length === 0 && result.rootConflicts.length === 0) {
    console.log(chalk.dim('  No updates available - already up to date!'));
  }

  if (dryRun) {
    console.log('');
    console.log(chalk.yellow('Dry run complete. Run without --dry-run to apply changes.'));
    return;
  }

  // Combine all conflicts for Claude merge
  const allConflicts = [
    ...result.conflicts.map(f => `codev/${f}`),
    ...result.rootConflicts,
  ];

  // If there are any conflicts, spawn Claude to merge
  if (allConflicts.length > 0) {
    console.log('');
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log(chalk.cyan('  Launching Claude to merge conflicts...'));
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════'));
    console.log('');

    const fileList = allConflicts.join(', ');
    const mergePrompt = `Merge the following files from their .codev-new versions: ${fileList}. For each file, add new sections from the .codev-new version, preserve my customizations, then delete the .codev-new file when done.`;

    // Spawn Claude interactively with merge instructions as initial prompt
    const claude = spawn('claude', [mergePrompt], {
      stdio: 'inherit',
      cwd: targetDir,
    });

    claude.on('error', (err) => {
      console.error(chalk.red('Failed to launch Claude:'), err.message);
      console.log('');
      console.log('Please merge the conflicts manually:');
      for (const file of allConflicts) {
        console.log(chalk.dim(`  ${file} ← ${file}.codev-new`));
      }
    });
  }
}
