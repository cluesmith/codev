/**
 * Shared builder-lookup helpers.
 *
 * Used by `afx attach`, `afx dev`, and any other command that needs to
 * resolve a builder by ID or by GitHub issue number. Lookups consult local
 * state first, then fall back to Tower's terminal_sessions SQLite table —
 * Tower may know about builders that were never written to local state.db
 * (Bugfix #717).
 *
 * Matching delegates to `resolveAgentName` in @cluesmith/codev-sdk, so
 * VSCode, agent-farm, and any other consumer share identical semantics:
 * case-insensitive exact match (with leading zeros stripped), then
 * tail-match (e.g. "109" → "builder-spir-109").
 */

import type { Builder } from '../types.js';
import { logger } from '../utils/logger.js';
import { getBuilder, getBuilders } from '../state.js';
import { getConfig } from '../utils/config.js';
import { normalizeWorkspacePath } from '../servers/tower-utils.js';
import { getGlobalDb } from '../db/index.js';
import { resolveAgentName } from '@cluesmith/codev-sdk/agent-names';
import { ISSUE_KEY_SOURCE, canonicalIssueId, sameIssueId } from '../../lib/issue-id.js';

/**
 * Find a builder by issue number or tracker key. Local state first, then Tower
 * fallback. Keys match case-insensitively (role ids are lower-cased).
 */
export function findBuilderByIssue(issueNumber: number | string): Builder | null {
  // Issue #1118: scope to this workspace (matches loadTowerBuilderRows below),
  // now that builders from every workspace share one global.db.
  const workspaceRoot = normalizeWorkspacePath(getConfig().workspaceRoot);
  const local = getBuilders(workspaceRoot).find((b) => sameIssueId(b.issueNumber, issueNumber));
  if (local) return local;

  const rows = loadTowerBuilderRows();
  const wanted = String(issueNumber).toLowerCase();
  const match = rows.find((r) => bugfixIssueOfRole(r.role_id) === wanted);
  return match ? towerRowToBuilder(match) : null;
}

/** The issue segment of a bugfix role id (`builder-bugfix-42`, `builder-bugfix-eng-12`), lower-cased. */
function bugfixIssueOfRole(roleId: string): string | null {
  const m = roleId.match(BUGFIX_ROLE_ISSUE);
  if (!m) return null;
  return m[1].toLowerCase();
}

const BUGFIX_ROLE_ISSUE = new RegExp(`-bugfix-(\\d+|${ISSUE_KEY_SOURCE})`, 'i');

/** A role id's issue segment as a Builder issue: numbers as numbers, keys canonicalized. */
function issueFromRoleSegment(segment: string | null): number | string | undefined {
  if (segment === null) return undefined;
  if (/^\d+$/.test(segment)) return Number(segment);
  return canonicalIssueId(segment);
}

/**
 * Find a builder by ID. Tries an exact getBuilder(id) lookup first, then
 * resolveAgentName against local builders, then resolveAgentName against
 * Tower's terminal_sessions rows.
 */
export function findBuilderById(id: string): Builder | null {
  // Issue #1118: scope to this workspace so a same-id builder in another
  // workspace can't shadow this one's lookup.
  const workspaceRoot = normalizeWorkspacePath(getConfig().workspaceRoot);
  const exact = getBuilder(id, workspaceRoot);
  if (exact) return exact;

  const local = resolveAgentName(id, getBuilders(workspaceRoot));
  if (local.builder) return local.builder;
  if (local.ambiguous) {
    logger.error(`Ambiguous builder ID "${id}". Matches:`);
    for (const b of local.ambiguous) logger.info(`  - ${b.id}`);
    return null;
  }

  // Tower fallback: project each row through { id } so resolveAgentName
  // can work directly, then reconstruct the Builder from the matched row.
  const rows = loadTowerBuilderRows();
  if (rows.length === 0) return null;
  const towerEntries = rows.map((r) => ({ id: r.role_id, row: r }));
  const tower = resolveAgentName(id, towerEntries);
  if (tower.builder) return towerRowToBuilder(tower.builder.row);
  if (tower.ambiguous) {
    logger.error(`Ambiguous builder ID "${id}" in Tower terminal registry. Matches:`);
    for (const m of tower.ambiguous) logger.info(`  - ${m.id}`);
    return null;
  }
  return null;
}

/** Row shape we read from terminal_sessions for builder reconstruction. */
interface TowerBuilderRow {
  role_id: string;
  cwd: string | null;
  label: string | null;
}

function loadTowerBuilderRows(): TowerBuilderRow[] {
  try {
    const db = getGlobalDb();
    const config = getConfig();
    const workspacePath = normalizeWorkspacePath(config.workspaceRoot);
    return db.prepare(`
      SELECT role_id, cwd, label
      FROM terminal_sessions
      WHERE workspace_path = ?
        AND type = 'builder'
        AND role_id IS NOT NULL
      ORDER BY created_at DESC
    `).all(workspacePath) as TowerBuilderRow[];
  } catch {
    return [];
  }
}

function towerRowToBuilder(row: TowerBuilderRow): Builder {
  const isBugfix = row.role_id.includes('-bugfix-');
  const issue = isBugfix ? bugfixIssueOfRole(row.role_id) : null;
  return {
    id: row.role_id,
    name: row.label ?? row.role_id,
    status: 'implementing',
    phase: 'unknown',
    worktree: row.cwd ?? '',
    branch: '',
    type: isBugfix ? 'bugfix' : 'spec',
    issueNumber: issueFromRoleSegment(issue),
  };
}
