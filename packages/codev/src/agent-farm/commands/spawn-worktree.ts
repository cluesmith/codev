/**
 * Git worktree management, session creation, and pre-spawn utilities.
 * Spec 0105: Tower Server Decomposition — Phase 7
 *
 * Handles worktree creation, dependency checking, porch initialization,
 * bugfix collision detection, GitHub issue fetching, pre-spawn hooks,
 * and terminal session creation via the Tower REST API.
 */

import { resolve } from 'node:path';
import { existsSync, writeFileSync, chmodSync, symlinkSync, readdirSync, mkdirSync } from 'node:fs';
import type { Config, ProtocolDefinition } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { getBuilderHarness } from '../utils/config.js';
import { defaultSessionOptions } from '../../terminal/index.js';
import { run, commandExists } from '../utils/shell.js';
import { fetchIssueOrThrow, type ForgeIssue } from '../../lib/github.js';
import { executeForgeCommand, type ForgeConfig } from '../../lib/forge.js';
import { getTowerClient, DEFAULT_TOWER_PORT } from '../lib/tower-client.js';

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
 * Symlink config files from workspace root into a worktree (if they exist).
 * Shared by createWorktree() and createWorktreeFromBranch().
 */
export function symlinkConfigFiles(config: Config, worktreePath: string): void {
  // Symlink .env at root level
  const envRoot = resolve(config.workspaceRoot, '.env');
  const envWorktree = resolve(worktreePath, '.env');
  if (existsSync(envRoot) && !existsSync(envWorktree)) {
    try {
      symlinkSync(envRoot, envWorktree);
      logger.info(`Linked .env from workspace root`);
    } catch (error) {
      logger.debug(`Failed to symlink .env: ${error}`);
    }
  }

  // Symlink .codev/config.json
  const configRoot = resolve(config.workspaceRoot, '.codev', 'config.json');
  if (existsSync(configRoot)) {
    const codevDir = resolve(worktreePath, '.codev');
    if (!existsSync(codevDir)) {
      mkdirSync(codevDir, { recursive: true });
    }
    const configWorktree = resolve(codevDir, 'config.json');
    if (!existsSync(configWorktree)) {
      try {
        symlinkSync(configRoot, configWorktree);
        logger.info(`Linked .codev/config.json from workspace root`);
      } catch (error) {
        logger.debug(`Failed to symlink .codev/config.json: ${error}`);
      }
    }
  }
}

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

  symlinkConfigFiles(config, worktreePath);
}

/**
 * Validate a branch name for safe use in shell commands.
 * Only allows valid git branch name characters: alphanumeric, dots, hyphens, underscores, slashes.
 * Rejects anything that could be used for shell injection.
 */
const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9._\/-]+$/;

export function validateBranchName(name: string): void {
  if (!name || name.length === 0) {
    fatal('--branch requires a branch name');
  }
  if (!SAFE_BRANCH_REGEX.test(name)) {
    fatal(`Invalid branch name: "${name}". Branch names may only contain alphanumeric characters, dots, hyphens, underscores, and slashes.`);
  }
}

/**
 * Validate a remote name for safe use in shell commands.
 * Same character restrictions as branch names.
 */
export function validateRemoteName(name: string): void {
  if (!name || name.length === 0) {
    fatal('--remote requires a remote name');
  }
  if (!SAFE_BRANCH_REGEX.test(name)) {
    fatal(`Invalid remote name: "${name}". Remote names may only contain alphanumeric characters, dots, hyphens, underscores, and slashes.`);
  }
}

/**
 * Detect if a branch belongs to a fork PR by querying GitHub.
 * Uses `gh pr list --head <branch>` to find open PRs with this branch name.
 * If a cross-repository (fork) PR is found, returns the fork owner and repo URL.
 * Returns null if no fork PR is found or `gh` is unavailable.
 */
export async function detectForkRemote(
  config: Config,
  branch: string,
): Promise<{ owner: string; url: string } | null> {
  // Fetch PR data — network/parse errors return null (graceful degradation)
  let prs: Array<Record<string, unknown>>;
  try {
    const { stdout } = await run(
      `gh pr list --head "${branch}" --json number,headRepositoryOwner,headRepository,isCrossRepository --state open`,
      { cwd: config.workspaceRoot },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    prs = JSON.parse(trimmed);
    if (!Array.isArray(prs) || prs.length === 0) return null;
  } catch {
    return null;
  }

  // Validation is outside try/catch so fatal() propagates
  const forkPrs = prs.filter((pr) => pr.isCrossRepository);
  if (forkPrs.length === 0) return null;

  // Ambiguity check: if multiple forks have the same branch name, require --remote
  if (forkPrs.length > 1) {
    const owners = forkPrs.map((pr) =>
      (pr.headRepositoryOwner as Record<string, string>)?.login,
    ).filter(Boolean);
    fatal(
      `Multiple fork PRs found for branch '${branch}' from: ${owners.join(', ')}.\n` +
      `Use --remote <name> to specify which fork to use.`
    );
  }

  const forkPr = forkPrs[0];
  const owner = (forkPr.headRepositoryOwner as Record<string, string>)?.login;
  const repo = (forkPr.headRepository as Record<string, string>)?.name;
  if (!owner || !repo) return null;

  return {
    owner,
    url: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Ensure a git remote exists with the given name and URL.
 * Adds the remote if it doesn't exist. If it exists but points to a
 * different URL, fatals with a clear message to avoid silent misrouting.
 */
async function ensureRemote(
  config: Config,
  name: string,
  url: string,
): Promise<void> {
  let existingUrl: string | null = null;
  try {
    const { stdout } = await run(`git remote get-url "${name}"`, { cwd: config.workspaceRoot });
    existingUrl = stdout.trim();
  } catch {
    // Remote doesn't exist — add it
    logger.info(`Adding remote '${name}' → ${url}`);
    await run(`git remote add "${name}" "${url}"`, { cwd: config.workspaceRoot });
    return;
  }

  // Remote exists — verify URL matches (outside try/catch so fatal propagates)
  if (existingUrl !== url) {
    fatal(
      `Remote '${name}' already exists but points to '${existingUrl}' (expected '${url}').\n` +
      `Remove or update the remote, or use --remote with the correct remote name.`
    );
  }
  logger.debug(`Remote '${name}' already configured`);
}

/**
 * Create a worktree from an existing remote branch (Spec 609).
 * Fetches the branch from the specified remote (or origin by default),
 * checks it's not already checked out, and creates a worktree on it.
 *
 * When the branch doesn't exist on origin and no explicit remote is given,
 * auto-detects fork PRs via `gh pr list` and fetches from the fork remote.
 */
export async function createWorktreeFromBranch(
  config: Config,
  branch: string,
  worktreePath: string,
  options?: { remote?: string },
): Promise<void> {
  validateBranchName(branch);
  if (options?.remote) validateRemoteName(options.remote);

  const explicitRemote = options?.remote;
  let remote = explicitRemote || 'origin';

  // Fetch latest from remote
  logger.info(`Fetching from remote '${remote}'...`);
  try {
    await run(`git fetch "${remote}"`, { cwd: config.workspaceRoot });
  } catch (error) {
    fatal(`Failed to fetch from remote '${remote}': ${error}`);
  }

  // Verify branch exists on the remote
  let branchExists = false;
  try {
    const { stdout } = await run(`git ls-remote --heads "${remote}" "${branch}"`, { cwd: config.workspaceRoot });
    branchExists = !!stdout.trim();
  } catch (error) {
    fatal(`Failed to check remote branch: ${error}`);
  }

  // If branch not found and no explicit remote was given, try fork detection
  if (!branchExists && !explicitRemote) {
    logger.info(`Branch '${branch}' not found on origin. Checking for fork PRs...`);
    const fork = await detectForkRemote(config, branch);
    if (fork) {
      validateRemoteName(fork.owner);
      logger.info(`Found fork PR from '${fork.owner}'. Fetching from fork...`);
      await ensureRemote(config, fork.owner, fork.url);
      remote = fork.owner;
      try {
        await run(`git fetch "${remote}" "${branch}"`, { cwd: config.workspaceRoot });
      } catch (error) {
        fatal(`Failed to fetch branch '${branch}' from fork remote '${remote}': ${error}`);
      }
      // Re-verify after fetching from fork
      try {
        const { stdout } = await run(`git ls-remote --heads "${remote}" "${branch}"`, { cwd: config.workspaceRoot });
        branchExists = !!stdout.trim();
      } catch {
        // Fall through to error below
      }
    }
  }

  if (!branchExists) {
    if (explicitRemote) {
      fatal(`Branch '${branch}' does not exist on remote '${explicitRemote}'. Check the branch name and try again.`);
    } else {
      fatal(
        `Branch '${branch}' does not exist on the remote. Check the branch name and try again.\n` +
        `If this branch is from a fork, use --remote <name> to specify the fork remote.`
      );
    }
  }

  // Pre-check: is the branch already checked out in another worktree?
  let alreadyCheckedOutAt: string | null = null;
  try {
    const { stdout } = await run('git worktree list --porcelain', { cwd: config.workspaceRoot });
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.startsWith('branch refs/heads/') && line === `branch refs/heads/${branch}`) {
        // Find the worktree path for this branch (it's the preceding 'worktree' line)
        const idx = lines.indexOf(line);
        let wtPath = '(unknown)';
        for (let i = idx - 1; i >= 0; i--) {
          if (lines[i].startsWith('worktree ')) {
            wtPath = lines[i].replace('worktree ', '');
            break;
          }
        }
        alreadyCheckedOutAt = wtPath;
        break;
      }
    }
  } catch (error) {
    // Non-fatal — git worktree list failing shouldn't block spawn
    logger.debug(`Worktree list check: ${error}`);
  }
  if (alreadyCheckedOutAt) {
    fatal(
      `Branch '${branch}' is already checked out at '${alreadyCheckedOutAt}'.\n` +
      `Switch that checkout to a different branch first, or use 'afx cleanup' to remove the worktree.`
    );
  }

  // Create worktree with the existing branch.
  // Try creating a local tracking branch first; if it already exists, use it directly.
  logger.info(`Creating worktree on branch '${branch}'...`);
  try {
    await run(`git worktree add "${worktreePath}" -b "${branch}" "${remote}/${branch}"`, { cwd: config.workspaceRoot });
  } catch {
    // Local branch may already exist — try using it directly
    try {
      await run(`git worktree add "${worktreePath}" "${branch}"`, { cwd: config.workspaceRoot });
    } catch (error) {
      fatal(`Failed to create worktree on branch '${branch}': ${error}`);
    }
  }

  symlinkConfigFiles(config, worktreePath);
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

// Re-export ForgeIssue (and deprecated alias) for backward compatibility with tests
export type { ForgeIssue, GitHubIssue } from '../../lib/github.js';

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
 * Find an existing bugfix worktree directory for a given issue number.
 * Scans the builders directory for directories matching `bugfix-{issueNumber}-*`.
 * Returns the directory name if found, or null if no match exists.
 */
export function findExistingBugfixWorktree(buildersDir: string, issueNumber: number): string | null {
  const prefix = `bugfix-${issueNumber}-`;
  try {
    const entries = readdirSync(buildersDir, { withFileTypes: true });
    const match = entries.find(e => e.isDirectory() && e.name.startsWith(prefix));
    return match ? match.name : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a GitHub issue via the `issue-view` concept command (fatal on failure).
 * Delegates to shared github utility but wraps with fatal() for spawn context.
 */
export async function fetchGitHubIssue(
  issueNumber: number,
  options?: { cwd?: string; forgeConfig?: ForgeConfig | null },
): Promise<ForgeIssue> {
  try {
    return await fetchIssueOrThrow(issueNumber, options);
  } catch (error) {
    fatal(
      `Failed to fetch issue #${issueNumber}. ` +
      `Ensure the 'issue-view' forge concept command is configured ` +
      `(default: 'gh' CLI must be installed and authenticated). ` +
      `Configure forge commands in .codev/config.json if using a non-GitHub forge.`,
    );
    throw error; // TypeScript doesn't know fatal() never returns
  }
}

// =============================================================================
// Bugfix Collision Detection
// =============================================================================

/**
 * Check for collision conditions before spawning bugfix.
 * Uses forge concept commands for PR search (graceful degradation if unavailable).
 */
export async function checkBugfixCollisions(
  issueNumber: number,
  worktreePath: string,
  issue: ForgeIssue,
  force: boolean,
  forgeConfig?: ForgeConfig | null,
): Promise<void> {
  // 1. Check if worktree already exists
  if (existsSync(worktreePath)) {
    fatal(`Worktree already exists at ${worktreePath}\nRun: afx cleanup --issue ${issueNumber}`);
  }

  // 2. Check for recent "On it" comments (< 24h old)
  // Depends on issue-view returning comments array; if missing, skip gracefully
  if (issue.comments) {
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
  }

  // 3. Check for open PRs referencing this issue via pr-search concept
  try {
    const result = await executeForgeCommand('pr-search', {
      CODEV_SEARCH_QUERY: `in:body #${issueNumber}`,
    }, { forgeConfig });
    if (result && Array.isArray(result) && result.length > 0) {
      const openPRs = result as Array<{ number: number; title?: string; headRefName?: string }>;
      if (!force) {
        const prList = openPRs.slice(0, 5).map((pr) =>
          `  - PR #${pr.number}${pr.title ? `: ${pr.title}` : ''}`,
        ).join('\n');
        fatal(`Found ${openPRs.length} open PR(s) referencing issue #${issueNumber}:\n${prList}\nUse --force to proceed anyway.`);
      }
      logger.warn(`Warning: Found ${openPRs.length} open PR(s) referencing issue - proceeding with --force`);
    }
  } catch {
    // Non-fatal: continue if PR search concept unavailable
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
 * Execute pre-spawn hooks defined in protocol.json.
 * Hooks are data-driven but reuse existing implementation logic.
 * Uses forge concept commands for collision detection and issue commenting.
 */
export async function executePreSpawnHooks(
  protocol: ProtocolDefinition | null,
  context: {
    issueNumber?: number;
    issue?: ForgeIssue;
    worktreePath?: string;
    force?: boolean;
    noComment?: boolean;
    forgeConfig?: ForgeConfig | null;
  }
): Promise<void> {
  if (!protocol?.hooks?.['pre-spawn']) return;

  const hooks = protocol.hooks['pre-spawn'];

  // collision-check: reuses existing checkBugfixCollisions() logic
  if (hooks['collision-check'] && context.issueNumber && context.issue && context.worktreePath) {
    await checkBugfixCollisions(
      context.issueNumber, context.worktreePath, context.issue,
      !!context.force, context.forgeConfig,
    );
  }

  // comment-on-issue: posts comment via issue-comment concept command
  if (hooks['comment-on-issue'] && context.issueNumber && !context.noComment) {
    const message = hooks['comment-on-issue'];
    logger.info('Commenting on issue...');
    try {
      await executeForgeCommand('issue-comment', {
        CODEV_ISSUE_ID: String(context.issueNumber),
        CODEV_COMMENT_BODY: message,
      }, { forgeConfig: context.forgeConfig, raw: true });
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
 * The Tower server must be running.
 */
export async function createPtySession(
  config: Config,
  command: string,
  args: string[],
  cwd: string,
  registration?: { workspacePath: string; type: 'builder' | 'shell'; roleId: string },
): Promise<{ terminalId: string }> {
  const { cols, rows } = defaultSessionOptions();
  const client = getTowerClient();
  const terminal = await client.createTerminal({
    command, args, cwd, cols, rows,
    persistent: true,
    workspacePath: registration?.workspacePath,
    type: registration?.type,
    roleId: registration?.roleId,
  });

  if (!terminal) {
    throw new Error('Failed to create PTY session: tower returned null');
  }

  return { terminalId: terminal.id };
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
    // Write role to a file for harness-based injection
    const roleFile = resolve(worktreePath, '.builder-role.md');
    // Inject the actual dashboard port into the role prompt
    const roleWithPort = roleContent.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${roleSource})`);

    // Resolve harness provider for role injection
    const harness = getBuilderHarness(config.workspaceRoot);
    const { fragment, env } = harness.buildScriptRoleInjection(roleWithPort, roleFile);
    const envExports = Object.entries(env)
      .map(([k, v]) => `export ${k}='${v}'`)
      .join('\n');
    const envBlock = envExports ? `${envExports}\n` : '';

    scriptContent = `#!/bin/bash
cd "${worktreePath}"
${envBlock}while true; do
  ${baseCmd} ${fragment} "$(cat '${promptFile}')"
  echo ""
  echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  } else {
    scriptContent = `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd} "$(cat '${promptFile}')"
  echo ""
  echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"
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
  workspaceRoot?: string,
): string {
  if (role) {
    const roleFile = resolve(worktreePath, '.builder-role.md');
    const roleWithPort = role.content.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${role.source})`);

    // Resolve harness provider for role injection
    const harness = getBuilderHarness(workspaceRoot);
    const { fragment, env } = harness.buildScriptRoleInjection(roleWithPort, roleFile);
    const envExports = Object.entries(env)
      .map(([k, v]) => `export ${k}='${v}'`)
      .join('\n');
    const envBlock = envExports ? `${envExports}\n` : '';

    return `#!/bin/bash
cd "${worktreePath}"
${envBlock}while true; do
  ${baseCmd} ${fragment}
  echo ""
  echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
  }
  return `#!/bin/bash
cd "${worktreePath}"
while true; do
  ${baseCmd}
  echo ""
  echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`;
}
