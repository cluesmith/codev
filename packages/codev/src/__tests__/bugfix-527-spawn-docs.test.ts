/**
 * Regression test for bugfix #527: af spawn docs must include --protocol
 *
 * Ensures all `af spawn <number>` examples in key documentation files
 * include `--protocol` (or use an exempted form like --task, --shell,
 * --worktree, --resume).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolve repo root (packages/codev -> repo root)
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

/** Files that contain af spawn examples agents will read */
const DOC_FILES = [
  'codev-skeleton/roles/architect.md',
  'codev/resources/commands/agent-farm.md',
  'codev/resources/workflow-reference.md',
  '.claude/skills/af/SKILL.md',
  'codev-skeleton/.claude/skills/af/SKILL.md',
];

/**
 * Extract af spawn invocations from code blocks in a markdown file.
 * Returns lines that match `af spawn <number>` (with a numeric arg).
 */
function extractSpawnLines(content: string): string[] {
  const lines: string[] = [];
  let inCodeBlock = false;

  for (const line of content.split('\n')) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock && /af spawn\s+\d/.test(line)) {
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

describe('bugfix-527: af spawn docs require --protocol', () => {
  for (const relPath of DOC_FILES) {
    const fullPath = path.join(repoRoot, relPath);

    it(`${relPath} — all numbered af spawn examples include --protocol`, () => {
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
        `Found af spawn examples without --protocol in ${relPath}:\n${violations.map(v => `  - ${v}`).join('\n')}`,
      ).toHaveLength(0);
    });
  }
});
