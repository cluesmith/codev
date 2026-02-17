/**
 * Overview endpoint for Tower dashboard Work view.
 * Spec 0126: Project Management Rework — Phase 4
 *
 * Aggregates builder state, cached PR list, and cached issue backlog
 * into a single JSON response for the dashboard. Supports degraded
 * mode when the `gh` CLI is unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  fetchPRList,
  fetchIssueList,
  fetchRecentlyClosed,
  parseLinkedIssue,
  parseLabelDefaults,
} from '../../lib/github.js';
import type { GitHubPR, GitHubIssueListItem } from '../../lib/github.js';
import { loadProtocol } from '../../commands/porch/protocol.js';

// =============================================================================
// Types
// =============================================================================

export interface PlanPhase {
  id: string;
  title: string;
  status: string;
}

export interface BuilderOverview {
  id: string;
  issueNumber: number | null;
  issueTitle: string | null;
  phase: string;
  mode: 'strict' | 'soft';
  gates: Record<string, string>;
  worktreePath: string;
  protocol: string;
  planPhases: PlanPhase[];
  progress: number;
  blocked: string | null;
}

export interface PROverview {
  number: number;
  title: string;
  url: string;
  reviewStatus: string;
  linkedIssue: number | null;
  createdAt: string;
}

export interface BacklogItem {
  number: number;
  title: string;
  url: string;
  type: string;
  priority: string;
  hasSpec: boolean;
  hasPlan: boolean;
  hasReview: boolean;
  hasBuilder: boolean;
  createdAt: string;
  specPath?: string;
  planPath?: string;
  reviewPath?: string;
}

export interface RecentlyClosedItem {
  number: number;
  title: string;
  url: string;
  type: string;
  closedAt: string;
}

export interface OverviewData {
  builders: BuilderOverview[];
  pendingPRs: PROverview[];
  backlog: BacklogItem[];
  recentlyClosed: RecentlyClosedItem[];
  errors?: { prs?: string; issues?: string };
}

// =============================================================================
// Status YAML parser (lightweight, no library dependency)
// =============================================================================

interface ParsedStatus {
  id: string;
  title: string;
  protocol: string;
  phase: string;
  currentPlanPhase: string;
  gates: Record<string, string>;
  gateRequestedAt: Record<string, string>;
  planPhases: PlanPhase[];
}

/**
 * Parse a porch status.yaml file into structured data.
 * Uses line-based parsing (same pattern as gate-status.ts).
 */
export function parseStatusYaml(content: string): ParsedStatus {
  const result: ParsedStatus = {
    id: '',
    title: '',
    protocol: '',
    phase: '',
    currentPlanPhase: '',
    gates: {},
    gateRequestedAt: {},
    planPhases: [],
  };

  const lines = content.split('\n');
  let section: 'none' | 'gates' | 'plan_phases' = 'none';
  let currentGate = '';
  let currentPlanPhase: Partial<PlanPhase> | null = null;

  for (const line of lines) {
    // Top-level scalar fields
    const idMatch = line.match(/^id:\s*'?(\S+?)'?\s*$/);
    if (idMatch) { result.id = idMatch[1]; section = 'none'; continue; }

    const titleMatch = line.match(/^title:\s*(\S.*?)\s*$/);
    if (titleMatch) { result.title = titleMatch[1]; section = 'none'; continue; }

    const protocolMatch = line.match(/^protocol:\s*(\S+)/);
    if (protocolMatch) { result.protocol = protocolMatch[1]; section = 'none'; continue; }

    const phaseMatch = line.match(/^phase:\s*(\S+)/);
    if (phaseMatch) { result.phase = phaseMatch[1]; section = 'none'; continue; }

    const planPhaseMatch = line.match(/^current_plan_phase:\s*(\S+)/);
    if (planPhaseMatch) { result.currentPlanPhase = planPhaseMatch[1]; section = 'none'; continue; }

    // Section headers
    if (/^gates:\s*$/.test(line)) {
      if (currentPlanPhase) { pushPlanPhase(result, currentPlanPhase); currentPlanPhase = null; }
      section = 'gates';
      continue;
    }

    if (/^plan_phases:\s*$/.test(line)) {
      section = 'plan_phases';
      continue;
    }

    // Stop section at next top-level key
    if (/^\S/.test(line) && line.trim() !== '') {
      if (currentPlanPhase) { pushPlanPhase(result, currentPlanPhase); currentPlanPhase = null; }
      section = 'none';
    }

    // Gates section
    if (section === 'gates') {
      const gateNameMatch = line.match(/^\s{2}(\S+):\s*$/);
      if (gateNameMatch) {
        currentGate = gateNameMatch[1];
        continue;
      }

      const statusMatch = line.match(/^\s{4}status:\s*(\S+)/);
      if (statusMatch && currentGate) {
        result.gates[currentGate] = statusMatch[1];
      }

      const requestedMatch = line.match(/^\s{4}requested_at:\s*'?(.+?)'?\s*$/);
      if (requestedMatch && currentGate) {
        const val = requestedMatch[1];
        if (val !== 'null' && val !== '~') {
          result.gateRequestedAt[currentGate] = val;
        }
      }
    }

    // Plan phases section
    if (section === 'plan_phases') {
      const itemIdMatch = line.match(/^\s{2}-\s+id:\s*(\S+)/);
      if (itemIdMatch) {
        if (currentPlanPhase) { pushPlanPhase(result, currentPlanPhase); }
        currentPlanPhase = { id: itemIdMatch[1] };
        continue;
      }

      const itemTitleMatch = line.match(/^\s{4}title:\s*(.+?)\s*$/);
      if (itemTitleMatch && currentPlanPhase) {
        currentPlanPhase.title = itemTitleMatch[1];
        continue;
      }

      const itemStatusMatch = line.match(/^\s{4}status:\s*(\S+)/);
      if (itemStatusMatch && currentPlanPhase) {
        currentPlanPhase.status = itemStatusMatch[1];
        continue;
      }
    }
  }

  // Flush last plan phase if we were in that section
  if (currentPlanPhase) { pushPlanPhase(result, currentPlanPhase); }

  return result;
}

function pushPlanPhase(result: ParsedStatus, partial: Partial<PlanPhase>): void {
  if (partial.id) {
    result.planPhases.push({
      id: partial.id,
      title: partial.title || '',
      status: partial.status || 'pending',
    });
  }
}

// =============================================================================
// Progress and blocked detection
// =============================================================================

/**
 * Calculate progress percentage (0-100) based on protocol phase.
 *
 * SPIR/spider: nuanced sub-progress with gate awareness and plan phase tracking.
 * Other protocols: even split derived from protocol.json phases array.
 */
export function calculateProgress(parsed: ParsedStatus, workspaceRoot?: string): number {
  const protocol = parsed.protocol;

  if (protocol === 'spir' || protocol === 'spider') {
    return calculateSpirProgress(parsed);
  }

  if (!protocol || !workspaceRoot) return 0;

  // Load phase list dynamically from protocol.json
  const phases = loadProtocolPhases(workspaceRoot, protocol);
  if (!phases) return 0;

  return calculateEvenProgress(parsed.phase, phases);
}

function calculateSpirProgress(parsed: ParsedStatus): number {
  const gateRequested = (gate: string) =>
    parsed.gates[gate] === 'pending' && !!parsed.gateRequestedAt[gate];

  switch (parsed.phase) {
    case 'specify':
      return gateRequested('spec-approval') ? 20 : 10;
    case 'plan':
      return gateRequested('plan-approval') ? 45 : 35;
    case 'implement': {
      const total = parsed.planPhases.length;
      if (total === 0) return 70;
      const completed = parsed.planPhases.filter(p => p.status === 'complete').length;
      return 50 + Math.round((completed / total) * 40);
    }
    case 'review':
      return gateRequested('pr') ? 95 : 92;
    case 'complete':
      return 100;
    default:
      return 0;
  }
}

/**
 * Even-split progress for protocols with fixed phase lists.
 * Each phase gets an equal share of 100%, with 'complete' always = 100.
 */
export function calculateEvenProgress(phase: string, phases: string[]): number {
  if (phase === 'complete') return 100;
  const idx = phases.indexOf(phase);
  if (idx === -1) return 0;
  return Math.round(((idx + 1) / (phases.length + 1)) * 100);
}

/** Cache of protocol phase IDs keyed by protocol name */
const protocolPhaseCache = new Map<string, string[]>();

/**
 * Load phase IDs from a protocol's protocol.json file.
 * Cached per protocol name for the lifetime of the process.
 */
function loadProtocolPhases(workspaceRoot: string, protocolName: string): string[] | null {
  const cached = protocolPhaseCache.get(protocolName);
  if (cached) return cached;

  try {
    const protocol = loadProtocol(workspaceRoot, protocolName);
    const phases = protocol.phases.map(p => p.id);
    protocolPhaseCache.set(protocolName, phases);
    return phases;
  } catch {
    return null;
  }
}

/**
 * Detect if a builder is blocked on a gate (requested but not approved).
 * Returns a human-readable label or null.
 */
export function detectBlocked(parsed: ParsedStatus): string | null {
  const gateLabels: Record<string, string> = {
    'spec-approval': 'spec review',
    'plan-approval': 'plan review',
    'pr': 'PR review',
  };

  for (const [gate, label] of Object.entries(gateLabels)) {
    if (parsed.gates[gate] === 'pending' && parsed.gateRequestedAt[gate]) {
      return label;
    }
  }
  return null;
}

// =============================================================================
// Builder discovery
// =============================================================================

/**
 * Map a worktree directory name to its expected terminal role_id.
 * Must match what buildAgentName() produces during spawn so we can
 * cross-reference worktrees against active terminal sessions.
 *
 * All values are lowercased to match buildAgentName() convention.
 *
 * Examples:
 *   spir-126-slug         → "builder-spir-126"
 *   tick-130-slug         → "builder-tick-130"
 *   bugfix-296-slug       → "builder-bugfix-296"
 *   task-NAvW             → "builder-task-navw"
 *   worktree-foIg         → "worktree-foig"
 *   0110-legacy           → "builder-spir-110"
 *   experiment-AbCd       → "builder-experiment-abcd"
 */
export function worktreeNameToRoleId(dirName: string): string | null {
  const lower = dirName.toLowerCase();

  // SPIR: spir-126-slug → builder-spir-126
  const spirMatch = lower.match(/^spir-(\d+)/);
  if (spirMatch) return `builder-spir-${Number(spirMatch[1])}`;

  // TICK: tick-130-slug → builder-tick-130
  const tickMatch = lower.match(/^tick-(\d+)/);
  if (tickMatch) return `builder-tick-${Number(tickMatch[1])}`;

  // Bugfix: bugfix-296-slug → builder-bugfix-296
  const bugfixMatch = lower.match(/^bugfix-(\d+)/);
  if (bugfixMatch) return `builder-bugfix-${Number(bugfixMatch[1])}`;

  // Task: task-NAvW → builder-task-navw
  const taskMatch = lower.match(/^task-([a-z0-9]+)/);
  if (taskMatch) return `builder-task-${taskMatch[1]}`;

  // Worktree: worktree-foIg → worktree-foig (no builder- prefix)
  const worktreeMatch = lower.match(/^worktree-([a-z0-9]+)/);
  if (worktreeMatch) return `worktree-${worktreeMatch[1]}`;

  // Legacy numeric: 0110-slug → builder-spir-110 (assume spir)
  const numericMatch = lower.match(/^(\d+)(?:-|$)/);
  if (numericMatch) return `builder-spir-${Number(numericMatch[1])}`;

  // Generic protocol: experiment-AbCd → builder-experiment-abcd
  const genericMatch = lower.match(/^([a-z]+)-([a-z0-9]+)/);
  if (genericMatch) return `builder-${genericMatch[1]}-${genericMatch[2]}`;

  return null;
}

/**
 * Extract project ID from a worktree directory name.
 * Used to match worktrees to their correct codev/projects/{ID}-* directory.
 *
 * Returns the project dir prefix (to match `{ID}-*`) or null for soft-mode builders.
 */
export function extractProjectIdFromWorktreeName(dirName: string): string | null {
  // SPIR: spir-126-slug → "0126" (zero-padded)
  const spirMatch = dirName.match(/^spir-(\d+)/);
  if (spirMatch) return spirMatch[1].padStart(4, '0');

  // TICK: tick-130-slug → "0130" (zero-padded)
  const tickMatch = dirName.match(/^tick-(\d+)/);
  if (tickMatch) return tickMatch[1].padStart(4, '0');

  // Bugfix: bugfix-296-slug → "builder-bugfix-296"
  // Porch project dirs are created via buildAgentName('bugfix', N) → "builder-bugfix-N"
  const bugfixMatch = dirName.match(/^bugfix-(\d+)/);
  if (bugfixMatch) return `builder-bugfix-${bugfixMatch[1]}`;

  // Legacy numeric: 0110 or 0110-slug → "0110"
  const numericMatch = dirName.match(/^(\d+)(?:-|$)/);
  if (numericMatch) return numericMatch[1].padStart(4, '0');

  // task-NAvW, worktree-foIg → null (soft mode)
  return null;
}

/**
 * Discover builders by scanning .builders/ directory and reading status.yaml.
 */
export function discoverBuilders(workspaceRoot: string): BuilderOverview[] {
  const buildersDir = path.join(workspaceRoot, '.builders');
  if (!fs.existsSync(buildersDir)) return [];

  const builders: BuilderOverview[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(buildersDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const worktreePath = path.join(buildersDir, entry.name);
    const projectId = extractProjectIdFromWorktreeName(entry.name);

    if (!projectId) {
      // No ID extracted (task-*, worktree-*) → soft mode
      builders.push({
        id: entry.name,
        issueNumber: null,
        issueTitle: null,
        phase: '',
        mode: 'soft',
        gates: {},
        worktreePath,
        protocol: '',
        planPhases: [],
        progress: 0,
        blocked: null,
      });
      continue;
    }

    const projectsDir = path.join(worktreePath, 'codev', 'projects');

    // Try to find matching status.yaml by project ID prefix
    let found = false;
    if (fs.existsSync(projectsDir)) {
      try {
        const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const projEntry of projectEntries) {
          if (!projEntry.isDirectory()) continue;
          if (!projEntry.name.startsWith(`${projectId}-`)) continue;

          const statusFile = path.join(projectsDir, projEntry.name, 'status.yaml');
          if (!fs.existsSync(statusFile)) continue;

          const content = fs.readFileSync(statusFile, 'utf-8');
          const parsed = parseStatusYaml(content);

          let issueNumber: number | null = parsed.id ? parseInt(parsed.id, 10) : null;
          if (issueNumber !== null && Number.isNaN(issueNumber)) {
            // Bugfix-style IDs like "builder-bugfix-315" — extract trailing number
            const trailingNum = parsed.id!.match(/(\d+)$/);
            issueNumber = trailingNum ? parseInt(trailingNum[1], 10) : null;
          }

          builders.push({
            id: parsed.id || entry.name,
            issueNumber: Number.isNaN(issueNumber) ? null : issueNumber,
            issueTitle: parsed.title || null,
            phase: parsed.currentPlanPhase || parsed.phase,
            mode: 'strict',
            gates: parsed.gates,
            worktreePath,
            protocol: parsed.protocol,
            planPhases: parsed.planPhases,
            progress: calculateProgress(parsed, workspaceRoot),
            blocked: detectBlocked(parsed),
          });
          found = true;
          break;
        }
      } catch {
        // Skip unreadable project dirs
      }
    }

    if (!found) {
      // No matching project dir → soft mode, but extract issue number from dir name
      const numMatch = projectId.match(/(\d+)$/);
      const issueNumber = numMatch ? parseInt(numMatch[1], 10) : null;
      builders.push({
        id: entry.name,
        issueNumber: Number.isNaN(issueNumber) ? null : issueNumber,
        issueTitle: null,
        phase: '',
        mode: 'soft',
        gates: {},
        worktreePath,
        protocol: '',
        planPhases: [],
        progress: 0,
        blocked: null,
      });
    }
  }

  return builders;
}

// =============================================================================
// Backlog derivation
// =============================================================================

/**
 * Scan a codev artifact directory and return a map of issue number → filename.
 */
function scanArtifactDir(dirPath: string): Map<number, string> {
  const result = new Map<number, string>();
  if (!fs.existsSync(dirPath)) return result;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const numStr = file.split('-')[0];
      const num = parseInt(numStr, 10);
      if (!Number.isNaN(num)) result.set(num, file);
    }
  } catch {
    // Silently continue
  }
  return result;
}

/**
 * Derive backlog from open GitHub issues cross-referenced with specs and builders.
 */
export function deriveBacklog(
  issues: GitHubIssueListItem[],
  workspaceRoot: string,
  activeBuilderIssues: Set<number>,
  prLinkedIssues: Set<number>,
): BacklogItem[] {
  const specFiles = scanArtifactDir(path.join(workspaceRoot, 'codev', 'specs'));
  const planFiles = scanArtifactDir(path.join(workspaceRoot, 'codev', 'plans'));
  const reviewFiles = scanArtifactDir(path.join(workspaceRoot, 'codev', 'reviews'));

  return issues
    .filter(issue => !prLinkedIssues.has(issue.number))
    .map(issue => {
      const { type, priority } = parseLabelDefaults(issue.labels, issue.title);
      const specFile = specFiles.get(issue.number);
      const planFile = planFiles.get(issue.number);
      const reviewFile = reviewFiles.get(issue.number);
      const item: BacklogItem = {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        type,
        priority,
        hasSpec: !!specFile,
        hasPlan: !!planFile,
        hasReview: !!reviewFile,
        hasBuilder: activeBuilderIssues.has(issue.number),
        createdAt: issue.createdAt,
      };
      if (specFile) item.specPath = `codev/specs/${specFile}`;
      if (planFile) item.planPath = `codev/plans/${planFile}`;
      if (reviewFile) item.reviewPath = `codev/reviews/${reviewFile}`;
      return item;
    });
}

// =============================================================================
// OverviewCache
// =============================================================================

export class OverviewCache {
  private prCache: { data: GitHubPR[]; fetchedAt: number } | null = null;
  private issueCache: { data: GitHubIssueListItem[]; fetchedAt: number } | null = null;
  private closedCache: { data: GitHubIssueListItem[]; fetchedAt: number } | null = null;
  private lastWorkspaceRoot: string | null = null;
  private readonly TTL = 60_000;

  /**
   * Build the overview response. Aggregates builder state, PRs, and backlog.
   *
   * @param activeBuilderRoleIds - Set of lowercased role_ids for builders with
   *   live terminal sessions. When provided, only worktrees matching an active
   *   session are included. When omitted, all discovered worktrees are returned
   *   (backward-compatible / unit-test friendly).
   */
  async getOverview(workspaceRoot: string, activeBuilderRoleIds?: Set<string>): Promise<OverviewData> {
    // Invalidate cache when workspace changes (prevents cross-workspace stale data)
    if (this.lastWorkspaceRoot !== null && this.lastWorkspaceRoot !== workspaceRoot) {
      this.invalidate();
    }
    this.lastWorkspaceRoot = workspaceRoot;

    const errors: { prs?: string; issues?: string } = {};

    // 1. Discover builders from .builders/ directory, then filter to live sessions
    let builders = discoverBuilders(workspaceRoot);
    if (activeBuilderRoleIds) {
      builders = builders.filter(b => {
        const roleId = worktreeNameToRoleId(path.basename(b.worktreePath));
        return roleId !== null && activeBuilderRoleIds.has(roleId);
      });
    }
    const activeBuilderIssues = new Set(
      builders
        .map(b => b.issueNumber)
        .filter((n): n is number => n !== null),
    );

    // 2. Fetch PRs (cached, scoped to workspace)
    let pendingPRs: PROverview[] = [];
    const prs = await this.fetchPRsCached(workspaceRoot);
    if (prs === null) {
      errors.prs = 'GitHub CLI unavailable — could not fetch PRs';
    } else {
      pendingPRs = prs.map(pr => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        reviewStatus: pr.reviewDecision || 'REVIEW_REQUIRED',
        linkedIssue: parseLinkedIssue(pr.body || '', pr.title),
        createdAt: pr.createdAt,
      }));
    }

    const prLinkedIssues = new Set(
      pendingPRs
        .map(pr => pr.linkedIssue)
        .filter((n): n is number => n !== null),
    );

    // 3. Fetch issues and derive backlog (cached, scoped to workspace)
    let backlog: BacklogItem[] = [];
    const issues = await this.fetchIssuesCached(workspaceRoot);
    if (issues === null) {
      errors.issues = 'GitHub CLI unavailable — could not fetch issues';
    } else {
      backlog = deriveBacklog(issues, workspaceRoot, activeBuilderIssues, prLinkedIssues);

      // Enrich builder titles from GitHub issue titles
      // (status.yaml stores a slug, not the human-readable title)
      const issueTitleMap = new Map(issues.map(i => [i.number, i.title]));
      for (const b of builders) {
        if (b.issueNumber !== null && issueTitleMap.has(b.issueNumber)) {
          b.issueTitle = issueTitleMap.get(b.issueNumber)!;
        }
      }
    }

    // 4. Fetch recently closed issues (cached, scoped to workspace)
    let recentlyClosed: RecentlyClosedItem[] = [];
    const closed = await this.fetchRecentlyClosedCached(workspaceRoot);
    if (closed !== null) {
      recentlyClosed = closed.map(issue => {
        const { type } = parseLabelDefaults(issue.labels);
        return {
          number: issue.number,
          title: issue.title,
          url: issue.url,
          type,
          closedAt: issue.closedAt!,
        };
      });
    }

    const result: OverviewData = { builders, pendingPRs, backlog, recentlyClosed };
    if (Object.keys(errors).length > 0) {
      result.errors = errors;
    }
    return result;
  }

  /**
   * Invalidate all cached data.
   */
  invalidate(): void {
    this.prCache = null;
    this.issueCache = null;
    this.closedCache = null;
  }

  // ===========================================================================
  // Private cache helpers
  // ===========================================================================

  private async fetchPRsCached(cwd: string): Promise<GitHubPR[] | null> {
    const now = Date.now();
    if (this.prCache && (now - this.prCache.fetchedAt) < this.TTL) {
      return this.prCache.data;
    }

    const data = await fetchPRList(cwd);
    if (data !== null) {
      this.prCache = { data, fetchedAt: now };
    }
    return data;
  }

  private async fetchIssuesCached(cwd: string): Promise<GitHubIssueListItem[] | null> {
    const now = Date.now();
    if (this.issueCache && (now - this.issueCache.fetchedAt) < this.TTL) {
      return this.issueCache.data;
    }

    const data = await fetchIssueList(cwd);
    if (data !== null) {
      this.issueCache = { data, fetchedAt: now };
    }
    return data;
  }

  private async fetchRecentlyClosedCached(cwd: string): Promise<GitHubIssueListItem[] | null> {
    const now = Date.now();
    if (this.closedCache && (now - this.closedCache.fetchedAt) < this.TTL) {
      return this.closedCache.data;
    }

    const data = await fetchRecentlyClosed(cwd);
    if (data !== null) {
      this.closedCache = { data, fetchedAt: now };
    }
    return data;
  }
}
