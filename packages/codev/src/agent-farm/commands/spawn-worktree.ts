/**
 * Git worktree management, session creation, and pre-spawn utilities.
 * Spec 0105: Tower Server Decomposition — Phase 7
 *
 * Handles worktree creation, dependency checking, porch initialization,
 * bugfix collision detection, GitHub issue fetching, pre-spawn hooks,
 * and terminal session creation via the Tower REST API.
 */

import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  statSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { globSync } from 'glob';
import type { Config, ProtocolDefinition } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { getBuilderHarness, getWorktreeConfig } from '../utils/config.js';
import { shellEscapeSingleQuote, launchLoopTail, type HarnessProvider } from '../utils/harness.js';
import { defaultSessionOptions } from '../../terminal/index.js';
import { run, runStreaming, commandExists } from '../utils/shell.js';
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
 * True when `p` already exists on disk, including a *dangling* symlink (a link
 * whose target is absent). `existsSync` follows symlinks, so it reports `false`
 * for a dangling link even though the link file occupies the path — which would
 * make a re-run of `symlinkConfigFiles` (e.g. `afx setup`) throw EEXIST. The
 * `lstatSync` fallback inspects the link itself without following it.
 */
function pathOccupied(p: string): boolean {
  if (existsSync(p)) return true;
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Symlink config files from workspace root into a worktree (if they exist).
 * Shared by createWorktree() and createWorktreeFromBranch().
 *
 * Always symlinks root `.env` and `.codev/config.json` (existing behavior).
 * Additionally, when `worktree.symlinks` is configured in `.codev/config.json`,
 * each entry is linked into the worktree at the same relative path:
 *   - File entries (no trailing slash) are glob-expanded with `nodir: true`, so
 *     a pattern that resolves to a directory is silently skipped — this guards
 *     against masking the worktree's own source with the parent checkout.
 *   - Directory entries (trailing slash) opt explicitly out of that guard: the
 *     slash is stripped, the remainder is treated as a literal path, and the
 *     directory is symlinked whole. The source need not exist at spawn time — a
 *     dangling link is acceptable (runtime tooling may create the dir later).
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

  // Opt-in: link each worktree.symlinks entry at the same relative path inside
  // the worktree. Unconfigured repos see no effect.
  for (const pattern of getWorktreeConfig(config.workspaceRoot).symlinks) {
    if (pattern.endsWith('/')) {
      // Directory opt-in: literal path, symlinked whole (see fn-level comment).
      const rel = pattern.slice(0, -1);
      if (!rel) continue; // guard against a bare "/" entry
      if (/[*?[\]{}!()]/.test(rel)) {
        logger.warn(`Skipping worktree.symlinks entry "${pattern}": directory entries are literal paths, not globs.`);
        continue;
      }
      const target = resolve(worktreePath, rel);
      if (pathOccupied(target)) continue;
      const srcAbs = resolve(config.workspaceRoot, rel);
      mkdirSync(dirname(target), { recursive: true });
      const isDir = existsSync(srcAbs) && statSync(srcAbs).isDirectory();
      symlinkSync(srcAbs, target, isDir ? 'dir' : undefined);
      logger.info(`Linked directory ${rel}/ from workspace root`);
    } else {
      for (const rel of globSync(pattern, { cwd: config.workspaceRoot, dot: true, nodir: true })) {
        const target = resolve(worktreePath, rel);
        if (existsSync(target)) continue;
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(resolve(config.workspaceRoot, rel), target);
        logger.info(`Linked ${rel} from workspace root`);
      }
    }
  }
}

/**
 * Refresh the builder's personal project configuration from the main
 * workspace without creating a write-through symlink.
 *
 * The main workspace is authoritative when its config.local.json exists.
 * Copying through a sibling temporary file keeps replacement atomic. When the
 * main file is absent, an existing builder-local preference is left untouched.
 *
 * @returns true when a snapshot was written, false when no source existed
 */
export function syncLocalConfigSnapshot(config: Config, worktreePath: string): boolean {
  const source = resolve(config.workspaceRoot, '.codev', 'config.local.json');
  if (!existsSync(source)) return false;

  const targetDir = resolve(worktreePath, '.codev');
  const target = resolve(targetDir, 'config.local.json');
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;

  mkdirSync(targetDir, { recursive: true });
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }

  logger.info('Refreshed .codev/config.local.json snapshot from workspace root');
  return true;
}

/**
 * Run user-configured post-spawn commands inside a freshly-created worktree.
 *
 * Each command runs sequentially in its own `bash -c` subshell with cwd =
 * worktreePath — so `cd` inside one command (e.g. `cd apps/foo && uv sync`)
 * doesn't carry over into the next. Output streams live via runStreaming
 * so users see install progress in real time. A non-zero exit aborts the
 * sequence; the half-built worktree stays where it is.
 */
export async function runPostSpawnHooks(
  worktreePath: string,
  commands: string[],
): Promise<void> {
  for (const cmd of commands) {
    logger.info(`Running post-spawn hook: ${cmd}`);
    await runStreaming(cmd, { cwd: worktreePath });
  }
}

/**
 * Create git branch and worktree, then run the configured worktree setup
 * (symlinks + post-spawn hooks). Callers do not need to invoke setup
 * separately — `createWorktree` produces a runnable worktree.
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
  syncLocalConfigSnapshot(config, worktreePath);
  await runPostSpawnHooks(worktreePath, getWorktreeConfig(config.workspaceRoot).postSpawn);
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
  syncLocalConfigSnapshot(config, worktreePath);
  await runPostSpawnHooks(worktreePath, getWorktreeConfig(config.workspaceRoot).postSpawn);
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
 * Find an existing issue-driven worktree directory for a given protocol prefix
 * and issue number. Scans the builders directory for directories matching
 * `<protocolPrefix>-<issueNumber>-*`. Returns the directory name if found, or
 * null if no match exists.
 *
 * Used by the bugfix / PIR resume path to locate a worktree whose suffix
 * (slug) may have changed since the original spawn.
 */
export function findExistingIssueWorktree(
  buildersDir: string,
  protocolPrefix: string,
  issueNumber: number | string,
): string | null {
  const dirPrefix = `${protocolPrefix}-${issueNumber}-`;
  try {
    const entries = readdirSync(buildersDir, { withFileTypes: true });
    const match = entries.find(e => e.isDirectory() && e.name.startsWith(dirPrefix));
    return match ? match.name : null;
  } catch {
    return null;
  }
}

/**
 * @deprecated Use `findExistingIssueWorktree(buildersDir, 'bugfix', issueNumber)` directly.
 * Kept as a thin wrapper for backwards compatibility with existing tests.
 */
export function findExistingBugfixWorktree(buildersDir: string, issueNumber: number | string): string | null {
  return findExistingIssueWorktree(buildersDir, 'bugfix', issueNumber);
}

/**
 * Fetch a GitHub issue via the `issue-view` concept command (fatal on failure).
 * Delegates to shared github utility but wraps with fatal() for spawn context.
 */
export async function fetchGitHubIssue(
  issueNumber: number | string,
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
  issueNumber: number | string,
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
    issueNumber?: number | string;
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
  registration?: {
    workspacePath: string;
    /** Architects are spawned server-side by Tower's launchInstance, not via this path. */
    type: 'builder' | 'shell' | 'dev';
    roleId: string;
    label?: string;
  },
): Promise<{ terminalId: string }> {
  const { cols, rows } = defaultSessionOptions();
  const client = getTowerClient();
  const terminal = await client.createTerminal({
    command, args, cwd, cols, rows,
    persistent: true,
    workspacePath: registration?.workspacePath,
    type: registration?.type,
    roleId: registration?.roleId,
    label: registration?.label,
  });

  if (!terminal) {
    throw new Error('Failed to create PTY session: tower returned null');
  }

  return { terminalId: terminal.id };
}

/**
 * Write harness-provided files to the worktree, merging with existing JSON files.
 * For JSON files: reads existing file, shallow-merges properties, and deduplicates
 * the 'instructions' array. If existing JSON can't be parsed (e.g., JSONC with
 * comments), warns and skips to avoid destroying user config.
 * After writing, marks files with git skip-worktree to prevent accidental commits.
 */
function writeWorktreeFiles(
  files: Array<{ relativePath: string; content: string }>,
  worktreePath: string,
): void {
  for (const file of files) {
    const targetPath = resolve(worktreePath, file.relativePath);
    // Generated files may live in a subdir that doesn't exist yet in a fresh
    // worktree (e.g. .claude/hooks/ for the write-guard — Issue #1018).
    mkdirSync(dirname(targetPath), { recursive: true });
    if (file.relativePath.endsWith('.json') && existsSync(targetPath)) {
      try {
        const existing = JSON.parse(readFileSync(targetPath, 'utf-8'));
        const incoming = JSON.parse(file.content);
        const merged = { ...existing, ...incoming };
        if (Array.isArray(existing.instructions) && Array.isArray(incoming.instructions)) {
          merged.instructions = [...new Set([...existing.instructions, ...incoming.instructions])];
        }
        writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n');
      } catch {
        // Existing file is not valid JSON (likely JSONC with comments/trailing commas).
        // Do NOT overwrite — that would destroy user config. Warn and skip.
        logger.warn(`Cannot merge ${file.relativePath}: existing file is not valid JSON. Skipping to preserve user config.`);
        continue;
      }
    } else {
      writeFileSync(targetPath, file.content);
    }
    // Prevent generated files from being accidentally committed back to the repo
    try {
      execSync(`git update-index --skip-worktree "${file.relativePath}"`, {
        cwd: worktreePath,
        stdio: 'pipe',
      });
    } catch {
      // Non-fatal: file may not be tracked by git yet (new file in worktree)
    }
  }
}

/**
 * Install harness-specific worktree files. Role-independent — keyed on the
 * worktree path — so the Claude write-guard hook (Issue #1018) lands for EVERY
 * fresh Claude spawn mode, not only role-bearing ones. `roleContent`/`roleFile`
 * are '' for no-role spawns; CLAUDE_HARNESS ignores them and uses only the path.
 */
function installHarnessWorktreeFiles(
  harness: HarnessProvider,
  roleContent: string,
  roleFile: string,
  worktreePath: string,
): void {
  if (harness.getWorktreeFiles) {
    writeWorktreeFiles(harness.getWorktreeFiles(roleContent, roleFile, worktreePath), worktreePath);
  }
}

/**
 * Build the `while true; do … done` launch loop for a builder script.
 *
 * `initial` is what the loop runs on entry, and what a crash restart reruns —
 * on the resume path that is `<cmd> --resume <id>`, because recovering the
 * conversation is exactly right after an unnatural death.
 *
 * `fresh` is what the Enter-gated relaunch runs after a *clean* exit. Issue
 * #1267: a clean exit means the user deliberately ended that conversation, so
 * relaunching it is the one thing the relaunch must not do — the same rule
 * #1264 established for architect terminals. `fresh` is the plain
 * role-injected, prompt-carrying invocation a non-resume spawn would have used,
 * so "fresh" needs no definition of its own.
 *
 * The switch is one-way and sticky: once a clean exit has moved the loop to
 * `fresh`, a later crash restarts the *fresh* invocation, never the superseded
 * session the user walked away from.
 *
 * The two commands differ only on the resume path. Every other variant passes
 * the same string twice and gets the historical single-command loop back,
 * byte for byte.
 *
 * Issue #1233: this loop now serves only harnesses WITHOUT script-form session
 * support (codex/gemini/opencode/custom) — their generated script is unchanged,
 * byte for byte. Claude builders get `buildSessionLaunchLoop` instead, which
 * resumes the conversation on crash restarts rather than replaying the prompt.
 */
export function buildLaunchLoop(initial: string, fresh: string): string {
  if (initial === fresh) {
    return `while true; do
  ${initial}
${launchLoopTail()}
done
`;
  }
  // Functions, not a re-expanded string: the commands carry their own quoting
  // (`--append-system-prompt "$(cat '…')"`), which would not survive being
  // stuffed through a variable and word-split at call time.
  return `codev_launch_initial() {
  ${initial}
}
codev_launch_fresh() {
  ${fresh}
}
codev_launch=codev_launch_initial
while true; do
  "$codev_launch"
${launchLoopTail('codev_launch=codev_launch_fresh')}
done
`;
}

/**
 * The prompt a crash-resume invocation carries (Issue #1233). Without it,
 * `--resume` restores the conversation but leaves the agent idle at the input
 * prompt — for an unattended builder that converts amnesia into a stall. The
 * nudge is a new user message in the restored conversation, so the builder
 * re-orients itself and continues autonomously. Deliberately free of
 * single quotes: it is embedded single-quoted in the generated script.
 */
export const CRASH_RESUME_NUDGE =
  'You were automatically restarted after a crash. Your prior conversation context has been restored. '
  + 'Re-orient yourself (in strict mode run porch next for your project; check queued afx messages) '
  + 'and continue your work from where you left off.';

/** The shell expression the session-aware loop's commands use to reference the current session id. */
export const SESSION_ID_EXPR = '"$codev_session_id"';

/**
 * Script-form session support for a harness, or undefined when the harness
 * cannot pin/resume a conversation from a generated bash script. Both fragment
 * forms are required — the session-aware loop needs to pin AND resume.
 */
export function scriptSessionForms(harness: HarnessProvider): {
  newSessionScriptFragment(idExpr: string): string;
  resumeScriptFragment(idExpr: string): string;
} | undefined {
  const session = harness.session;
  if (!session?.newSessionScriptFragment || !session?.resumeScriptFragment) return undefined;
  return {
    newSessionScriptFragment: session.newSessionScriptFragment.bind(session),
    resumeScriptFragment: session.resumeScriptFragment.bind(session),
  };
}

/**
 * Build the session-aware launch loop (Issue #1233) — the builder-side
 * expression of the architect resume pattern (#832/#1264): the wrapper pins a
 * conversation id at entry and *resumes* it after an unnatural exit, instead of
 * replaying the spawn prompt into a fresh session (the amnesia path this issue
 * removes). A jetsam SIGKILL now costs 2 seconds, not the builder's memory.
 *
 * State machine, expressed in generated bash because builder liveness is
 * deliberately decoupled from Tower (persistent PTYs survive Tower restarts,
 * so no Node process is guaranteed to be around when the crash fires):
 *
 * - Entry: `initial` if given (the recover path's discovered-id resume), else
 *   the pinned fresh invocation (`--session-id` + role + prompt).
 * - Unnatural exit → resume `$codev_session_id` with a short nudge prompt, so
 *   the restored builder re-orients and continues rather than idling.
 * - Clean exit → Enter-gated relaunch stays FRESH per #1267/#1264 ("a clean
 *   exit ends that conversation"), but pinned to a newly minted id so the new
 *   conversation is crash-protected too. Sticky and one-way, like #1267.
 * - Unresumable-session degrade (#1145/#1149 lesson): `--resume` against a
 *   gone/corrupt/held session dies fast; three consecutive fast failures
 *   (< CODEV_LAUNCH_FAST_FAIL_SECS, default 15) fall back to a prompt-replay
 *   fresh launch under a new id — today's behavior, crash-protected forward.
 *   A slow failure resets the counter.
 * - Id minting at runtime uses uuidgen (lowercased) or /proc fallback; when
 *   neither exists the relaunch degrades to the UNPINNED fresh invocation —
 *   exactly the historical command — and crash restarts stay unpinned rather
 *   than resuming a stale id.
 *
 * `.builder-session-id` always holds the current id (removed while unpinned).
 * The bash script is the sole writer: after a re-mint it is the only party
 * that knows the current id, so Node- or DB-side copies would go stale
 * (consumption by recover/--resume is Issue #1112's scope).
 */
export function buildSessionLaunchLoop(opts: {
  /** Initial value of $codev_session_id: spawn-minted, or the discovered id on the recover path. */
  sessionId: string;
  /** Entry command override (recover path). Defaults to the pinned fresh invocation. */
  initial?: string;
  /** Fresh conversation pinned to $codev_session_id: role + pin + prompt. */
  pinnedFresh: string;
  /** The historical unpinned fresh invocation — degrade target when no uuid can be minted. */
  unpinnedFresh: string;
  /** Resume $codev_session_id with the crash-resume nudge. */
  resume: string;
}): string {
  const entry = opts.initial ?? opts.pinnedFresh;
  return `codev_session_id='${shellEscapeSingleQuote(opts.sessionId)}'
codev_fast_fail_secs="\${CODEV_LAUNCH_FAST_FAIL_SECS:-15}"
codev_mint_session_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  fi
}
codev_persist_session_id() {
  printf '%s\\n' "$codev_session_id" > '.builder-session-id'
}
codev_launch_entry() {
  ${entry}
}
codev_launch_pinned() {
  ${opts.pinnedFresh}
}
codev_launch_unpinned() {
  ${opts.unpinnedFresh}
}
codev_launch_resume() {
  ${opts.resume}
}
codev_relaunch_fresh() {
  codev_new_session_id="$(codev_mint_session_id)"
  if [ -n "$codev_new_session_id" ]; then
    codev_session_id="$codev_new_session_id"
    codev_persist_session_id
    codev_launch=codev_launch_pinned
  else
    codev_session_id=''
    rm -f '.builder-session-id'
    codev_launch=codev_launch_unpinned
  fi
}
codev_launch=codev_launch_entry
codev_fast_fails=0
codev_persist_session_id
while true; do
  codev_started=$SECONDS
  "$codev_launch"
  status=$?
  codev_elapsed=$(( SECONDS - codev_started ))
  if [ "$status" -eq 0 ]; then
    clear
    echo "Agent exited at your request. Press Enter to relaunch fresh, or close this terminal."
    read -r || exit 0
    codev_relaunch_fresh
    codev_fast_fails=0
    continue
  fi
  if [ "$codev_elapsed" -lt "$codev_fast_fail_secs" ]; then
    codev_fast_fails=$(( codev_fast_fails + 1 ))
  else
    codev_fast_fails=0
  fi
  echo ""
  if [ "$codev_fast_fails" -ge 3 ]; then
    echo "Agent failing immediately (code $status). Starting a fresh conversation with the original prompt in 2 seconds... (Ctrl+C to quit)"
    codev_relaunch_fresh
    codev_fast_fails=0
  elif [ "$codev_launch" = codev_launch_unpinned ]; then
    echo "Agent exited (code $status). Restarting in 2 seconds... (Ctrl+C to quit)"
  else
    echo "Agent exited (code $status). Resuming the conversation in 2 seconds... (Ctrl+C to quit)"
    codev_launch=codev_launch_resume
  fi
  sleep 2
done
`;
}

/**
 * Start a terminal session for a builder.
 *
 * When `resume` is provided, the launch script *enters* on the harness's resume
 * form (e.g. `claude --resume <uuid>`) via the pre-escaped `scriptFragment`
 * rather than a prompt+role invocation: the saved conversation already contains
 * the system prompt and role context. Only the Claude harness produces a resume
 * object (Issue #929); codex/gemini pass `undefined` here and enter fresh.
 *
 * Issue #1267: the script still *carries* the fresh invocation, because a clean
 * exit relaunches with it (see `buildLaunchLoop`). That is why role injection
 * and the harness worktree files are prepared on the resume path too — the
 * relaunch is a genuine fresh launch and needs everything one needs.
 * `.builder-prompt.txt` is the deliberate exception: it is read, never
 * rewritten, on resume (see below).
 */
export async function startBuilderSession(
  config: Config,
  builderId: string,
  worktreePath: string,
  baseCmd: string,
  prompt: string,
  roleContent: string | null,
  roleSource: string | null,
  resume?: { sessionId: string; scriptFragment: string },
): Promise<{ terminalId: string }> {
  logger.info('Creating terminal session...');

  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  const promptFile = resolve(worktreePath, '.builder-prompt.txt');

  // Write the initial prompt to a file the launch command reads back.
  //
  // Issue #1267: a resume must NOT rewrite it. `afx reset` reads the literal
  // `## Mode: STRICT|SOFT` heading out of this file as spawn-time ground truth
  // (reset/context.ts: modeFromBuilderPrompt) precisely *because* `--resume`
  // never regenerates it — `resolveMode` cannot recover a spawn-time `--soft`
  // from protocol defaults, so regenerating here would silently flip a soft
  // builder to strict. The fresh relaunch reads what the original spawn wrote,
  // which is also the more correct prompt: it is that builder's real mission.
  //
  // That the file exists on the resume path is an invariant of this function,
  // not an assumption about the worktree: every non-resume branch writes it, and
  // a resume is by definition a second launch into a worktree a prior one set
  // up. Worktree-mode spawns, which have no prompt file, are generated by
  // `buildWorktreeLaunchScript` and never reach here.
  if (!resume) writeFileSync(promptFile, prompt);

  const harness = getBuilderHarness(config.workspaceRoot);
  let envBlock = '';
  let roleFragment = '';

  if (roleContent) {
    // Write role to a file for harness-based injection
    const roleFile = resolve(worktreePath, '.builder-role.md');
    // Inject the actual dashboard port into the role prompt
    const roleWithPort = roleContent.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${roleSource})`);

    const { fragment, env } = harness.buildScriptRoleInjection(roleWithPort, roleFile);
    roleFragment = fragment;
    const envExports = Object.entries(env)
      .map(([k, v]) => `export ${k}='${shellEscapeSingleQuote(v)}'`)
      .join('\n');
    envBlock = envExports ? `${envExports}\n` : '';

    // Write any harness-specific worktree files (e.g., opencode.json for OpenCode,
    // the write-guard hook for Claude — Issue #1018)
    installHarnessWorktreeFiles(harness, roleWithPort, roleFile, worktreePath);
  } else {
    // Install harness worktree files even without a role, so the write-guard
    // (Issue #1018) is deterministic across all Claude spawn modes.
    installHarnessWorktreeFiles(harness, '', '', worktreePath);
  }

  // With a role, the fragment is appended even when empty (gemini injects via
  // env only, fragment '') — preserving the historical command text exactly,
  // double space included, so session-less scripts stay byte-identical.
  const withRole = roleContent ? `${baseCmd} ${roleFragment}` : baseCmd;
  const promptArg = `"$(cat '${promptFile}')"`;
  const freshCommand = `${withRole} ${promptArg}`;

  if (resume) {
    logger.info(`Resuming session ${resume.sessionId.slice(0, 8)}…`);
  }

  // Provider-owned launch shape (Issue #1201 — Kimi). Taken before the generic
  // loops because the reasons for it are exactly what those loops assume away:
  // a CLI with no positional prompt (the task is queued on the mailbox instead)
  // and no launch-time session id to pin (the crash path resumes by cwd). Role
  // injection, the prompt file, and the harness worktree files are all prepared
  // above on this path too — the provider gets the same inputs, and its script
  // decides the shape.
  if (harness.buildBuilderLaunchScript) {
    harness.prepareWorkspace?.(worktreePath);
    const scriptContent = harness.buildBuilderLaunchScript({
      worktreePath, baseCmd, roleFragment, taskFile: promptFile, builderId,
    });
    writeFileSync(scriptPath, scriptContent);
    chmodSync(scriptPath, '755');
    logger.info('Creating PTY terminal session...');
    const { terminalId } = await createPtySession(
      config, '/bin/bash', [scriptPath], worktreePath,
      { workspacePath: config.workspaceRoot, type: 'builder', roleId: builderId },
    );
    logger.info(`Terminal session created: ${terminalId}`);
    return { terminalId };
  }

  const sessionForms = scriptSessionForms(harness);
  let loop: string;
  if (sessionForms) {
    // Issue #1233: session-aware loop — crash restarts resume the conversation
    // instead of replaying the spawn prompt into a fresh (amnesiac) session.
    // Fresh spawns mint a new id here (never reuse a persisted one — #1224);
    // the recover path enters on the harness-discovered id.
    const sessionId = resume ? resume.sessionId : randomUUID();
    loop = buildSessionLaunchLoop({
      sessionId,
      initial: resume ? `${baseCmd} ${resume.scriptFragment}` : undefined,
      pinnedFresh: `${withRole} ${sessionForms.newSessionScriptFragment(SESSION_ID_EXPR)} ${promptArg}`,
      unpinnedFresh: freshCommand,
      resume: `${baseCmd} ${sessionForms.resumeScriptFragment(SESSION_ID_EXPR)} '${shellEscapeSingleQuote(CRASH_RESUME_NUDGE)}'`,
    });
  } else {
    // Session-less harness (codex/gemini/opencode/custom): historical loop,
    // byte for byte. Resume entry via the pre-escaped harness fragment.
    const initialCommand = resume ? `${baseCmd} ${resume.scriptFragment}` : freshCommand;
    loop = buildLaunchLoop(initialCommand, freshCommand);
  }

  const scriptContent = `#!/bin/bash
cd "${worktreePath}"
${envBlock}${loop}`;

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
  const harness = getBuilderHarness(workspaceRoot);
  let envBlock = '';
  let command = baseCmd;

  if (role) {
    const roleFile = resolve(worktreePath, '.builder-role.md');
    const roleWithPort = role.content.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${role.source})`);

    const { fragment, env } = harness.buildScriptRoleInjection(roleWithPort, roleFile);
    const envExports = Object.entries(env)
      .map(([k, v]) => `export ${k}='${shellEscapeSingleQuote(v)}'`)
      .join('\n');
    envBlock = envExports ? `${envExports}\n` : '';

    // Write any harness-specific worktree files (e.g., opencode.json for OpenCode,
    // the write-guard hook for Claude — Issue #1018)
    installHarnessWorktreeFiles(harness, roleWithPort, roleFile, worktreePath);

    command = `${baseCmd} ${fragment}`;
  } else {
    // Install harness worktree files even without a role, so the write-guard
    // (Issue #1018) is deterministic across all Claude spawn modes.
    installHarnessWorktreeFiles(harness, '', '', worktreePath);
  }

  // Provider-owned launch shape (Issue #1201 — Kimi). Worktree mode has no
  // initial task, so the provider gets `taskFile: null` and generates its plain
  // loop: nothing is queued on the mailbox, and the operator drives the session
  // by typing into it.
  if (harness.buildBuilderLaunchScript) {
    harness.prepareWorkspace?.(worktreePath);
    return harness.buildBuilderLaunchScript({
      worktreePath, baseCmd,
      roleFragment: role ? command.slice(baseCmd.length + 1) : '',
      taskFile: null,
    });
  }

  // Worktree mode never enters on a resume, but the loop itself is
  // session-aware when the harness supports it (Issue #1233): crash restarts
  // resume the pinned conversation here too. There is no prompt file in this
  // mode, so the fresh and degraded invocations are the bare command.
  const sessionForms = scriptSessionForms(harness);
  const loop = sessionForms
    ? buildSessionLaunchLoop({
      sessionId: randomUUID(),
      pinnedFresh: `${command} ${sessionForms.newSessionScriptFragment(SESSION_ID_EXPR)}`,
      unpinnedFresh: command,
      resume: `${baseCmd} ${sessionForms.resumeScriptFragment(SESSION_ID_EXPR)} '${shellEscapeSingleQuote(CRASH_RESUME_NUDGE)}'`,
    })
    : buildLaunchLoop(command, command);

  return `#!/bin/bash
cd "${worktreePath}"
${envBlock}${loop}`;
}
