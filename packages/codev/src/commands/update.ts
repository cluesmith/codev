/**
 * codev update - Migrate config and refresh Claude-specific files.
 *
 * Two responsibilities:
 * A. One-time migration (runs once, skipped on subsequent runs):
 *    1. Move af-config.json → .codev/config.json
 *    2. Clean unmodified skeleton files (using .update-hashes.json)
 *    3. Preserve user-modified files as local overrides
 *    4. Remove .update-hashes.json
 *
 * B. Claude-specific file refresh (runs every time):
 *    1. Update CLAUDE.md, AGENTS.md, .claude/skills/ from package
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { deepMerge } from '../lib/config.js';
import chalk from 'chalk';
import {
  getTemplatesDir,
  hashFile,
  loadHashStore,
} from '../lib/templates.js';
import { copySkills, copyRootFiles } from '../lib/scaffold.js';

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
  migrated?: boolean;
  cleanedFiles?: string[];
  preservedFiles?: string[];
  error?: string;
}

/**
 * Check if migration is needed (af-config.json exists or .update-hashes.json exists).
 */
function needsMigration(targetDir: string): boolean {
  return (
    fs.existsSync(path.join(targetDir, 'af-config.json')) ||
    fs.existsSync(path.join(targetDir, 'codev', '.update-hashes.json'))
  );
}

/**
 * Run one-time migration from af-config.json to .codev/config.json
 * and clean unmodified skeleton files.
 */
function runMigration(
  targetDir: string,
  dryRun: boolean,
  log: (...args: unknown[]) => void,
): { migrated: boolean; cleaned: string[]; preserved: string[] } {
  const cleaned: string[] = [];
  const preserved: string[] = [];

  log(chalk.bold('Running migration to .codev/ configuration...'));
  log('');

  // 1. Move af-config.json → .codev/config.json
  const afConfigPath = path.join(targetDir, 'af-config.json');
  const codevConfigDir = path.join(targetDir, '.codev');
  const codevConfigPath = path.join(codevConfigDir, 'config.json');

  if (fs.existsSync(afConfigPath)) {
    if (!dryRun) {
      if (!fs.existsSync(codevConfigDir)) {
        fs.mkdirSync(codevConfigDir, { recursive: true });
      }
      if (!fs.existsSync(codevConfigPath)) {
        // No .codev/config.json yet — move af-config.json there
        fs.copyFileSync(afConfigPath, codevConfigPath);
        fs.unlinkSync(afConfigPath);
        log(chalk.blue('  ~ (migrated)'), 'af-config.json → .codev/config.json');
      } else {
        // Both exist — merge af-config.json into .codev/config.json to preserve customizations
        try {
          const afContent = JSON.parse(fs.readFileSync(afConfigPath, 'utf-8'));
          const existingContent = JSON.parse(fs.readFileSync(codevConfigPath, 'utf-8'));
          // deepMerge imported at top of file
          const merged = deepMerge(existingContent, afContent);
          fs.writeFileSync(codevConfigPath, JSON.stringify(merged, null, 2) + '\n');
          fs.unlinkSync(afConfigPath);
          log(chalk.blue('  ~ (merged)'), 'af-config.json merged into .codev/config.json');
        } catch (err) {
          log(chalk.yellow('  ⚠ (preserved)'), 'af-config.json — merge failed, kept for manual review');
          log(chalk.dim(`    Error: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    } else {
      log(chalk.blue('  ~ (would migrate)'), 'af-config.json → .codev/config.json');
    }
  }

  // 2. Clean unmodified skeleton files using .update-hashes.json
  const hashStorePath = path.join(targetDir, 'codev', '.update-hashes.json');
  if (fs.existsSync(hashStorePath)) {
    const hashes = loadHashStore(targetDir);

    for (const [relativePath, storedHash] of Object.entries(hashes)) {
      const filePath = path.join(targetDir, 'codev', relativePath);
      if (!fs.existsSync(filePath)) continue;

      const currentHash = hashFile(filePath);
      if (currentHash === storedHash) {
        // File unmodified — safe to remove (falls back to package at runtime)
        if (!dryRun) {
          fs.unlinkSync(filePath);
        }
        cleaned.push(`codev/${relativePath}`);
        log(chalk.red('  - (cleaned)'), `codev/${relativePath}`, chalk.dim('(unmodified, falls back to package)'));
      } else {
        // File modified by user — preserve as local override
        preserved.push(`codev/${relativePath}`);
        log(chalk.green('  ✓ (preserved)'), `codev/${relativePath}`, chalk.dim('(user-modified, kept as override)'));
      }
    }

    // 3. Remove .update-hashes.json (no longer needed)
    if (!dryRun) {
      fs.unlinkSync(hashStorePath);
    }
    log(chalk.red('  - (removed)'), 'codev/.update-hashes.json');
  }

  // Clean up legacy codev/bin directory
  const legacyBinDir = path.join(targetDir, 'codev', 'bin');
  if (fs.existsSync(legacyBinDir)) {
    if (!dryRun) {
      fs.rmSync(legacyBinDir, { recursive: true });
    }
    log(chalk.red('  - (removed)'), 'codev/bin/ (deprecated)');
  }

  return { migrated: true, cleaned, preserved };
}

/**
 * Update codev — migrate config and refresh Claude-specific files.
 */
export async function update(options: UpdateOptions = {}): Promise<UpdateResult> {
  const { dryRun = false, force = false, agent = false } = options;
  const targetDir = process.cwd();
  const codevDir = path.join(targetDir, 'codev');

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
    log(chalk.bold('Updating codev'));
    if (dryRun) {
      log(chalk.yellow('(dry run - no files will be changed)'));
    }
    log('');

    // --- A. One-time migration ---
    if (needsMigration(targetDir)) {
      const migration = runMigration(targetDir, dryRun, log);
      result.migrated = migration.migrated;
      result.cleanedFiles = migration.cleaned;
      result.preservedFiles = migration.preserved;
      log('');
    } else {
      log(chalk.dim('  Migration already complete.'));
    }

    // --- B. Claude-specific file refresh (runs every time) ---
    log('');
    log(chalk.bold('Refreshing Claude-specific files...'));
    log('');

    const templatesDir = getTemplatesDir();

    // Update .claude/skills/
    if (!dryRun) {
      // Update skills — add new ones but preserve user-customized existing skills
      const skillsResult = copySkills(targetDir, templatesDir, { skipExisting: true });
      for (const skill of skillsResult.copied) {
        const fullPath = `.claude/skills/${skill}/`;
        result.newFiles.push(fullPath);
        log(chalk.green('  + (new)'), fullPath);
      }
    }

    // Update root files (CLAUDE.md, AGENTS.md)
    const projectName = path.basename(targetDir);
    if (force) {
      const rootResult = copyRootFiles(targetDir, templatesDir, projectName);
      for (const file of rootResult.copied) {
        result.updated.push(file);
        log(chalk.blue('  ~ (updated)'), file);
      }
    } else {
      const rootResult = copyRootFiles(targetDir, templatesDir, projectName, { handleConflicts: true });
      for (const file of rootResult.copied) {
        result.newFiles.push(file);
        log(chalk.green('  + (new)'), file);
      }
      for (const file of rootResult.conflicts) {
        result.rootConflicts.push({
          file,
          codevNew: `${file}.codev-new`,
          reason: 'Content differs from template',
        });
        log(chalk.yellow('  ! (conflict)'), file);
        log(chalk.dim('    New version saved as:'), `${file}.codev-new`);
      }
    }

    // Summary
    log('');
    log(chalk.bold('Summary:'));

    if (result.migrated) {
      log(chalk.blue(`  Migration: ${result.cleanedFiles?.length || 0} files cleaned, ${result.preservedFiles?.length || 0} preserved`));
    }
    if (result.newFiles.length > 0) {
      log(chalk.green(`  + ${result.newFiles.length} new files`));
    }
    if (result.updated.length > 0) {
      log(chalk.blue(`  ~ ${result.updated.length} updated`));
    }
    if (result.rootConflicts.length > 0) {
      log(chalk.yellow(`  ! ${result.rootConflicts.length} conflicts`));
    }

    if (!result.migrated && result.newFiles.length === 0 && result.updated.length === 0 && result.rootConflicts.length === 0) {
      log(chalk.dim('  Already up to date!'));
    }

    if (dryRun) {
      log('');
      log(chalk.yellow('Dry run complete. Run without --dry-run to apply changes.'));
      return result;
    }

    if (agent) {
      return result;
    }

    // Combine all conflicts for Claude merge
    const allConflicts = result.rootConflicts.map(c => c.file);

    if (allConflicts.length > 0) {
      log('');
      log(chalk.cyan('Launching Claude to merge conflicts...'));
      log('');

      const fileList = allConflicts.join(', ');
      const mergePrompt = `Merge the following files from their .codev-new versions: ${fileList}. For each file, add new sections from the .codev-new version, preserve my customizations, then delete the .codev-new file when done.`;

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
