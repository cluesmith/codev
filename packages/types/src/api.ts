/**
 * Tower API response shapes.
 *
 * These types are shared between the server (packages/codev),
 * the browser dashboard (packages/codev/dashboard), and the
 * VS Code extension (packages/codev-vscode).
 */

// --- Dashboard State (GET /workspace/:path/api/state) ---

export interface ArchitectState {
  port: number;
  pid: number;
  terminalId?: string;
  persistent?: boolean;
}

export interface Builder {
  id: string;
  name: string;
  port: number;
  pid: number;
  status: string;
  phase: string;
  worktree: string;
  branch: string;
  type: string;
  projectId?: string;
  terminalId?: string;
  persistent?: boolean;
}

export interface UtilTerminal {
  id: string;
  name: string;
  port: number;
  pid: number;
  terminalId?: string;
  persistent?: boolean;
  lastDataAt?: number;
}

export interface Annotation {
  id: string;
  file: string;
  port: number;
  pid: number;
  parent: { type: string; id?: string };
}

export interface DashboardState {
  architect: ArchitectState | null;
  builders: Builder[];
  utils: UtilTerminal[];
  annotations: Annotation[];
  workspaceName?: string;
  version?: string;
  hostname?: string;
  teamEnabled?: boolean;
}

// --- Terminal Entry (returned by tower routes) ---

export interface TerminalEntry {
  type: 'architect' | 'builder' | 'shell' | 'file';
  id: string;
  label: string;
  url: string;
  active: boolean;
}

// --- Overview (GET /api/overview) ---

export interface OverviewBuilder {
  id: string;
  issueId: string | null;
  issueTitle: string | null;
  phase: string;
  mode: 'strict' | 'soft';
  gates: Record<string, string>;
  worktreePath: string;
  protocol: string;
  planPhases: Array<{ id: string; title: string; status: string }>;
  progress: number;
  blocked: string | null;
  blockedSince: string | null;
  startedAt: string | null;
  idleMs: number;
}

export interface OverviewPR {
  id: string;
  title: string;
  url: string;
  reviewStatus: string;
  linkedIssue: string | null;
  createdAt: string;
  author?: string;
}

export interface OverviewBacklogItem {
  id: string;
  title: string;
  url: string;
  type: string;
  priority: string;
  hasSpec: boolean;
  hasPlan: boolean;
  hasReview: boolean;
  hasBuilder: boolean;
  createdAt: string;
  author?: string;
  assignees?: string[];
  specPath?: string;
  planPath?: string;
  reviewPath?: string;
}

export interface OverviewRecentlyClosed {
  id: string;
  title: string;
  url: string;
  type: string;
  closedAt: string;
  prUrl?: string;
  specPath?: string;
  planPath?: string;
  reviewPath?: string;
}

export interface OverviewData {
  builders: OverviewBuilder[];
  pendingPRs: OverviewPR[];
  backlog: OverviewBacklogItem[];
  recentlyClosed: OverviewRecentlyClosed[];
  errors?: { prs?: string; issues?: string };
}

// --- Team (GET /workspace/:path/api/team) ---

export interface ReviewBlockingEntry {
  direction: 'authored' | 'reviewing';
  otherName: string;
  otherGithub: string;
  pr: {
    number: number;
    title: string;
    url: string;
    createdAt: string;
  };
}

export interface TeamMemberGitHubData {
  assignedIssues: { number: number; title: string; url: string }[];
  openPRs: { number: number; title: string; url: string }[];
  recentActivity: {
    mergedPRs: { number: number; title: string; url: string; mergedAt: string }[];
    closedIssues: { number: number; title: string; url: string; closedAt: string }[];
  };
  reviewBlocking: ReviewBlockingEntry[];
}

export interface TeamApiMember {
  name: string;
  github: string;
  role: string;
  filePath: string;
  github_data: TeamMemberGitHubData | null;
}

export interface TeamApiMessage {
  author: string;
  timestamp: string;
  body: string;
  channel: string;
}

export interface TeamApiResponse {
  enabled: boolean;
  members?: TeamApiMember[];
  messages?: TeamApiMessage[];
  warnings?: string[];
  githubError?: string;
}

// --- Tunnel (GET /api/tunnel/status) ---

export interface TunnelStatus {
  registered: boolean;
  state: 'disconnected' | 'connecting' | 'connected' | 'auth_failed' | 'error';
  uptime: number | null;
  towerId: string | null;
  towerName: string | null;
  serverUrl: string | null;
  accessUrl: string | null;
}

// --- Analytics (GET /api/analytics) ---

export interface ProtocolStats {
  count: number;
  avgWallClockHours: number | null;
  avgAgentTimeHours: number | null;
}

export interface AnalyticsResponse {
  timeRange: '24h' | '7d' | '30d' | 'all';
  activity: {
    prsMerged: number;
    medianTimeToMergeHours: number | null;
    issuesClosed: number;
    medianTimeToCloseBugsHours: number | null;
    projectsByProtocol: Record<string, ProtocolStats>;
  };
  consultation: {
    totalCount: number;
    totalCostUsd: number | null;
    costByModel: Record<string, number>;
    avgLatencySeconds: number | null;
    successRate: number | null;
    byModel: Array<{
      model: string;
      count: number;
      avgLatency: number;
      totalCost: number | null;
      successRate: number;
    }>;
    byReviewType: Record<string, number>;
    byProtocol: Record<string, number>;
  };
  errors?: {
    github?: string;
    consultation?: string;
  };
}
