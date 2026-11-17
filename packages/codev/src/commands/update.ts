/**
 * codev update - Migrate config and refresh AI-assistant integration files.
 *
 * Two responsibilities:
 * A. One-time migration (runs once, skipped on subsequent runs):
 *    1. Move af-config.json → .codev/config.json
 *    2. Clean unmodified skeleton files (using .update-hashes.json)
 *    3. Preserve user-modified files as local overrides
 *    4. Remove .update-hashes.json
 *
 * B. AI-assistant file refresh (runs every time):
 *    1. Update CLAUDE.md, AGENTS.md, and provider skill trees from package. A skill the
 *       user never edited is replaced; an edited one gets `.codev-new` copies (#1811).
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
import {
  copyRootFiles,
  copyHotTierDefaults,
  copyColdTierDefaults,
} from '../lib/scaffold.js';
import { syncHotContextBlock } from '../lib/managed-block.js';
import {
  backfillGitignore,
  CODEV_GITIGNORE_ENTRIES,
} from '../lib/gitignore.js';
import { auditPrGates, formatPrGateWarning } from '../lib/pr-gate-audit.js';
import { shouldOfferBootstrap } from '../lib/governance-bootstrap.js';
import { refreshSkills, CODEV_NEW_SUFFIX } from '../lib/skill-refresh.js';

export const BOOTSTRAP_DOCS_HINT =
  'Governance docs are still placeholders: run `codev bootstrap-docs` to draft them from this codebase.';

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
  gitignoreAdded?: string[];
  gitignoreSkipped?: boolean;
  /** Loud warnings for PR-producing protocol overrides missing a `pr` gate (#943). */
  prGateWarnings?: string[];
  /** Set when governance files are still starters on a non-empty project (Spec 1797). */
  bootstrapDocsHint?: string;
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
 * Update codev — migrate config and refresh AI-assistant integration files.
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

    // --- B. AI-assistant file refresh (runs every time) ---
    log('');
    log(chalk.bold('Refreshing AI-assistant files...'));
    log('');

    const templatesDir = getTemplatesDir();

    // Refresh provider-native skills (#1811): add missing ones, replace the ones the user
    // never edited, and offer an edited one's new version as `.codev-new` for the merge.
    // A dry run reports the same outcome and writes nothing.
    const skillsResult = refreshSkills(targetDir, templatesDir, { force, dryRun });
    // "would be" wording for everything this refresh only previews under --dry-run.
    let previewVerb = '';
    if (dryRun) previewVerb = 'would be ';
    for (const skill of skillsResult.added) {
      result.newFiles.push(skill);
      log(chalk.green(`  + (${previewVerb}new)`), skill);
    }
    for (const skill of skillsResult.updated) {
      result.updated.push(skill);
      log(chalk.blue(`  ~ (${previewVerb}updated)`), skill);
    }
    for (const file of skillsResult.conflicts) {
      result.conflicts.push({
        file,
        codevNew: `${file}${CODEV_NEW_SUFFIX}`,
        reason: 'Skill edited locally; new version differs',
      });
      log(chalk.yellow('  ! (conflict)'), file);
      if (dryRun) {
        log(chalk.dim('    New version would be saved as:'), `${file}${CODEV_NEW_SUFFIX}`);
      } else {
        log(chalk.dim('    New version saved as:'), `${file}${CODEV_NEW_SUFFIX}`);
      }
    }
    for (const skill of skillsResult.notRegular) {
      result.skipped.push(skill);
      log(chalk.dim('  - (skipped, symlinked, unreadable, or not a directory)'), skill);
    }

    // Update root files (CLAUDE.md, AGENTS.md). A dry run reports the same outcome and
    // writes nothing.
    const projectName = path.basename(targetDir);
    const reportIrregularRootFiles = (files: string[]): void => {
      for (const file of files) {
        result.skipped.push(file);
        log(chalk.dim('  - (skipped, symlinked or not a regular file)'), file);
      }
    };
    if (force) {
      const rootResult = copyRootFiles(targetDir, templatesDir, projectName, { dryRun });
      reportIrregularRootFiles(rootResult.notRegular);
      for (const file of rootResult.copied) {
        result.updated.push(file);
        log(chalk.blue(`  ~ (${previewVerb}updated)`), file);
      }
    } else {
      const rootResult = copyRootFiles(targetDir, templatesDir, projectName, { handleConflicts: true, dryRun });
      reportIrregularRootFiles(rootResult.notRegular);
      for (const file of rootResult.copied) {
        result.newFiles.push(file);
        log(chalk.green(`  + (${previewVerb}new)`), file);
      }
      for (const file of rootResult.conflicts) {
        result.rootConflicts.push({
          file,
          codevNew: `${file}.codev-new`,
          reason: 'Content differs from template',
        });
        log(chalk.yellow('  ! (conflict)'), file);
        if (dryRun) {
          log(chalk.dim('    New version would be saved as:'), `${file}.codev-new`);
        } else {
          log(chalk.dim('    New version saved as:'), `${file}.codev-new`);
        }
      }
    }

    // Materialize the hot-tier files for existing adopters (Spec 987), skip-existing so a
    // curated copy is preserved. Runs BEFORE the block refresh so the block uses local content.
    if (dryRun) {
      log(chalk.dim('  + (hot-tier) would create missing codev/resources/{arch,lessons}-critical.md'));
    } else {
      for (const file of copyHotTierDefaults(targetDir, templatesDir, { skipExisting: true }).copied) {
        const rel = `codev/resources/${file}`;
        result.newFiles.push(rel);
        log(chalk.green('  + (new)'), rel);
      }
    }

    // Backfill the cold-tier governance files for existing adopters from the skeleton's
    // *.starter.md placeholders (issue #1012), skip-existing so a curated file is never overwritten.
    if (dryRun) {
      log(chalk.dim('  + (cold-tier) would create missing codev/resources/{arch,lessons-learned}.md'));
    } else {
      for (const file of copyColdTierDefaults(targetDir, templatesDir, { skipExisting: true }).copied) {
        const rel = `codev/resources/${file}`;
        result.newFiles.push(rel);
        log(chalk.green('  + (new)'), rel);
      }
    }

    // Starters left on a project with something to document point at the bootstrap pass
    // (Spec 1797). A dry run has not backfilled anything, so it says nothing.
    if (!dryRun && shouldOfferBootstrap(targetDir, path.join(templatesDir, 'templates'))) {
      result.bootstrapDocsHint = BOOTSTRAP_DOCS_HINT;
    }

    // Refresh the always-on hot-tier managed block in CLAUDE.md / AGENTS.md (Spec 987).
    // Non-clobbering: only the marked block is replaced; user content is preserved.
    // Logged as a side effect (not added to result.updated, which tracks template copies).
    if (dryRun) {
      log(chalk.dim('  ~ (hot-tier) would refresh CLAUDE.md / AGENTS.md managed block'));
    } else {
      for (const file of syncHotContextBlock(targetDir)) {
        log(chalk.blue('  ~ (hot-tier block)'), file);
      }
    }

    // Backfill .gitignore with any missing Codev entries
    const gitignoreResult = backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, { dryRun });
    result.gitignoreAdded = gitignoreResult.added;
    result.gitignoreSkipped = gitignoreResult.skipped;
    if (gitignoreResult.skipped) {
      log(chalk.dim('  .gitignore: not present, skipped'));
    } else if (gitignoreResult.added.length > 0) {
      const verb = dryRun ? 'would add' : 'added';
      log(chalk.green(`  + (gitignore) ${verb} ${gitignoreResult.added.length} entries: ${gitignoreResult.added.join(', ')}`));
    } else {
      log(chalk.dim('  .gitignore: up to date'));
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
    const conflictCount = result.conflicts.length + result.rootConflicts.length;
    if (conflictCount > 0) {
      log(chalk.yellow(`  ! ${conflictCount} conflicts`));
    }
    if (result.gitignoreAdded && result.gitignoreAdded.length > 0) {
      log(chalk.green(`  gitignore: added ${result.gitignoreAdded.length} entries`));
    } else if (!result.gitignoreSkipped) {
      log(chalk.dim('  gitignore: up to date'));
    }

    if (
      !result.migrated &&
      result.newFiles.length === 0 &&
      result.updated.length === 0 &&
      conflictCount === 0 &&
      (!result.gitignoreAdded || result.gitignoreAdded.length === 0)
    ) {
      log(chalk.dim('  Already up to date!'));
    }

    // PR-gate audit (#943): warn loudly if any PR-producing protocol override
    // lost its `pr` gate. `codev update` preserves user-modified files as local
    // overrides, so it neither fixes nor flags this without an explicit check —
    // surfacing it here turns a silent post-#927 breakage into a migration prompt.
    const prGateWarnings = auditPrGates(targetDir);
    result.prGateWarnings = prGateWarnings.map(formatPrGateWarning);
    if (prGateWarnings.length > 0) {
      log('');
      log(chalk.bold('Protocol PR-gate warnings:'));
      for (const w of prGateWarnings) {
        log(`  ${chalk.yellow('⚠')} ${formatPrGateWarning(w)}`);
      }
    }

    // In agent mode the hint travels in the JSON `instructions` instead.
    if (result.bootstrapDocsHint && !agent) {
      log('');
      log(chalk.cyan(result.bootstrapDocsHint));
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
    const allConflicts = [...result.rootConflicts, ...result.conflicts].map(c => c.file);

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
