/**
 * Status command - shows status of all agents
 *
 * Phase 3 (Spec 0090): Uses tower API for workspace status.
 */

import { loadState } from '../state.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { getTowerClient } from '../lib/tower-client.js';
import { getTypeColor } from '../utils/display.js';
import { currentArchitectName } from '../utils/architect-name.js';
import type { Builder } from '../types.js';
import type { OverviewData } from '@cluesmith/codev-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../lib/config.js';
import chalk from 'chalk';

/**
 * Options for `afx status` (Spec 1057).
 *
 * - `json`:      emit a machine-readable payload instead of the human table.
 * - `architect`: only show builders spawned by this architect.
 * - `mine`:      only show builders spawned by the *current* architect, resolved
 *                from `CODEV_ARCHITECT_NAME` (see `currentArchitectName`).
 */
export interface StatusOptions {
  json?: boolean;
  architect?: string;
  mine?: boolean;
}

/** Placeholder shown for builders whose spawning architect is unknown (legacy rows). */
const UNKNOWN_OWNER = '—';

/**
 * Resolve the owner (spawning-architect) filter from CLI options (Spec 1057).
 * An explicit `--architect` wins over `--mine`; absent both, no filter.
 */
function resolveOwnerFilter(options: StatusOptions): string | undefined {
  if (options.architect) return options.architect;
  if (options.mine) return currentArchitectName();
  return undefined;
}

/** Keep only builders spawned by `owner` (no-op when `owner` is undefined). */
function filterByOwner(builders: Builder[], owner: string | undefined): Builder[] {
  if (!owner) return builders;
  return builders.filter((b) => b.spawnedByArchitect === owner);
}

/**
 * Stable sort builders by owner so same-owner rows cluster together. Unknown
 * owners (legacy rows with no `spawnedByArchitect`) sort last. Array.sort is
 * stable, so within an owner the input order (started_at) is preserved.
 */
function sortByOwner(builders: Builder[]): Builder[] {
  return [...builders].sort((a, b) => {
    const oa = a.spawnedByArchitect;
    const ob = b.spawnedByArchitect;
    if (oa === ob) return 0;
    if (!oa) return 1; // unknown owner sorts last
    if (!ob) return -1;
    return oa < ob ? -1 : 1;
  });
}

/** A builder is considered "running" when it has a live terminal session. */
function isBuilderRunning(builder: Builder): boolean {
  return !!builder.terminalId;
}

/**
 * Build a `builderId → heldCount` map from the overview payload (Spec 1313 round 3).
 * Keyed by the overview builder's `roleId` (lowercased), which equals the state.db builder
 * `id` whenever any mail attached (the mailbox addresses agents by that canonical id), so
 * `renderBuilders` can look it up by `builder.id`. Reuses the overview's per-builder count —
 * no re-derivation. Only non-zero counts are stored; a miss renders as 0.
 */
function heldMapFromOverview(overview: OverviewData | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!overview) return map;
  for (const b of overview.builders) {
    if (b.roleId && typeof b.heldCount === 'number' && b.heldCount > 0) {
      map.set(b.roleId.toLowerCase(), b.heldCount);
    }
  }
  return map;
}

/**
 * Workspace-level held-mail summary + remedy hint (Spec 1313 round 3). Held mail that has
 * crossed the escalation age signals an autonomous builder is STARVING — a stray character on
 * its composer classifies busy and holds ALL its mail (cron nudges included). `afx status` is
 * the reachable surface that names it and the fix; escalation was previously SSE/log-only.
 * Reuses the overview payload (`heldCount` / `mailboxEscalated`) — no re-derivation.
 */
function renderMailboxSummary(heldCount: number, escalated: boolean): void {
  if (heldCount === 0) {
    logger.kv('Held mail', chalk.gray('none'));
    return;
  }
  logger.kv('Held mail', escalated ? chalk.yellow(`${heldCount} (escalated)`) : String(heldCount));
  if (escalated) {
    logger.info('  Mail has been held past its escalation age — a stuck composer may be starving delivery.');
    logger.info(`  Inspect: ${chalk.cyan('afx inbox')}   ·   clear a stuck composer: ${chalk.cyan('afx interrupt <id>')}`);
  }
}

/**
 * Render the owner-aware Builders table (Spec 1057). Sourced from `state.db`
 * (the canonical home of `spawnedByArchitect`), so it works identically whether
 * or not Tower is running. The Owner column is second; ID stays first.
 *
 * Spec 1313 round 3: when `heldByRoleId` is provided (Tower up, overview fetched), a trailing
 * `Held` column shows each builder's held-mail count so a starving builder is visible at a
 * glance; omitted entirely when Tower is down (no overview to reuse).
 */
function renderBuilders(
  builders: Builder[],
  ownerFilter: string | undefined,
  heldByRoleId?: Map<string, number>,
): void {
  const visible = sortByOwner(filterByOwner(builders, ownerFilter));

  if (visible.length === 0) {
    if (ownerFilter) {
      logger.info(`Builders: none owned by ${chalk.cyan(ownerFilter)}`);
    } else {
      logger.info('Builders: none');
    }
    return;
  }

  logger.info('Builders:');
  const showHeld = heldByRoleId !== undefined;
  const widths = showHeld ? [20, 14, 8, 12, 10, 6] : [20, 14, 8, 12, 10];
  const header = ['ID', 'Owner', 'Type', 'Status', 'Phase'];
  const rule = ['──', '─────', '────', '──────', '─────'];
  if (showHeld) { header.push('Held'); rule.push('────'); }
  logger.row(header, widths);
  logger.row(rule, widths);

  for (const builder of visible) {
    const running = isBuilderRunning(builder);
    const statusColor = getStatusColor(builder.status, running);
    const typeColor = getTypeColor(builder.type || 'spec');
    const owner = builder.spawnedByArchitect;
    const ownerCell = owner ? chalk.cyan(owner) : chalk.gray(UNKNOWN_OWNER);

    const cells = [
      builder.id,
      ownerCell,
      typeColor(builder.type || 'spec'),
      statusColor(builder.status),
      builder.phase.substring(0, 8),
    ];
    if (showHeld) {
      const n = heldByRoleId!.get(builder.id.toLowerCase()) ?? 0;
      cells.push(n > 0 ? chalk.yellow(String(n)) : chalk.gray('0'));
    }
    logger.row(cells, widths);
  }
}

/**
 * Emit the machine-readable status payload (Spec 1057). Returns early in
 * `status()` before any human chrome, so this is the only thing written to
 * stdout in `--json` mode — safe for tooling to `JSON.parse`.
 */
function emitStatusJson(params: {
  towerRunning: boolean;
  // `name` is explicitly nullable (not optional): an unregistered workspace
  // must still emit `"name": null` so the machine-readable contract is stable
  // for tooling — `JSON.stringify` would otherwise drop an `undefined` key.
  workspace: { path: string; name: string | null; active: boolean };
  architects: Array<{ name: string }>;
  builders: Builder[];
  ownerFilter: string | undefined;
  // Issue #1227: null (not omitted) when Tower is down or the running Tower
  // predates these fields — same nullable-not-optional contract as `workspace.name`.
  fleet: { rssKb: number | null; unregisteredShellperCount: number | null };
  // Spec 1313 round 3: workspace held-mail summary + per-builder counts (reused from the
  // overview payload). Defaults (0 / false / empty map) when Tower is down.
  mailbox: { heldCount: number; escalated: boolean };
  heldByRoleId: Map<string, number>;
}): void {
  const { towerRunning, workspace, architects, builders, ownerFilter, fleet, mailbox, heldByRoleId } = params;
  const visible = sortByOwner(filterByOwner(builders, ownerFilter));

  const payload = {
    tower: { running: towerRunning },
    workspace,
    fleet,
    mailbox,
    ownerFilter: ownerFilter ?? null,
    architects: architects.map((a) => ({ name: a.name ?? 'main' })),
    builders: visible.map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type ?? null,
      status: b.status,
      phase: b.phase,
      spawnedByArchitect: b.spawnedByArchitect ?? null,
      running: isBuilderRunning(b),
      worktree: b.worktree,
      branch: b.branch,
      issueNumber: b.issueNumber ?? null,
      protocolName: b.protocolName ?? null,
      heldCount: heldByRoleId.get(b.id.toLowerCase()) ?? 0,
    })),
  };

  console.log(JSON.stringify(payload, null, 2));
}

/**
 * Display status of all agent farm processes
 */
export async function status(options: StatusOptions = {}): Promise<void> {
  const config = getConfig();
  const workspacePath = config.workspaceRoot;
  const ownerFilter = resolveOwnerFilter(options);

  // Try tower API first (Phase 3 - Spec 0090)
  const client = getTowerClient();
  const towerRunning = await client.isRunning();

  // Builder ownership (`spawnedByArchitect`) lives in state.db, so load it up
  // front — it's the canonical owner source whether or not Tower is running.
  // Guarded with `?.` because some unit tests leave the loadState mock unset.
  const state = loadState(workspacePath);
  const builders = state?.builders ?? [];
  const architects = state?.architects ?? [];

  // Spec 1313 round 3: held-mail awareness. The overview payload already carries the
  // workspace held total, the escalation attention bit, and per-builder held counts
  // (overview.ts) — reuse it rather than re-deriving from global.db. Only available when
  // Tower is up; a null overview degrades to "no held info" (0 / false / empty map).
  const overview = towerRunning ? await client.getOverview(workspacePath) : null;
  const heldByRoleId = heldMapFromOverview(overview);
  const mailboxSummary = {
    heldCount: overview?.heldCount ?? 0,
    escalated: overview?.mailboxEscalated ?? false,
  };

  // Machine-readable mode (Spec 1057): gather workspace metadata when Tower is
  // up, then emit JSON and return before any human-facing output.
  if (options.json) {
    let workspaceName: string | undefined;
    let workspaceActive = false;
    let fleet: { rssKb: number | null; unregisteredShellperCount: number | null } = {
      rssKb: null,
      unregisteredShellperCount: null,
    };
    if (towerRunning) {
      const ws = await client.getWorkspaceStatus(workspacePath);
      if (ws) {
        workspaceName = ws.name;
        workspaceActive = ws.active;
      }
      const health = await client.getHealth();
      if (health) {
        fleet = {
          rssKb: health.fleetRssKb ?? null,
          unregisteredShellperCount: health.unregisteredShellperCount ?? null,
        };
      }
    }
    emitStatusJson({
      towerRunning,
      workspace: { path: workspacePath, name: workspaceName ?? null, active: workspaceActive },
      architects,
      builders,
      ownerFilter,
      fleet,
      mailbox: mailboxSummary,
      heldByRoleId,
    });
    return;
  }

  logger.header('Agent Farm Status');

  if (towerRunning) {
    // Get health info
    const health = await client.getHealth();
    if (health) {
      logger.kv('Tower', chalk.green('running'));
      logger.kv('  Uptime', `${Math.floor(health.uptime)}s`);
      logger.kv('  Active Workspaces', health.activeWorkspaces);
      logger.kv('  Memory', `${Math.round(health.memoryUsage / 1024 / 1024)}MB`);
      // Issue #1227: fleet RSS is the real OS-level memory cost of the
      // shellper/claude process fleet — distinct from `Memory` above, which is
      // only Tower's own V8 heap. Omitted (not shown as 0) when the running
      // Tower predates these fields.
      if (health.fleetRssKb !== undefined) {
        logger.kv('  Fleet RSS', `${Math.round(health.fleetRssKb / 1024)}MB`);
      }
      if (health.unregisteredShellperCount !== undefined) {
        const count = health.unregisteredShellperCount;
        logger.kv('  Unregistered Shellpers', count > 0 ? chalk.yellow(String(count)) : String(count));
      }
    }

    showArtifactConfig(workspacePath);

    logger.blank();

    // Get workspace status from tower
    const workspaceStatus = await client.getWorkspaceStatus(workspacePath);

    if (workspaceStatus) {
      const statusText = workspaceStatus.active ? chalk.green('active') : chalk.gray('inactive');
      logger.kv('Workspace', workspaceStatus.name);
      logger.kv('  Status', statusText);
      logger.kv('  Terminals', workspaceStatus.terminals.length);

      if (workspaceStatus.terminals.length > 0) {
        // Spec 786 Phase 5: enumerate architects explicitly first, so users see
        // ALL registered architects (not just one collapsed "Architect" row).
        // Each architect entry's `architectName`, `pid`, and optional `port`
        // come from the Tower API (per Spec 786 Phase 5's TowerWorkspaceStatus
        // extension). Spec 1057: builders move to their own owner-aware section
        // below; shells/dev remain in the general Terminals list.
        const architectTerminals = workspaceStatus.terminals.filter(t => t.type === 'architect');
        const otherTerminals = workspaceStatus.terminals.filter(
          t => t.type !== 'architect' && t.type !== 'builder',
        );

        if (architectTerminals.length > 0) {
          logger.blank();
          logger.info('Architects:');
          for (const term of architectTerminals) {
            const name = term.architectName || term.label;
            const pid = term.pid ? `pid=${term.pid}` : 'pid=?';
            const port = term.port ? ` port=${term.port}` : '';
            // Spec 786 Phase 5: prefer `terminalId` (the actual PtySession id)
            // over `id` (the Spec 761 tab identifier, e.g. `architect` or
            // `architect:<name>`). Falls back to `id` for older Tower versions
            // that haven't shipped the Phase 5 extension yet.
            const termIdValue = term.terminalId ?? term.id;
            const termId = ` terminal=${termIdValue}`;
            logger.info(`  ${chalk.cyan(name)} (${pid}${port}${termId})`);
          }
        }

        if (otherTerminals.length > 0) {
          logger.blank();
          logger.info('Terminals:');
          for (const term of otherTerminals) {
            const typeColor = term.type === 'dev' ? chalk.green : chalk.gray;
            logger.info(`  ${typeColor(term.type)} - ${term.label} (${term.active ? 'active' : 'stopped'})`);
          }
        }
      }

      // Spec 1057: owner-aware Builders section, sourced from state.db so each
      // row carries its spawning architect (the Tower terminal list does not).
      // Spec 1313 round 3: annotate each row with its held-mail count ONLY when the
      // workspace actually has held mail — a trailing column of zeroes on every
      // `afx status` is noise; it appears precisely when there is starvation to see.
      // The workspace summary + remedy hint always print (they say "none" at zero).
      logger.blank();
      renderBuilders(builders, ownerFilter, mailboxSummary.heldCount > 0 ? heldByRoleId : undefined);
      logger.blank();
      renderMailboxSummary(mailboxSummary.heldCount, mailboxSummary.escalated);

      return;
    }

    // Workspace not found in tower, show "not active"
    logger.kv('Workspace', chalk.gray('not active in tower'));
    logger.info(`Run 'afx workspace start' to activate this workspace`);
    return;
  }

  // Tower not running - show message and fall back to local state
  logger.kv('Tower', chalk.gray('not running'));
  logger.info(`Run 'afx tower start' to start the tower daemon`);

  showArtifactConfig(workspacePath);

  logger.blank();

  // Fall back to local state for legacy display.
  // Spec 786 Phase 5: enumerate ALL architects from state.db. PID and port
  // are not available without Tower (the architect table persists pid=0,
  // port=0 — see state.ts:79, :103), so the fallback shows name + cmd only.
  // Bugfix #826: scoped by workspace_path. (state/architects/builders are
  // loaded once up front — see top of status().)

  if (architects.length > 0) {
    logger.kv('Architects', chalk.green(`${architects.length} registered`));
    logger.info(`  (Tower not running — PID/port not available)`);
    for (const a of architects) {
      logger.info(`  ${chalk.cyan(a.name ?? 'main')}: cmd=${a.cmd} started=${a.startedAt}`);
    }
  } else {
    logger.kv('Architects', chalk.gray('none registered'));
  }

  logger.blank();

  // Spec 1057: owner-aware Builders table (same renderer as the Tower-up path).
  renderBuilders(builders, ownerFilter);

  logger.blank();

  // Utils
  if (state.utils.length > 0) {
    logger.info('Utility Terminals:');
    const widths = [8, 20];

    logger.row(['ID', 'Name'], widths);
    logger.row(['──', '────'], widths);

    for (const util of state.utils) {
      logger.row([
        util.id,
        util.name.substring(0, 18),
      ], widths);
    }
  } else {
    logger.info('Utility Terminals: none');
  }

  logger.blank();

  // Annotations
  if (state.annotations.length > 0) {
    logger.info('Annotations:');
    const widths = [8, 30];

    logger.row(['ID', 'File'], widths);
    logger.row(['──', '────'], widths);

    for (const annotation of state.annotations) {
      logger.row([
        annotation.id,
        annotation.file.substring(0, 28),
      ], widths);
    }
  } else {
    logger.info('Annotations: none');
  }
}

function showArtifactConfig(workspacePath: string): void {
  let artifacts: { backend?: string; scope?: string; command?: string } | undefined;
  try {
    artifacts = loadConfig(workspacePath).artifacts;
  } catch { return; }

  if (!artifacts?.backend) return;

  logger.blank();

  if (artifacts.backend === 'cli') {
    const command = artifacts.command || '(not configured)';
    logger.kv('Artifacts', chalk.cyan(`cli (${command})`));
    if (artifacts.scope) {
      logger.kv('  Scope', artifacts.scope);
    }
    // Resolve data repo from env var or .env file
    let dataRepo = process.env.CODEV_ARTIFACTS_DATA_REPO;
    if (!dataRepo) {
      const envPath = join(workspacePath, '.env');
      try {
        const envContent = readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^CODEV_ARTIFACTS_DATA_REPO=(.+)$/m);
        dataRepo = match?.[1]?.trim();
      } catch { /* .env may not exist */ }
    }
    if (dataRepo) {
      logger.kv('  Data Repo', dataRepo);
    }
  } else {
    logger.kv('Artifacts', `${artifacts.backend} (codev/specs/, codev/plans/)`);
  }
}

function getStatusColor(status: string, running: boolean): (text: string) => string {
  if (!running) {
    return chalk.gray;
  }

  switch (status) {
    case 'implementing':
      return chalk.blue;
    case 'blocked':
      return chalk.yellow;
    case 'pr':
      return chalk.green;
    case 'verify':
      return chalk.green;
    case 'verified':
      return chalk.green;
    case 'complete': // backward compat
      return chalk.green;
    default:
      return chalk.white;
  }
}

