/**
 * Automatic hourly team update — collects notable events and posts a summary.
 *
 * Called by cron (via .af-cron/team-update.yaml) or manually via `afx team update`.
 * Only posts a message when there are notable events in the last hour.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { findWorkspaceRoot } from '../utils/index.js';
import { teamMessage } from './team.js';
import { executeForgeCommandSync } from '../../lib/forge.js';

// =============================================================================
// Event Collection
// =============================================================================

export interface TeamEvent {
  type: 'spawn' | 'gate' | 'merge' | 'review';
  description: string;
}

/**
 * Collect notable events from the last hour.
 * Exported for testing.
 */
export async function collectEvents(workspacePath: string): Promise<TeamEvent[]> {
  const events: TeamEvent[] = [];
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // 1. Builder spawns: check git log for spawn-related commits
  try {
    const since = oneHourAgo.toISOString();
    const log = execSync(
      `git log --oneline --since="${since}" --all --grep="spawn" -i`,
      { cwd: workspacePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    for (const line of log.split('\n').filter(Boolean)) {
      // Two-step: confirm spawn-related, then extract issue number
      if (!/spawn/i.test(line)) continue;
      const issueMatch = line.match(/#(\d+)/);
      if (issueMatch) {
        events.push({ type: 'spawn', description: `Spawned builder for #${issueMatch[1]}` });
      }
    }
  } catch {
    // git log may fail if no repo — skip silently
  }

  // 2. Gate approvals: check status.yaml files for recent gate transitions
  try {
    const projectsDir = path.join(workspacePath, 'codev', 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const entry of fs.readdirSync(projectsDir)) {
        const statusPath = path.join(projectsDir, entry, 'status.yaml');
        if (!fs.existsSync(statusPath)) continue;
        const stat = fs.statSync(statusPath);
        if (stat.mtime > oneHourAgo) {
          const content = fs.readFileSync(statusPath, 'utf-8');
          // Strict check: look for "approved: true" (not just "approved" substring)
          if (/^approved:\s*true/m.test(content)) {
            const id = entry.split('-')[0];
            events.push({ type: 'gate', description: `Gate approved for #${id}` });
          }
        }
      }
    }
  } catch {
    // Skip silently
  }

  // 3. PR merges via forge concept
  // Note: GitHub search only supports date-level granularity for merged:>=,
  // so we fetch by date and filter by mergedAt timestamp in code.
  try {
    const sinceDate = oneHourAgo.toISOString().split('T')[0];
    const result = executeForgeCommandSync('recently-merged', {
      CODEV_SINCE_DATE: sinceDate,
    }, { cwd: workspacePath });
    const prs = (Array.isArray(result) ? result : []) as Array<{ number: number; title: string; mergedAt: string }>;
    for (const pr of prs) {
      // Filter to actual last-hour window
      if (new Date(pr.mergedAt) >= oneHourAgo) {
        events.push({ type: 'merge', description: `Merged PR #${pr.number}: ${pr.title}` });
      }
    }
  } catch {
    // Forge concept may not be available — skip silently
  }

  // 4. Completed reviews: recently modified files in codev/reviews/
  try {
    const reviewsDir = path.join(workspacePath, 'codev', 'reviews');
    if (fs.existsSync(reviewsDir)) {
      for (const file of fs.readdirSync(reviewsDir).filter(f => f.endsWith('.md'))) {
        const filePath = path.join(reviewsDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtime > oneHourAgo) {
          const id = file.split('-')[0];
          events.push({ type: 'review', description: `Review completed for #${id}` });
        }
      }
    }
  } catch {
    // Skip silently
  }

  return events;
}

/**
 * Format collected events into a summary message.
 * Exported for testing.
 */
export function formatSummary(events: TeamEvent[]): string {
  if (events.length === 0) return '';
  const lines = events.map(e => e.description);
  return `Hourly update: ${lines.join('. ')}.`;
}

// =============================================================================
// Main Command
// =============================================================================

export async function teamUpdate(options: { cwd?: string }): Promise<void> {
  const root = findWorkspaceRoot(options.cwd);
  const events = await collectEvents(root);

  if (events.length === 0) {
    // No notable events — exit silently
    return;
  }

  const summary = formatSummary(events);
  await teamMessage({ text: summary, author: 'tower-cron', cwd: options.cwd });
}
