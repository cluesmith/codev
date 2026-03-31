/**
 * Regression test for bugfix #527: afx spawn docs must include --protocol
 *
 * Ensures all `afx spawn <number>` examples in key documentation files
 * include `--protocol` (or use an exempted form like --task, --shell,
 * --worktree, --resume).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolve repo root (packages/codev -> repo root)
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

/** Files that contain afx spawn examples agents will read */
const DOC_FILES = [
  'codev-skeleton/roles/architect.md',
  'codev/roles/architect.md',
  'codev/resources/commands/agent-farm.md',
  'codev-skeleton/resources/commands/agent-farm.md',
  'codev/resources/workflow-reference.md',
  '.claude/skills/afx/SKILL.md',
  'codev-skeleton/.claude/skills/afx/SKILL.md',
];

/**
 * Extract afx spawn invocations from code blocks in a markdown file.
 * Returns lines that match `afx spawn <number>` (with a numeric arg).
 */
function extractSpawnLines(content: string): string[] {
  const lines: string[] = [];
  let inCodeBlock = false;

  for (const line of content.split('\n')) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock && /afx spawn\s+\d/.test(line)) {
      lines.push(line.trim());
    }
  }
  return lines;
}

/**
 * Check if a spawn line is exempted from requiring --protocol.
 * Exempted: --resume, --task, --shell, --worktree
 */
function isExempted(line: string): boolean {
  return /--resume|--task|--shell|--worktree/.test(line);
}

describe('bugfix-527: afx spawn docs require --protocol', () => {
  for (const relPath of DOC_FILES) {
    const fullPath = path.join(repoRoot, relPath);

    it(`${relPath} — all numbered afx spawn examples include --protocol`, () => {
      if (!fs.existsSync(fullPath)) {
        // File doesn't exist in this context (e.g., skeleton not present) — skip
        return;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const spawnLines = extractSpawnLines(content);

      const violations: string[] = [];
      for (const line of spawnLines) {
        if (!isExempted(line) && !line.includes('--protocol')) {
          violations.push(line);
        }
      }

      expect(
        violations,
        `Found afx spawn examples without --protocol in ${relPath}:\n${violations.map(v => `  - ${v}`).join('\n')}`,
      ).toHaveLength(0);
    });
  }
});
