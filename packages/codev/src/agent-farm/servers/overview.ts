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
  parseLinkedIssue,
  parseLabelDefaults,
} from '../../lib/github.js';
import type { GitHubPR, GitHubIssueListItem } from '../../lib/github.js';

// =============================================================================
// Types
// =============================================================================

export interface BuilderOverview {
  id: string;
  issueNumber: number | null;
  issueTitle: string | null;
  phase: string;
  mode: 'strict' | 'soft';
  gates: Record<string, string>;
  worktreePath: string;
}

export interface PROverview {
  number: number;
  title: string;
  reviewStatus: string;
  linkedIssue: number | null;
}

export interface BacklogItem {
  number: number;
  title: string;
  type: string;
  priority: string;
  hasSpec: boolean;
  hasBuilder: boolean;
  createdAt: string;
}

export interface OverviewData {
  builders: BuilderOverview[];
  pendingPRs: PROverview[];
  backlog: BacklogItem[];
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
  };

  const lines = content.split('\n');
  let inGates = false;
  let currentGate = '';

  for (const line of lines) {
    // Top-level scalar fields
    const idMatch = line.match(/^id:\s*'?(\S+?)'?\s*$/);
    if (idMatch) { result.id = idMatch[1]; continue; }

    const titleMatch = line.match(/^title:\s*(\S.*?)\s*$/);
    if (titleMatch) { result.title = titleMatch[1]; continue; }

    const protocolMatch = line.match(/^protocol:\s*(\S+)/);
    if (protocolMatch) { result.protocol = protocolMatch[1]; continue; }

    const phaseMatch = line.match(/^phase:\s*(\S+)/);
    if (phaseMatch) { result.phase = phaseMatch[1]; continue; }

    const planPhaseMatch = line.match(/^current_plan_phase:\s*(\S+)/);
    if (planPhaseMatch) { result.currentPlanPhase = planPhaseMatch[1]; continue; }

    // Gates section
    if (/^gates:\s*$/.test(line)) {
      inGates = true;
      continue;
    }

    // Stop gates section at next top-level key
    if (inGates && /^\S/.test(line) && line.trim() !== '') {
      inGates = false;
    }

    if (inGates) {
      const gateNameMatch = line.match(/^\s{2}(\S+):\s*$/);
      if (gateNameMatch) {
        currentGate = gateNameMatch[1];
        continue;
      }

      const statusMatch = line.match(/^\s{4}status:\s*(\S+)/);
      if (statusMatch && currentGate) {
        result.gates[currentGate] = statusMatch[1];
      }
    }
  }

  return result;
}

// =============================================================================
// Builder discovery
// =============================================================================

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
    const projectsDir = path.join(worktreePath, 'codev', 'projects');

    if (!fs.existsSync(projectsDir)) {
      // Soft mode builder or no porch state — report as running/soft
      builders.push({
        id: entry.name,
        issueNumber: null,
        issueTitle: null,
        phase: '',
        mode: 'soft',
        gates: {},
        worktreePath,
      });
      continue;
    }

    // Find status.yaml in project subdirectories
    let found = false;
    try {
      const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const projEntry of projectEntries) {
        if (!projEntry.isDirectory()) continue;

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
        });
        found = true;
        break; // One status.yaml per builder worktree
      }
    } catch {
      // Skip unreadable project dirs
    }

    if (!found) {
      builders.push({
        id: entry.name,
        issueNumber: null,
        issueTitle: null,
        phase: '',
        mode: 'soft',
        gates: {},
        worktreePath,
      });
    }
  }

  return builders;
}

// =============================================================================
// Backlog derivation
// =============================================================================

/**
 * Derive backlog from open GitHub issues cross-referenced with specs and builders.
 */
export function deriveBacklog(
  issues: GitHubIssueListItem[],
  workspaceRoot: string,
  activeBuilderIssues: Set<number>,
  prLinkedIssues: Set<number>,
): BacklogItem[] {
  const specsDir = path.join(workspaceRoot, 'codev', 'specs');
  const specNumbers = new Set<number>();

  if (fs.existsSync(specsDir)) {
    try {
      const files = fs.readdirSync(specsDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const numStr = file.split('-')[0];
        const num = parseInt(numStr, 10);
        if (!Number.isNaN(num)) specNumbers.add(num);
      }
    } catch {
      // Silently continue
    }
  }

  return issues
    .filter(issue => !prLinkedIssues.has(issue.number))
    .map(issue => {
      const { type, priority } = parseLabelDefaults(issue.labels);
      return {
        number: issue.number,
        title: issue.title,
        type,
        priority,
        hasSpec: specNumbers.has(issue.number),
        hasBuilder: activeBuilderIssues.has(issue.number),
        createdAt: issue.createdAt,
      };
    });
}

// =============================================================================
// OverviewCache
// =============================================================================

export class OverviewCache {
  private prCache: { data: GitHubPR[]; fetchedAt: number } | null = null;
  private issueCache: { data: GitHubIssueListItem[]; fetchedAt: number } | null = null;
  private readonly TTL = 60_000;

  /**
   * Build the overview response. Aggregates builder state, PRs, and backlog.
   */
  async getOverview(workspaceRoot: string): Promise<OverviewData> {
    const errors: { prs?: string; issues?: string } = {};

    // 1. Discover builders from .builders/ directory
    const builders = discoverBuilders(workspaceRoot);
    const activeBuilderIssues = new Set(
      builders
        .map(b => b.issueNumber)
        .filter((n): n is number => n !== null),
    );

    // 2. Fetch PRs (cached)
    let pendingPRs: PROverview[] = [];
    const prs = await this.fetchPRsCached();
    if (prs === null) {
      errors.prs = 'GitHub CLI unavailable — could not fetch PRs';
    } else {
      pendingPRs = prs.map(pr => ({
        number: pr.number,
        title: pr.title,
        reviewStatus: pr.reviewDecision || 'REVIEW_REQUIRED',
        linkedIssue: parseLinkedIssue(pr.body || '', pr.title),
      }));
    }

    const prLinkedIssues = new Set(
      pendingPRs
        .map(pr => pr.linkedIssue)
        .filter((n): n is number => n !== null),
    );

    // 3. Fetch issues and derive backlog (cached)
    let backlog: BacklogItem[] = [];
    const issues = await this.fetchIssuesCached();
    if (issues === null) {
      errors.issues = 'GitHub CLI unavailable — could not fetch issues';
    } else {
      backlog = deriveBacklog(issues, workspaceRoot, activeBuilderIssues, prLinkedIssues);
    }

    const result: OverviewData = { builders, pendingPRs, backlog };
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
  }

  // ===========================================================================
  // Private cache helpers
  // ===========================================================================

  private async fetchPRsCached(): Promise<GitHubPR[] | null> {
    const now = Date.now();
    if (this.prCache && (now - this.prCache.fetchedAt) < this.TTL) {
      return this.prCache.data;
    }

    const data = await fetchPRList();
    if (data !== null) {
      this.prCache = { data, fetchedAt: now };
    }
    return data;
  }

  private async fetchIssuesCached(): Promise<GitHubIssueListItem[] | null> {
    const now = Date.now();
    if (this.issueCache && (now - this.issueCache.fetchedAt) < this.TTL) {
      return this.issueCache.data;
    }

    const data = await fetchIssueList();
    if (data !== null) {
      this.issueCache = { data, fetchedAt: now };
    }
    return data;
  }
}
