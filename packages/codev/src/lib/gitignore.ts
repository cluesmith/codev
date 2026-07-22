/**
 * Gitignore management for codev init / adopt / update.
 *
 * - `createGitignore` writes a fresh `.gitignore` for new projects (init).
 * - `updateGitignore` merges the Codev block into an existing `.gitignore` (adopt).
 * - `backfillGitignore` repairs stale state in long-lived projects (update).
 *
 * Extracted from `scaffold.ts` (issue #882) once the file accumulated three distinct
 * gitignore behaviors and the "scaffold" name stopped matching the contents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Architect state files (`codev/state/<name>.md`) are per-person and must be
 * gitignored; builder thread files (`codev/state/*_thread.md`) share the
 * directory but must stay versioned (they ship with each builder PR). Defined
 * once here and referenced both in the entries block below and in the doctor
 * audit's warning text (issue #1192), so the two can't drift out of sync.
 */
export const STATE_IGNORE_RULE = 'codev/state/*.md';
export const THREAD_KEEP_RULE = '!codev/state/*_thread.md';

/**
 * Standard gitignore entries for codev projects
 */
export const CODEV_GITIGNORE_ENTRIES = `# Codev
.agent-farm/
.consult/
codev/.update-hashes.json
.builders/
.architect-role.md
${STATE_IGNORE_RULE}
${THREAD_KEEP_RULE}
`;

/**
 * Full gitignore content for new projects
 */
export const FULL_GITIGNORE_CONTENT = `${CODEV_GITIGNORE_ENTRIES}
# Dependencies
node_modules/

# Build output
dist/

# OS files
.DS_Store
*.swp
*.swo
`;

/**
 * Create a new .gitignore file with full content (for init)
 */
export function createGitignore(targetDir: string): void {
  const gitignorePath = path.join(targetDir, '.gitignore');
  fs.writeFileSync(gitignorePath, FULL_GITIGNORE_CONTENT);
}

interface UpdateGitignoreResult {
  updated: boolean;
  created: boolean;
  alreadyPresent: boolean;
}

/**
 * Update existing .gitignore or create if not exists (for adopt).
 *
 * If .gitignore is absent, creates it with the full managed block.
 * Otherwise, performs a line-level backfill — appends only the entries that
 * are missing. This means adopt is self-healing against partial Codev blocks
 * (e.g. a project that ignored `.agent-farm/` but not later additions like
 * `.architect-role.md`).
 */
export function updateGitignore(targetDir: string): UpdateGitignoreResult {
  const gitignorePath = path.join(targetDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, CODEV_GITIGNORE_ENTRIES.trim() + '\n');
    return { updated: false, created: true, alreadyPresent: false };
  }

  const result = backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES);
  if (result.added.length === 0) {
    return { updated: false, created: false, alreadyPresent: true };
  }
  return { updated: true, created: false, alreadyPresent: false };
}

interface BackfillGitignoreOptions {
  dryRun?: boolean;
  today?: Date;
}

export interface BackfillGitignoreResult {
  added: string[];
  alreadyPresent: string[];
  skipped: boolean;
}

/**
 * Parse a gitignore block into the list of pattern lines (excluding comments and blanks).
 */
function parseEntryLines(block: string): string[] {
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

/**
 * Backfill missing entries into an existing .gitignore.
 *
 * Append-only: never deletes, reorders, or duplicates existing lines.
 * Idempotent: a second invocation after a clean run is a no-op.
 * Missing entries are appended together under a dated `# Codev (added by codev update ...)`
 * header so the user can see where they came from.
 *
 * If no .gitignore exists, returns { skipped: true } without creating one
 * (creation belongs to init/adopt).
 */
export function backfillGitignore(
  targetDir: string,
  block: string,
  options: BackfillGitignoreOptions = {}
): BackfillGitignoreResult {
  const { dryRun = false, today = new Date() } = options;
  const gitignorePath = path.join(targetDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    return { added: [], alreadyPresent: [], skipped: true };
  }

  const entries = parseEntryLines(block);
  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  const existingLines = new Set(
    existing.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  );

  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const entry of entries) {
    if (existingLines.has(entry)) {
      alreadyPresent.push(entry);
    } else {
      added.push(entry);
    }
  }

  if (added.length === 0 || dryRun) {
    return { added, alreadyPresent, skipped: false };
  }

  const isoDate = today.toISOString().slice(0, 10);
  const trailingNewline = existing.endsWith('\n') ? '' : '\n';
  const appended = `${trailingNewline}\n# Codev (added by codev update ${isoDate})\n${added.join('\n')}\n`;
  fs.appendFileSync(gitignorePath, appended);

  return { added, alreadyPresent, skipped: false };
}

function gitExitStatus(args: string[], cwd: string): number | null {
  try {
    const result = spawnSync('git', args, { cwd, stdio: 'pipe', timeout: 5000 });
    return result.status;
  } catch {
    return null;
  }
}

/**
 * Audit the architect-state-file versioning split for `codev doctor` (issue #1192).
 *
 * Architect state files (`codev/state/<name>.md`) are per-person and must be
 * gitignored; builder thread files (`codev/state/*_thread.md`) share the
 * directory but must stay versioned (they ship with each builder PR).
 *
 * Probes git's actual ignore behavior via `git check-ignore` on phantom paths
 * (check-ignore does not require the path to exist) rather than string-matching
 * `.gitignore`, so hand-written equivalent rules pass and rule-ordering bugs
 * (a shadowed negation) are caught. Returns warning strings; empty outside a
 * git repository.
 */
export function auditStateFileIgnore(workspaceRoot: string): string[] {
  const warnings: string[] = [];

  if (gitExitStatus(['rev-parse', '--is-inside-work-tree'], workspaceRoot) !== 0) {
    return warnings;
  }

  const architectProbe = gitExitStatus(
    ['check-ignore', '-q', 'codev/state/__doctor-probe__.md'],
    workspaceRoot
  );
  if (architectProbe !== 0) {
    warnings.push(
      `Architect state files (codev/state/<name>.md) are not gitignored. They are per-person and must not be committed. Run "codev update" to backfill the rule, or add "${STATE_IGNORE_RULE}" + "${THREAD_KEEP_RULE}" to .gitignore`
    );
  }

  const threadProbe = gitExitStatus(
    ['check-ignore', '-q', 'codev/state/__doctor-probe___thread.md'],
    workspaceRoot
  );
  if (threadProbe === 0) {
    warnings.push(
      `Builder thread files (codev/state/*_thread.md) are gitignored. They must stay versioned (they ship with each builder PR). The "${THREAD_KEEP_RULE}" negation is missing or shadowed by a later rule in .gitignore`
    );
  }

  // gitignore has no effect on already-tracked files; pre-existing installs may
  // have committed an architect state file before the rule existed.
  try {
    const result = spawnSync('git', ['ls-files', 'codev/state/*.md'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0) {
      const tracked = result.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.endsWith('_thread.md'));
      for (const file of tracked) {
        warnings.push(
          `Architect state file is tracked by git: ${file}. It is per-person and should not be versioned. Run: git rm --cached ${file}`
        );
      }
    }
  } catch {
    // git unavailable or timed out; nothing to report
  }

  return warnings;
}
