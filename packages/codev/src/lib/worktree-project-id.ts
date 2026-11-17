/**
 * Porch project ID of a builder worktree, from its path alone.
 *
 * Pure (path + issue-id grammar only) so that consult can resolve a worktree's
 * project the same way porch does without importing porch's state module (#1898).
 */

import * as path from 'node:path';
import { ISSUE_KEY_SOURCE, canonicalIssueId } from './issue-id.js';

/**
 * Detect project ID from the current working directory if inside a builder worktree.
 * Works from any subdirectory within the worktree.
 * Returns the porch project ID (e.g. "bugfix-237", "1298", or "0073"), or null if not in a recognized worktree.
 */
export function detectProjectIdFromCwd(cwd: string): string | null {
  const normalized = path.resolve(cwd).split(path.sep).join('/');
  // bugfix worktrees: .builders/bugfix-{N}-{slug} (slug optional)
  //   porch project ID is "bugfix-{N}" — historical convention, kept untouched.
  // PIR / SPIR / ASPIR / AIR worktrees: .builders/{prefix}-{N}-{slug} (slug optional)
  //   porch project ID is the bare numeric ID.
  // Spec worktrees (legacy): .builders/{NNNN} (bare 4-digit ID, no slug)
  const match = normalized.match(
    /\/\.builders\/(bugfix-(\d+)(?:-[^/]*)?|(?:aspir|spir|air|pir)-(\d+)(?:-[^/]*)?|(\d{4}))(\/|$)/,
  );
  if (match) {
    // bugfix uses "bugfix-N" as the porch project ID
    if (match[2]) return `bugfix-${match[2]}`;
    // Protocol worktrees (aspir, spir, air, pir) use the bare numeric ID
    if (match[3]) return match[3];
    // Spec worktrees use zero-padded numeric IDs
    return match[4];
  }
  // Tracker keys (#1740): .builders/bugfix-ENG-123[-slug] → "bugfix-ENG-123",
  // .builders/pir-ENG-123[-slug] → "ENG-123", canonical upper case.
  const keyMatch = normalized.match(CWD_KEY_WORKTREE);
  if (!keyMatch) return null;
  const key = canonicalIssueId(keyMatch[2]);
  if (keyMatch[1].toLowerCase() === 'bugfix') return `bugfix-${key}`;
  return key;
}

const CWD_KEY_WORKTREE = new RegExp(`/\\.builders/(bugfix|aspir|spir|air|pir)-(${ISSUE_KEY_SOURCE})(?:-[^/]*)?(?:/|$)`, 'i');
