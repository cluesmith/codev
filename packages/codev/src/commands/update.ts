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
import { copyConsultTypes, copyRoles, copySkills } from '../lib/scaffold.js';

export interface UpdateOptions {
  dryRun?: boolean;
  force?: boolean;
  agent?: boolean;
}

export interface ConflictEntry {
  file: string;
  codevNew: string;
  reason: string;
}

export interface UpdateResult {
  updated: string[];
  skipped: string[];
  conflicts: ConflictEntry[];
  newFiles: string[];
  rootConflicts: ConflictEntry[];
  error?: string;
}

/**
 * Update codev templates in current project
 */
export async function update(options: UpdateOptions = {}): Promise<UpdateResult> {
  const { dryRun = false, force = false, agent = false } = options;
  const targetDir = process.cwd();
  const codevDir = path.join(targetDir, 'codev');

  // In agent mode, route human-readable output to stderr; otherwise stdout
  const log = agent ? console.error.bind(console) : console.log.bind(console);

  const result: UpdateResult = {
    updated: [],
    skipped: [],
    conflicts: [],
    newFiles: [],
    rootConflicts: [],
  };

  // Check if codev exists
  if (!fs.existsSync(codevDir)) {
    const msg = "No codev/ directory found. Use 'codev init' or 'codev adopt' first.";
    if (agent) {
      result.error = msg;
      return result;
    }
    throw new Error(msg);
  }

  try {
    log('');
    log(chalk.bold('Updating codev templates'));
    if (dryRun) {
      log(chalk.yellow('(dry run - no files will be changed)'));
    }
    log('');

    // Clean up legacy codev/bin directory (bash-based agent farm is deprecated)
    const legacyBinDir = path.join(codevDir, 'bin');
    if (fs.existsSync(legacyBinDir)) {
      if (!dryRun) {
        fs.rmSync(legacyBinDir, { recursive: true });
      }
      log(chalk.red('  - (removed)'), 'codev/bin/ (deprecated bash scripts)');
    }

    // Migrate codev/config.json to af-config.json (v2.0 change)
    const legacyConfigPath = path.join(codevDir, 'config.json');
    const newConfigPath = path.join(targetDir, 'af-config.json');
    if (fs.existsSync(legacyConfigPath) && !fs.existsSync(newConfigPath)) {
      if (!dryRun) {
        fs.copyFileSync(legacyConfigPath, newConfigPath);
        fs.unlinkSync(legacyConfigPath);
      }
      log(chalk.blue('  ~ (migrated)'), 'codev/config.json → af-config.json');
    }

    const templatesDir = getTemplatesDir();
    const templateFiles = getTemplateFiles(templatesDir);
    const currentHashes = loadHashStore(targetDir);
    const newHashes: Record<string, string> = { ...currentHashes };

    // Update consult-types (with skipExisting to preserve user customizations)
    if (!dryRun) {
      const consultTypesResult = copyConsultTypes(targetDir, templatesDir, { skipExisting: true });
      if (consultTypesResult.copied.length > 0) {
        for (const file of consultTypesResult.copied) {
          const fullPath = `codev/consult-types/${file}`;
          result.newFiles.push(fullPath);
          log(chalk.green('  + (new)'), fullPath);
        }
      }
    }

    // Update .claude/skills/ (add new skills, preserve user customizations)
    if (!dryRun) {
      const skillsResult = copySkills(targetDir, templatesDir, { skipExisting: true });
      if (skillsResult.copied.length > 0) {
        for (const skill of skillsResult.copied) {
          const fullPath = `.claude/skills/${skill}/`;
          result.newFiles.push(fullPath);
          log(chalk.green('  + (new)'), fullPath);
        }
      }
    }

    // Update codev/roles/ (add new roles for existing projects that lack them)
    if (!dryRun) {
      const rolesResult = copyRoles(targetDir, templatesDir, { skipExisting: true });
      if (rolesResult.copied.length > 0) {
        for (const file of rolesResult.copied) {
          const fullPath = `codev/roles/${file}`;
          result.newFiles.push(fullPath);
          log(chalk.green('  + (new)'), fullPath);
        }
      }
    }

    // Note: protocols are handled by the main hash-based loop below
    // This ensures proper conflict detection for user-customized prompts

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
        log(chalk.green('  + (new)'), `codev/${relativePath}`);
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
        log(chalk.blue('  ~ (force)'), `codev/${relativePath}`);
        continue;
      }

      // Check if user modified the file
      const userModified = storedHash && currentHash !== storedHash;

      if (userModified) {
        // User modified the file - write as .codev-new and mark as conflict
        if (!dryRun) {
          fs.copyFileSync(srcPath, destPath + '.codev-new');
        }
        result.conflicts.push({
          file: relativePath,
          codevNew: `codev/${relativePath}.codev-new`,
          reason: 'User modified file; new template version available',
        });
        log(chalk.yellow('  ! (conflict)'), `codev/${relativePath}`);
        log(chalk.dim('    New version saved as:'), `codev/${relativePath}.codev-new`);
      } else {
        // File unchanged by user - safe to overwrite
        if (!dryRun) {
          fs.copyFileSync(srcPath, destPath);
          newHashes[relativePath] = hashFile(destPath);
        }
        result.updated.push(relativePath);
        log(chalk.blue('  ~'), `codev/${relativePath}`);
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
        log(chalk.green('  + (new)'), fileName);
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
        log(chalk.blue('  ~ (force)'), fileName);
        continue;
      }

      // Content differs - save as .codev-new for merge
      if (!dryRun) {
        fs.writeFileSync(destPath + '.codev-new', templateContent);
      }
      result.rootConflicts.push({
        file: fileName,
        codevNew: `${fileName}.codev-new`,
        reason: 'Content differs from template',
      });
      log(chalk.yellow('  ! (conflict)'), fileName);
      log(chalk.dim('    New version saved as:'), `${fileName}.codev-new`);
    }

    // Summary
    log('');
    log(chalk.bold('Summary:'));

    if (result.newFiles.length > 0) {
      log(chalk.green(`  + ${result.newFiles.length} new files`));
    }
    if (result.updated.length > 0) {
      log(chalk.blue(`  ~ ${result.updated.length} updated`));
    }
    if (result.skipped.length > 0) {
      log(chalk.dim(`  - ${result.skipped.length} unchanged (skipped)`));
    }
    if (result.conflicts.length > 0) {
      log(chalk.yellow(`  ! ${result.conflicts.length} codev/ conflicts`));
    }
    if (result.rootConflicts.length > 0) {
      log(chalk.yellow(`  ! ${result.rootConflicts.length} root conflicts`));
    }

    if (result.newFiles.length === 0 && result.updated.length === 0 && result.conflicts.length === 0 && result.rootConflicts.length === 0) {
      log(chalk.dim('  No updates available - already up to date!'));
    }

    if (dryRun) {
      log('');
      log(chalk.yellow('Dry run complete. Run without --dry-run to apply changes.'));
      return result;
    }

    // In agent mode, skip the interactive Claude spawn
    if (agent) {
      return result;
    }

    // Combine all conflicts for Claude merge
    const allConflicts = [
      ...result.conflicts.map(c => `codev/${c.file}`),
      ...result.rootConflicts.map(c => c.file),
    ];

    // If there are any conflicts, spawn Claude to merge
    if (allConflicts.length > 0) {
      log('');
      log(chalk.cyan('═══════════════════════════════════════════════════════════'));
      log(chalk.cyan('  Launching Claude to merge conflicts...'));
      log(chalk.cyan('═══════════════════════════════════════════════════════════'));
      log('');

      const fileList = allConflicts.join(', ');
      const mergePrompt = `Merge the following files from their .codev-new versions: ${fileList}. For each file, add new sections from the .codev-new version, preserve my customizations, then delete the .codev-new file when done.`;

      // Spawn Claude interactively with merge instructions as initial prompt
      const claude = spawn('claude', [mergePrompt], {
        stdio: 'inherit',
        cwd: targetDir,
      });

      claude.on('error', (err) => {
        console.error(chalk.red('Failed to launch Claude:'), err.message);
        log('');
        log('Please merge the conflicts manually:');
        for (const file of allConflicts) {
          log(chalk.dim(`  ${file} ← ${file}.codev-new`));
        }
      });
    }

    return result;
  } catch (err) {
    if (agent) {
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }
    throw err;
  }
}
