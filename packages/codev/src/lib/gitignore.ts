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

/**
 * Standard gitignore entries for codev projects
 */
export const CODEV_GITIGNORE_ENTRIES = `# Codev
.agent-farm/
.consult/
codev/.update-hashes.json
.builders/
.architect-role.md
.gemini/settings.json
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
