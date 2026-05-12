/**
 * Shared builder-lookup helpers.
 *
 * Used by `afx attach`, `afx dev`, and any other command that needs to
 * resolve a builder by ID or by GitHub issue number. Lookups consult local
 * state first, then fall back to Tower's terminal_sessions SQLite table —
 * Tower may know about builders that were never written to local state.db
 * (Bugfix #717).
 *
 * Matching delegates to `resolveAgentName` in @cluesmith/codev-core, so
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
import { resolveAgentName } from '@cluesmith/codev-core/agent-names';

/**
 * Find a builder by issue number. Local state first, then Tower fallback.
 */
export function findBuilderByIssue(issueNumber: number): Builder | null {
  const local = getBuilders().find((b) => b.issueNumber === issueNumber);
  if (local) return local;

  const rows = loadTowerBuilderRows();
  const stripped = String(issueNumber);
  const match = rows.find((r) => {
    const m = r.role_id.match(/-bugfix-(\d+)/);
    return m !== null && m[1] === stripped;
  });
  return match ? towerRowToBuilder(match) : null;
}

/**
 * Find a builder by ID. Tries an exact getBuilder(id) lookup first, then
 * resolveAgentName against local builders, then resolveAgentName against
 * Tower's terminal_sessions rows.
 */
export function findBuilderById(id: string): Builder | null {
  const exact = getBuilder(id);
  if (exact) return exact;

  const local = resolveAgentName(id, getBuilders());
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
  const issueMatch = isBugfix ? row.role_id.match(/-bugfix-(\d+)/) : null;
  return {
    id: row.role_id,
    name: row.label ?? row.role_id,
    status: 'implementing',
    phase: 'unknown',
    worktree: row.cwd ?? '',
    branch: '',
    type: isBugfix ? 'bugfix' : 'spec',
    issueNumber: issueMatch ? Number(issueMatch[1]) : undefined,
  };
}
