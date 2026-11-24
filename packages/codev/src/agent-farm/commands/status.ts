/**
 * Status command - shows status of all agents
 *
 * Phase 3 (Spec 0090): Uses tower API for workspace status.
 */

import { loadState } from '../state.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { getTowerClient } from '../lib/tower-client.js';
import { checkTower, type TowerCheck } from '../lib/tower-check.js';
import { getTypeColor } from '../utils/display.js';
import { currentArchitectName } from '../utils/architect-name.js';
import { discoverBuilders, type StoredBuilderIdentity } from '../servers/overview.js';
import { gatherBuilderActivity, type BuilderActivity } from '../lib/builder-activity.js';
import type { Builder } from '../types.js';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';
import { formatAge } from '@cluesmith/codev-sdk/builder-helpers';
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
 * - `activity`:  also gather each builder's session transcript and running test
 *                or review processes (#1893) — slower, so opt-in.
 */
export interface StatusOptions {
  json?: boolean;
  architect?: string;
  mine?: boolean;
  activity?: boolean;
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

/** A builder's live porch state, read from its own worktree's status.yaml (#1893). */
interface PorchState {
  /** Protocol phase (`implement`, `review`, `complete`, …); null when the worktree has no porch project. */
  phase: string | null;
  /** The human gate the builder is waiting at, and since when. */
  gate: { name: string; since: string | null } | null;
}

/**
 * What `afx status` shows for a builder beyond its state.db row (#1893). The
 * state.db `status` / `phase` are written once at spawn ('implementing' /
 * 'init') and never updated, so they cannot say whether a builder is working,
 * waiting on a human, or done.
 */
interface BuilderLiveView {
  porch: PorchState;
  /**
   * The builder's terminal, from Tower: whether it has a live session (null when Tower
   * could not be asked) and the ISO time of its last output (null when unknown).
   */
  terminal: { live: boolean | null; lastDataAt: string | null };
  /** Held mail addressed to the builder (Spec 1313); 0 when unknown. */
  heldCount: number;
  /** Session and process activity; null unless `--activity`. */
  activity: BuilderActivity | null;
}

/**
 * Read each builder's porch state from its own worktree. The workspace root's
 * copies of status.yaml go stale (#1229, #1703), so the worktree is the only
 * live source. Reuses the overview's discovery, so `afx status` reads the same
 * file the same way the dashboard does, with or without Tower.
 */
function readPorchStates(workspacePath: string, builders: Builder[]): Map<string, PorchState> {
  const stored = new Map<string, StoredBuilderIdentity>(builders.map((b) => [b.worktree, {
    roleId: b.id,
    issueNumber: b.issueNumber != null ? String(b.issueNumber) : null,
    spawnedByArchitect: b.spawnedByArchitect ?? null,
  }]));
  const byWorktree = new Map<string, PorchState>();
  for (const found of discoverBuilders(workspacePath, stored)) {
    byWorktree.set(found.worktreePath, {
      phase: found.protocolPhase || null,
      gate: found.blockedGate ? { name: found.blockedGate, since: found.blockedSince } : null,
    });
  }
  return byWorktree;
}

/**
 * Assemble each builder's live view, keyed by builder id. Terminal activity and
 * held counts reuse the overview payload, matched by its `roleId` (lowercased),
 * which equals the state.db builder `id` — the key Tower's terminal registry and
 * the mailbox both use. A null overview means Tower could not be asked.
 */
function buildLiveViews(
  workspacePath: string,
  builders: Builder[],
  overview: OverviewData | null,
  activity: Map<string, BuilderActivity> | null,
): Map<string, BuilderLiveView> {
  const porch = readPorchStates(workspacePath, builders);
  const fromTower = new Map<string, OverviewBuilder>();
  for (const b of overview?.builders ?? []) {
    if (b.roleId) fromTower.set(b.roleId.toLowerCase(), b);
  }
  const views = new Map<string, BuilderLiveView>();
  for (const builder of builders) {
    const live = fromTower.get(builder.id.toLowerCase());
    views.set(builder.id, {
      porch: porch.get(builder.worktree) ?? { phase: null, gate: null },
      terminal: { live: overview ? live !== undefined : null, lastDataAt: live?.lastDataAt ?? null },
      heldCount: live?.heldCount ?? 0,
      activity: activity?.get(builder.id) ?? null,
    });
  }
  return views;
}

/** `"6m ago"` / `"just now"` for an ISO time; `"unknown"` when it cannot be read. */
function ago(iso: string | null): string {
  const age = formatAge(iso);
  if (age === null) return 'unknown';
  return age === 'just now' ? age : `${age} ago`;
}

function lastActivityCell(terminal: BuilderLiveView['terminal']): string {
  if (terminal.live === false) return chalk.gray('stopped');
  if (terminal.lastDataAt === null) return chalk.gray('unknown');
  return ago(terminal.lastDataAt);
}

function gateCell(gate: PorchState['gate']): string {
  if (!gate) return chalk.gray('—');
  const age = formatAge(gate.since);
  return chalk.yellow(age ? `${gate.name} (${age})` : gate.name);
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
 * #1893: Phase and Gate come from the builder's live worktree status.yaml, Last active from
 * Tower's terminal sessions; the state.db Status/Phase pair (frozen at spawn) is not shown.
 *
 * Spec 1313 round 3: when `showHeld` (the workspace has held mail), a trailing `Held` column
 * shows each builder's held-mail count so a starving builder is visible at a glance.
 */
function renderBuilders(
  visible: Builder[],
  ownerFilter: string | undefined,
  views: Map<string, BuilderLiveView>,
  showHeld: boolean,
): void {
  if (visible.length === 0) {
    if (ownerFilter) {
      logger.info(`Builders: none owned by ${chalk.cyan(ownerFilter)}`);
    } else {
      logger.info('Builders: none');
    }
    return;
  }

  logger.info('Builders:');
  const widths = showHeld ? [20, 14, 8, 12, 20, 12, 6] : [20, 14, 8, 12, 20, 12];
  const header = ['ID', 'Owner', 'Type', 'Phase', 'Gate', 'Last active'];
  const rule = ['──', '─────', '────', '─────', '────', '───────────'];
  if (showHeld) { header.push('Held'); rule.push('────'); }
  logger.row(header, widths);
  logger.row(rule, widths);

  for (const builder of visible) {
    const view = views.get(builder.id)!;
    const typeColor = getTypeColor(builder.type || 'spec');
    const owner = builder.spawnedByArchitect;
    const ownerCell = owner ? chalk.cyan(owner) : chalk.gray(UNKNOWN_OWNER);

    const cells = [
      builder.id,
      ownerCell,
      typeColor(builder.type || 'spec'),
      view.porch.phase ?? chalk.gray('—'),
      gateCell(view.porch.gate),
      lastActivityCell(view.terminal),
    ];
    if (showHeld) {
      const n = view.heldCount;
      cells.push(n > 0 ? chalk.yellow(String(n)) : chalk.gray('0'));
    }
    logger.row(cells, widths);
  }
}

/**
 * The `--activity` section (#1893): per builder, when its session transcript was
 * last written, whether its last reply was an API error, its last few transcript
 * lines, and the test or review processes running under its terminal. A field
 * that could not be read says "unknown".
 */
function renderActivity(visible: Builder[], views: Map<string, BuilderLiveView>): void {
  if (visible.length === 0) return;
  logger.info('Activity:');
  for (const builder of visible) {
    const activity = views.get(builder.id)!.activity;
    if (!activity) continue;
    let apiError = 'unknown';
    if (activity.apiError !== null) apiError = activity.apiError ? chalk.red('yes') : 'no';
    logger.info(`  ${chalk.cyan(builder.id)}  session write: ${ago(activity.sessionWrittenAt)}  ·  API error: ${apiError}`);
    if (activity.lastTurns === null) {
      logger.info(`    turns: ${chalk.gray('unknown')}`);
    } else if (activity.lastTurns.length === 0) {
      logger.info(`    turns: ${chalk.gray('none')}`);
    } else {
      for (const turn of activity.lastTurns) logger.info(`    ${chalk.gray('>')} ${turn}`);
    }
    if (activity.processes === null) {
      logger.info(`    running: ${chalk.gray('unknown')}`);
    } else if (activity.processes.length === 0) {
      logger.info(`    running: ${chalk.gray('none')}`);
    } else {
      for (const p of activity.processes) logger.info(`    running: ${p.kind} ${p.command} (pid ${p.pid})`);
    }
  }
}

/**
 * Emit the machine-readable status payload (Spec 1057). Returns early in
 * `status()` before any human chrome, so this is the only thing written to
 * stdout in `--json` mode — safe for tooling to `JSON.parse`.
 */
function emitStatusJson(params: {
  tower: TowerCheck;
  // `name` is explicitly nullable (not optional): an unregistered workspace
  // must still emit `"name": null` so the machine-readable contract is stable
  // for tooling — `JSON.stringify` would otherwise drop an `undefined` key.
  workspace: { path: string; name: string | null; active: boolean };
  architects: Array<{ name: string }>;
  ownerFilter: string | undefined;
  // Issue #1227: null (not omitted) when Tower is down or the running Tower
  // predates these fields — same nullable-not-optional contract as `workspace.name`.
  fleet: { rssKb: number | null; unregisteredShellperCount: number | null };
  // Spec 1313 round 3: workspace held-mail summary (reused from the overview payload).
  // Defaults (0 / false) when Tower is down.
  mailbox: { heldCount: number; escalated: boolean };
  visible: Builder[];
  views: Map<string, BuilderLiveView>;
}): void {
  const { tower, workspace, architects, visible, views, ownerFilter, fleet, mailbox } = params;

  const payload = {
    // `running: false` covers both a Tower that is down and one that took the connection but did
    // not answer; `state` tells them apart and `error` says why it did not answer (#1901).
    tower: {
      running: tower.state === 'running',
      state: tower.state,
      error: tower.state === 'unresponsive' ? tower.error : null,
    },
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
      heldCount: views.get(b.id)!.heldCount,
      // #1893: live fields. `status` / `phase` above are kept for existing scripts, but
      // they are the spawn-time state.db values; these are what the builder is doing now.
      ...liveJson(views.get(b.id)!),
    })),
  };

  console.log(JSON.stringify(payload, null, 2));
}

/** A builder's #1893 live fields for `--json`. `null` means unknown; `activity` is null without `--activity`. */
function liveJson(view: BuilderLiveView) {
  return {
    porchPhase: view.porch.phase,
    gate: view.porch.gate,
    lastActivityAt: view.terminal.lastDataAt,
    terminalLive: view.terminal.live,
    activity: view.activity,
  };
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
  const tower = await checkTower(client);
  const towerRunning = tower.state === 'running';

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
  const mailboxSummary = {
    heldCount: overview?.heldCount ?? 0,
    escalated: overview?.mailboxEscalated ?? false,
  };

  // #1893: each visible builder's live phase, gate, last activity and held count, plus its
  // session/process activity when asked for (the costly part, so only behind --activity).
  const visible = sortByOwner(filterByOwner(builders, ownerFilter));
  const activity = options.activity ? await gatherBuilderActivity(workspacePath, visible) : null;
  const views = buildLiveViews(workspacePath, visible, overview, activity);

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
      tower,
      workspace: { path: workspacePath, name: workspaceName ?? null, active: workspaceActive },
      architects,
      visible,
      views,
      ownerFilter,
      fleet,
      mailbox: mailboxSummary,
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
      renderBuilders(visible, ownerFilter, views, mailboxSummary.heldCount > 0);
      if (options.activity) {
        logger.blank();
        renderActivity(visible, views);
      }
      logger.blank();
      renderMailboxSummary(mailboxSummary.heldCount, mailboxSummary.escalated);

      return;
    }

    // Workspace not found in tower, show "not active"
    logger.kv('Workspace', chalk.gray('not active in tower'));
    logger.info(`Run 'afx workspace start' to activate this workspace`);
    return;
  }

  // Tower not reachable - show why and fall back to local state
  if (tower.state === 'unresponsive') {
    logger.kv('Tower', chalk.yellow('not answering'));
    logger.warn(tower.message);
  } else {
    logger.kv('Tower', chalk.gray('not running'));
    logger.info(`Run 'afx tower start' to start the tower daemon`);
  }

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
  renderBuilders(visible, ownerFilter, views, false);
  if (options.activity) {
    logger.blank();
    renderActivity(visible, views);
  }

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
