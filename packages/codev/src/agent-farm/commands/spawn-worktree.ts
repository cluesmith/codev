/**
 * Git worktree management, session creation, and pre-spawn utilities.
 * Spec 0105: Tower Server Decomposition — Phase 7
 *
 * Handles worktree creation, dependency checking, porch initialization,
 * bugfix collision detection, GitHub issue fetching, pre-spawn hooks,
 * and terminal session creation via the Tower REST API.
 */

import { resolve } from 'node:path';
import { existsSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import type { Config, ProtocolDefinition } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { run, commandExists } from '../utils/shell.js';

// Tower port — the single HTTP server since Spec 0090
export const DEFAULT_TOWER_PORT = 4100;

// =============================================================================
// Dependency Checks
// =============================================================================

/**
 * Check for required dependencies
 */
export async function checkDependencies(): Promise<void> {
  if (!(await commandExists('git'))) {
    fatal('git not found');
  }
}

// =============================================================================
// Git Worktree Management
// =============================================================================

/**
 * Create git branch and worktree
 */
export async function createWorktree(config: Config, branchName: string, worktreePath: string): Promise<void> {
  logger.info('Creating branch...');
  try {
    await run(`git branch ${branchName}`, { cwd: config.workspaceRoot });
  } catch (error) {
    // Branch might already exist, that's OK
    logger.debug(`Branch creation: ${error}`);
  }

  logger.info('Creating worktree...');
  try {
    await run(`git worktree add "${worktreePath}" ${branchName}`, { cwd: config.workspaceRoot });
  } catch (error) {
    fatal(`Failed to create worktree: ${error}`);
  }

  // Symlink .env from workspace root into worktree (if it exists)
  const rootEnvPath = resolve(config.workspaceRoot, '.env');
  const worktreeEnvPath = resolve(worktreePath, '.env');
  if (existsSync(rootEnvPath) && !existsSync(worktreeEnvPath)) {
    try {
      symlinkSync(rootEnvPath, worktreeEnvPath);
      logger.info('Linked .env from workspace root');
    } catch (error) {
      logger.debug(`Failed to symlink .env: ${error}`);
    }
  }
}

/**
 * Pre-initialize porch in a worktree so the builder doesn't need to self-correct.
 * Non-fatal: logs a warning on failure since the builder can still init manually.
 */
export async function initPorchInWorktree(
  worktreePath: string,
  protocol: string,
  projectId: string,
  projectName: string,
): Promise<void> {
  logger.info('Initializing porch...');
  try {
    // Sanitize inputs to prevent shell injection (defense-in-depth;
    // callers already use slugified names, but be safe)
    const safeName = projectName.replace(/[^a-z0-9_-]/gi, '-');
    const safeProto = protocol.replace(/[^a-z0-9_-]/gi, '');
    const safeId = projectId.replace(/[^a-z0-9_-]/gi, '');
    await run(`porch init ${safeProto} ${safeId} "${safeName}"`, { cwd: worktreePath });
    logger.info(`Porch initialized: ${projectId}`);
  } catch (error) {
    logger.warn(`Warning: Failed to initialize porch (builder can init manually): ${error}`);
  }
}

// =============================================================================
// GitHub Issue Utilities
// =============================================================================

/**
 * GitHub issue structure from gh issue view --json
 */
export interface GitHubIssue {
  title: string;
  body: string;
  state: string;
  comments: Array<{
    body: string;
    createdAt: string;
    author: { login: string };
  }>;
}

/**
 * Generate a slug from an issue title (max 30 chars, lowercase, alphanumeric + hyphens)
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .replace(/^-|-$/g, '')        // Trim leading/trailing hyphens
    .slice(0, 30);                // Max 30 chars
}

/**
 * Fetch a GitHub issue via gh CLI
 */
export async function fetchGitHubIssue(issueNumber: number): Promise<GitHubIssue> {
  try {
    const result = await run(`gh issue view ${issueNumber} --json title,body,state,comments`);
    return JSON.parse(result.stdout);
  } catch (error) {
    fatal(`Failed to fetch issue #${issueNumber}. Ensure 'gh' CLI is installed and authenticated.`);
    throw error; // TypeScript doesn't know fatal() never returns
  }
}

// =============================================================================
// Bugfix Collision Detection
// =============================================================================

/**
 * Check for collision conditions before spawning bugfix
 */
export async function checkBugfixCollisions(
  issueNumber: number,
  worktreePath: string,
  issue: GitHubIssue,
  force: boolean,
): Promise<void> {
  // 1. Check if worktree already exists
  if (existsSync(worktreePath)) {
    fatal(`Worktree already exists at ${worktreePath}\nRun: af cleanup --issue ${issueNumber}`);
  }

  // 2. Check for recent "On it" comments (< 24h old)
  const onItComments = issue.comments.filter((c) =>
    c.body.toLowerCase().includes('on it'),
  );
  if (onItComments.length > 0) {
    const lastComment = onItComments[onItComments.length - 1];
    const age = Date.now() - new Date(lastComment.createdAt).getTime();
    const hoursAgo = Math.round(age / (1000 * 60 * 60));

    if (hoursAgo < 24) {
      if (!force) {
        fatal(`Issue #${issueNumber} has "On it" comment from ${hoursAgo}h ago (by @${lastComment.author.login}).\nSomeone may already be working on this. Use --force to override.`);
      }
      logger.warn(`Warning: "On it" comment from ${hoursAgo}h ago - proceeding with --force`);
    } else {
      logger.warn(`Warning: Stale "On it" comment (${hoursAgo}h ago). Proceeding.`);
    }
  }

  // 3. Check for open PRs referencing this issue
  try {
    const prResult = await run(`gh pr list --search "in:body #${issueNumber}" --json number,title --limit 5`);
    const openPRs = JSON.parse(prResult.stdout);
    if (openPRs.length > 0) {
      if (!force) {
        const prList = openPRs.map((pr: { number: number; title: string }) => `  - PR #${pr.number}: ${pr.title}`).join('\n');
        fatal(`Found ${openPRs.length} open PR(s) referencing issue #${issueNumber}:\n${prList}\nUse --force to proceed anyway.`);
      }
      logger.warn(`Warning: Found ${openPRs.length} open PR(s) referencing issue - proceeding with --force`);
    }
  } catch {
    // Non-fatal: continue if PR check fails
  }

  // 4. Warn if issue is already closed
  if (issue.state === 'CLOSED') {
    logger.warn(`Warning: Issue #${issueNumber} is already closed`);
  }
}

// =============================================================================
// Pre-Spawn Hooks
// =============================================================================

/**
 * Execute pre-spawn hooks defined in protocol.json
 * Hooks are data-driven but reuse existing implementation logic
 */
export async function executePreSpawnHooks(
  protocol: ProtocolDefinition | null,
  context: {
    issueNumber?: number;
    issue?: GitHubIssue;
    worktreePath?: string;
    force?: boolean;
    noComment?: boolean;
  }
): Promise<void> {
  if (!protocol?.hooks?.['pre-spawn']) return;

  const hooks = protocol.hooks['pre-spawn'];

  // collision-check: reuses existing checkBugfixCollisions() logic
  if (hooks['collision-check'] && context.issueNumber && context.issue && context.worktreePath) {
    await checkBugfixCollisions(context.issueNumber, context.worktreePath, context.issue, !!context.force);
  }

  // comment-on-issue: posts comment to GitHub issue
  if (hooks['comment-on-issue'] && context.issueNumber && !context.noComment) {
    const message = hooks['comment-on-issue'];
    logger.info('Commenting on issue...');
    try {
      await run(`gh issue comment ${context.issueNumber} --body "${message}"`);
    } catch {
      logger.warn('Warning: Failed to comment on issue (continuing anyway)');
    }
  }
}

// =============================================================================
// Resume Validation
// =============================================================================

/**
 * Validate that a worktree exists and is valid for resuming
 */
export function validateResumeWorktree(worktreePath: string): void {
  if (!existsSync(worktreePath)) {
    fatal(`Cannot resume: worktree does not exist at ${worktreePath}`);
  }
  if (!existsSync(resolve(worktreePath, '.git'))) {
    fatal(`Cannot resume: ${worktreePath} is not a valid git worktree`);
  }
  logger.info('Resuming existing worktree (skipping creation)');
}

// =============================================================================
// Terminal Session Creation
// =============================================================================

/**
 * Create a terminal session via the Tower REST API.
 * The Tower server must be running (port 4100).
 */
export async function createPtySession(
  config: Config,
  command: string,
  args: string[],
  cwd: string,
  registration?: { workspacePath: string; type: 'builder' | 'shell'; roleId: string },
): Promise<{ terminalId: string }> {
  const body: Record<string, unknown> = { command, args, cwd, cols: 200, rows: 50, persistent: true };
  if (registration) {
    body.workspacePath = registration.workspacePath;
    body.type = registration.type;
    body.roleId = registration.roleId;
  }
  const response = await fetch(`http://localhost:${DEFAULT_TOWER_PORT}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create PTY session: ${response.status} ${text}`);
  }

  const result = await response.json() as { id: string };
  return { terminalId: result.id };
}

/**
 * Start a terminal session for a builder
 */
export async function startBuilderSession(
  config: Config,
  builderId: string,
  worktreePath: string,
  baseCmd: string,
  prompt: string,
  roleContent: string | null,
  roleSource: string | null,
): Promise<{ terminalId: string }> {
  logger.info('Creating terminal session...');

  // Write initial prompt to a file for reference
  const promptFile = resolve(worktreePath, '.builder-prompt.txt');
  writeFileSync(promptFile, prompt);

  // Build the start script with role if provided
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  let scriptContent: string;

  if (roleContent) {
    // Write role to a file and use $(cat) to avoid shell escaping issues
    const roleFile = resolve(worktreePath, '.builder-role.md');
    // Inject the actual dashboard port into the role prompt
    const roleWithPort = roleContent.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${roleSource})`);
    scriptContent = `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd} --append-system-prompt "$(cat '${roleFile}')" "$(cat '${promptFile}')"
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  } else {
    scriptContent = `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd} "$(cat '${promptFile}')"
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  }

  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, '755');

  // Create PTY session via Tower REST API (shellper for persistence)
  logger.info('Creating PTY terminal session...');
  const { terminalId } = await createPtySession(
    config,
    '/bin/bash',
    [scriptPath],
    worktreePath,
    { workspacePath: config.workspaceRoot, type: 'builder', roleId: builderId },
  );
  logger.info(`Terminal session created: ${terminalId}`);
  return { terminalId };
}

/**
 * Start a shell session (no worktree, just node-pty)
 */
export async function startShellSession(
  config: Config,
  shellId: string,
  baseCmd: string,
): Promise<{ terminalId: string }> {
  // Create PTY session via REST API
  logger.info('Creating PTY terminal session for shell...');
  const { terminalId } = await createPtySession(
    config,
    '/bin/bash',
    ['-c', baseCmd],
    config.workspaceRoot,
    { workspacePath: config.workspaceRoot, type: 'shell', roleId: shellId },
  );
  logger.info(`Shell terminal session created: ${terminalId}`);
  return { terminalId };
}

/**
 * Build a launch script for worktree mode (no initial prompt)
 */
export function buildWorktreeLaunchScript(
  worktreePath: string,
  baseCmd: string,
  role: { content: string; source: string } | null,
): string {
  if (role) {
    const roleFile = resolve(worktreePath, '.builder-role.md');
    const roleWithPort = role.content.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${role.source})`);
    return `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd} --append-system-prompt "$(cat '${roleFile}')"
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  }
  return `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd}
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
}
