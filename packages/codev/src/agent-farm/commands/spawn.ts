/**
 * Spawn command - creates a new builder in various modes
 *
 * Modes:
 * - spec:     --project/-p  Spawn for a spec file (existing behavior)
 * - task:     --task        Spawn with an ad-hoc task description
 * - protocol: --protocol    Spawn to run a protocol (cleanup, experiment, etc.)
 * - shell:    --shell       Bare Claude session (no prompt, no worktree)
 */

import { resolve, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, symlinkSync, mkdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { SpawnOptions, Builder, Config, BuilderType } from '../types.js';
import { getConfig, ensureDirectories, getResolvedCommands } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run, commandExists, findAvailablePort, spawnTtyd } from '../utils/shell.js';
import { loadState, upsertBuilder } from '../state.js';
import { loadRolePrompt } from '../utils/roles.js';

/**
 * Generate a short 4-character base64-encoded ID
 * Uses URL-safe base64 (a-z, A-Z, 0-9, -, _) for filesystem-safe IDs
 */
/**
 * Get the project name from config (basename of projectRoot)
 * Used to namespace tmux sessions and prevent cross-project collisions
 */
function getProjectName(config: Config): string {
  return basename(config.projectRoot);
}

/**
 * Get a namespaced tmux session name: builder-{project}-{id}
 */
function getSessionName(config: Config, builderId: string): string {
  return `builder-${getProjectName(config)}-${builderId}`;
}

function generateShortId(): string {
  // Generate random 24-bit number and base64 encode to 4 chars
  const num = Math.floor(Math.random() * 0xFFFFFF);
  const bytes = new Uint8Array([num >> 16, (num >> 8) & 0xFF, num & 0xFF]);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 4);
}

/**
 * Validate spawn options - ensure exactly one mode is selected
 */
function validateSpawnOptions(options: SpawnOptions): void {
  const modes = [
    options.project,
    options.task,
    options.protocol,
    options.shell,
    options.worktree,
    options.issue,
  ].filter(Boolean);

  if (modes.length === 0) {
    fatal('Must specify one of: --project (-p), --issue (-i), --task, --protocol, --shell, --worktree\n\nRun "af spawn --help" for examples.');
  }

  if (modes.length > 1) {
    fatal('Flags --project, --issue, --task, --protocol, --shell, --worktree are mutually exclusive');
  }

  if (options.files && !options.task) {
    fatal('--files requires --task');
  }

  if ((options.noComment || options.force) && !options.issue) {
    fatal('--no-comment and --force require --issue');
  }
}

/**
 * Determine the spawn mode from options
 */
function getSpawnMode(options: SpawnOptions): BuilderType {
  if (options.project) return 'spec';
  if (options.issue) return 'bugfix';
  if (options.task) return 'task';
  if (options.protocol) return 'protocol';
  if (options.shell) return 'shell';
  if (options.worktree) return 'worktree';
  throw new Error('No mode specified');
}

// loadRolePrompt imported from ../utils/roles.js

/**
 * Load a protocol-specific role if it exists
 */
function loadProtocolRole(config: Config, protocolName: string): { content: string; source: string } | null {
  const protocolRolePath = resolve(config.codevDir, 'protocols', protocolName, 'role.md');
  if (existsSync(protocolRolePath)) {
    return { content: readFileSync(protocolRolePath, 'utf-8'), source: 'protocol' };
  }
  // Fall back to builder role
  return loadRolePrompt(config, 'builder');
}

/**
 * Find a spec file by project ID
 */
async function findSpecFile(codevDir: string, projectId: string): Promise<string | null> {
  const specsDir = resolve(codevDir, 'specs');

  if (!existsSync(specsDir)) {
    return null;
  }

  const files = await readdir(specsDir);

  // Try exact match first (e.g., "0001-feature.md")
  for (const file of files) {
    if (file.startsWith(projectId) && file.endsWith('.md')) {
      return resolve(specsDir, file);
    }
  }

  // Try partial match (e.g., just "0001")
  for (const file of files) {
    if (file.startsWith(projectId + '-') && file.endsWith('.md')) {
      return resolve(specsDir, file);
    }
  }

  return null;
}

/**
 * Validate that a protocol exists
 */
function validateProtocol(config: Config, protocolName: string): void {
  const protocolDir = resolve(config.codevDir, 'protocols', protocolName);
  const protocolFile = resolve(protocolDir, 'protocol.md');

  if (!existsSync(protocolDir)) {
    // List available protocols
    const protocolsDir = resolve(config.codevDir, 'protocols');
    let available = '';
    if (existsSync(protocolsDir)) {
      const dirs = readdirSync(protocolsDir, { withFileTypes: true })
        .filter((d: Dirent) => d.isDirectory())
        .map((d: Dirent) => d.name);
      if (dirs.length > 0) {
        available = `\n\nAvailable protocols: ${dirs.join(', ')}`;
      }
    }
    fatal(`Protocol not found: ${protocolName}${available}`);
  }

  if (!existsSync(protocolFile)) {
    fatal(`Protocol ${protocolName} exists but has no protocol.md file`);
  }
}

/**
 * Check for required dependencies
 */
async function checkDependencies(): Promise<void> {
  if (!(await commandExists('git'))) {
    fatal('git not found');
  }

  if (!(await commandExists('ttyd'))) {
    fatal('ttyd not found. Install with: brew install ttyd');
  }
}

/**
 * Find an available port, avoiding ports already in use by other builders
 */
async function findFreePort(config: Config): Promise<number> {
  const state = loadState();
  const usedPorts = new Set<number>();
  for (const b of state.builders || []) {
    if (b.port) usedPorts.add(b.port);
  }
  let port = config.builderPortRange[0];
  while (usedPorts.has(port)) {
    port++;
  }
  return findAvailablePort(port);
}

/**
 * Create git branch and worktree
 */
async function createWorktree(config: Config, branchName: string, worktreePath: string): Promise<void> {
  logger.info('Creating branch...');
  try {
    await run(`git branch ${branchName}`, { cwd: config.projectRoot });
  } catch (error) {
    // Branch might already exist, that's OK
    logger.debug(`Branch creation: ${error}`);
  }

  logger.info('Creating worktree...');
  try {
    await run(`git worktree add "${worktreePath}" ${branchName}`, { cwd: config.projectRoot });
  } catch (error) {
    fatal(`Failed to create worktree: ${error}`);
  }

  // Symlink .env from project root into worktree (if it exists)
  const rootEnvPath = resolve(config.projectRoot, '.env');
  const worktreeEnvPath = resolve(worktreePath, '.env');
  if (existsSync(rootEnvPath) && !existsSync(worktreeEnvPath)) {
    try {
      symlinkSync(rootEnvPath, worktreeEnvPath);
      logger.info('Linked .env from project root');
    } catch (error) {
      logger.debug(`Failed to symlink .env: ${error}`);
    }
  }
}

/**
 * Start tmux session and ttyd for a builder
 */
async function startBuilderSession(
  config: Config,
  builderId: string,
  worktreePath: string,
  baseCmd: string,
  prompt: string,
  roleContent: string | null,
  roleSource: string | null,
): Promise<{ port: number; pid: number; sessionName: string }> {
  const port = await findFreePort(config);
  const sessionName = getSessionName(config, builderId);

  logger.info('Creating tmux session...');

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
    const roleWithPort = roleContent.replace(/\{PORT\}/g, String(config.dashboardPort));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${roleSource})`);
    scriptContent = `#!/bin/bash
exec ${baseCmd} --append-system-prompt "$(cat '${roleFile}')" "$(cat '${promptFile}')"
`;
  } else {
    scriptContent = `#!/bin/bash
exec ${baseCmd} "$(cat '${promptFile}')"
`;
  }

  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, '755');

  // Create tmux session running the script
  await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${scriptPath}"`);
  await run(`tmux set-option -t "${sessionName}" status off`);

  // Enable mouse scrolling in tmux
  await run('tmux set -g mouse on');
  await run('tmux set -g set-clipboard on');
  await run('tmux set -g allow-passthrough on');

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run('tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');
  await run('tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');

  // Start ttyd connecting to the tmux session
  logger.info('Starting builder terminal...');
  const customIndexPath = resolve(config.templatesDir, 'ttyd-index.html');
  const hasCustomIndex = existsSync(customIndexPath);
  if (hasCustomIndex) {
    logger.info('Using custom terminal with file click support');
  }

  const ttydProcess = spawnTtyd({
    port,
    sessionName,
    cwd: worktreePath,
    customIndexPath: hasCustomIndex ? customIndexPath : undefined,
  });

  if (!ttydProcess?.pid) {
    fatal('Failed to start ttyd process for builder');
  }

  return { port, pid: ttydProcess.pid, sessionName };
}

/**
 * Start a shell session (no worktree, just tmux + ttyd)
 */
async function startShellSession(
  config: Config,
  shellId: string,
  baseCmd: string,
): Promise<{ port: number; pid: number; sessionName: string }> {
  const port = await findFreePort(config);
  const sessionName = `shell-${shellId}`;

  logger.info('Creating tmux session...');

  // Shell mode: just launch Claude with no prompt
  await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${config.projectRoot}" "${baseCmd}"`);
  await run(`tmux set-option -t "${sessionName}" status off`);

  // Enable mouse scrolling in tmux
  await run('tmux set -g mouse on');
  await run('tmux set -g set-clipboard on');
  await run('tmux set -g allow-passthrough on');

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run('tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');
  await run('tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');

  // Start ttyd connecting to the tmux session
  logger.info('Starting shell terminal...');
  const customIndexPath = resolve(config.templatesDir, 'ttyd-index.html');
  const hasCustomIndex = existsSync(customIndexPath);

  const ttydProcess = spawnTtyd({
    port,
    sessionName,
    cwd: config.projectRoot,
    customIndexPath: hasCustomIndex ? customIndexPath : undefined,
  });

  if (!ttydProcess?.pid) {
    fatal('Failed to start ttyd process for shell');
  }

  return { port, pid: ttydProcess.pid, sessionName };
}

// =============================================================================
// Mode-specific spawn implementations
// =============================================================================

/**
 * Spawn builder for a spec (existing behavior)
 */
async function spawnSpec(options: SpawnOptions, config: Config): Promise<void> {
  const projectId = options.project!;
  const specFile = await findSpecFile(config.codevDir, projectId);
  if (!specFile) {
    fatal(`Spec not found for project: ${projectId}`);
  }

  const specName = basename(specFile, '.md');
  const builderId = projectId;
  const safeName = specName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const branchName = `builder/${safeName}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  // Check for corresponding plan file
  const planFile = resolve(config.codevDir, 'plans', `${specName}.md`);
  const hasPlan = existsSync(planFile);

  logger.header(`Spawning Builder ${builderId} (spec)`);
  logger.kv('Spec', specFile);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Parse protocol from spec file metadata
  const specContent = readFileSync(specFile, 'utf-8');
  const protocolMatch = specContent.match(/\*\*Protocol\*\*:\s*(\w+)/i);
  const protocol = protocolMatch ? protocolMatch[1].toUpperCase() : 'SPIDER';
  const protocolPath = `codev/protocols/${protocol.toLowerCase()}/protocol.md`;

  // Build the prompt
  const specRelPath = `codev/specs/${specName}.md`;
  const planRelPath = `codev/plans/${specName}.md`;

  let initialPrompt = `## Protocol
Follow the ${protocol} protocol STRICTLY: ${protocolPath}
Read and internalize the protocol before starting any work.

## Task
Implement the feature specified in ${specRelPath}.`;
  if (hasPlan) {
    initialPrompt += ` Follow the implementation plan in ${planRelPath}.`;
  }
  initialPrompt += `

Start by reading the protocol, spec${hasPlan ? ', and plan' : ''}, then begin implementation.`;

  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.

${initialPrompt}`;

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startBuilderSession(
    config,
    builderId,
    worktreePath,
    commands.builder,
    builderPrompt,
    role?.content ?? null,
    role?.source ?? null,
  );

  const builder: Builder = {
    id: builderId,
    name: specName,
    port,
    pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'spec',
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
}

/**
 * Spawn builder for an ad-hoc task
 */
async function spawnTask(options: SpawnOptions, config: Config): Promise<void> {
  const taskText = options.task!;
  const shortId = generateShortId();
  const builderId = `task-${shortId}`;
  const branchName = `builder/task-${shortId}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.header(`Spawning Builder ${builderId} (task)`);
  logger.kv('Task', taskText.substring(0, 60) + (taskText.length > 60 ? '...' : ''));
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  if (options.files && options.files.length > 0) {
    logger.kv('Files', options.files.join(', '));
  }

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Build the prompt
  let prompt = taskText;
  if (options.files && options.files.length > 0) {
    prompt += `\n\nRelevant files to consider:\n${options.files.map(f => `- ${f}`).join('\n')}`;
  }

  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition. ${prompt}`;

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startBuilderSession(
    config,
    builderId,
    worktreePath,
    commands.builder,
    builderPrompt,
    role?.content ?? null,
    role?.source ?? null,
  );

  const builder: Builder = {
    id: builderId,
    name: `Task: ${taskText.substring(0, 30)}${taskText.length > 30 ? '...' : ''}`,
    port,
    pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'task',
    taskText,
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
}

/**
 * Spawn builder to run a protocol
 */
async function spawnProtocol(options: SpawnOptions, config: Config): Promise<void> {
  const protocolName = options.protocol!;
  validateProtocol(config, protocolName);

  const shortId = generateShortId();
  const builderId = `${protocolName}-${shortId}`;
  const branchName = `builder/${protocolName}-${shortId}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.header(`Spawning Builder ${builderId} (protocol)`);
  logger.kv('Protocol', protocolName);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Build the prompt
  const prompt = `You are running the ${protocolName} protocol. Start by reading codev/protocols/${protocolName}/protocol.md and follow its instructions.`;

  // Load protocol-specific role or fall back to builder role
  const role = options.noRole ? null : loadProtocolRole(config, protocolName);
  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startBuilderSession(
    config,
    builderId,
    worktreePath,
    commands.builder,
    prompt,
    role?.content ?? null,
    role?.source ?? null,
  );

  const builder: Builder = {
    id: builderId,
    name: `Protocol: ${protocolName}`,
    port,
    pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'protocol',
    protocolName,
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Builder ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
}

/**
 * Spawn a bare shell session (no worktree, no prompt)
 */
async function spawnShell(options: SpawnOptions, config: Config): Promise<void> {
  const shortId = generateShortId();
  const shellId = `shell-${shortId}`;

  logger.header(`Spawning Shell ${shellId}`);

  await ensureDirectories(config);
  await checkDependencies();

  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startShellSession(
    config,
    shortId,
    commands.builder,
  );

  // Shell sessions are tracked as builders with type 'shell'
  // They don't have worktrees or branches
  const builder: Builder = {
    id: shellId,
    name: 'Shell session',
    port,
    pid,
    status: 'spawning',
    phase: 'interactive',
    worktree: '',
    branch: '',
    tmuxSession: sessionName,
    type: 'shell',
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Shell ${shellId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
}

/**
 * Spawn a worktree session (has worktree/branch, but no initial prompt)
 * Use case: Small features without spec/plan, like quick fixes
 */
async function spawnWorktree(options: SpawnOptions, config: Config): Promise<void> {
  const shortId = generateShortId();
  const builderId = `worktree-${shortId}`;
  const branchName = `builder/worktree-${shortId}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.header(`Spawning Worktree ${builderId}`);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Load builder role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  // Worktree mode: launch Claude with no prompt, but in the worktree directory
  const port = await findFreePort(config);
  const sessionName = getSessionName(config, builderId);

  logger.info('Creating tmux session...');

  // Build launch script (with role if provided) to avoid shell escaping issues
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  let scriptContent: string;

  if (role) {
    const roleFile = resolve(worktreePath, '.builder-role.md');
    // Inject the actual dashboard port into the role prompt
    const roleWithPort = role.content.replace(/\{PORT\}/g, String(config.dashboardPort));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${role.source})`);
    scriptContent = `#!/bin/bash
exec ${commands.builder} --append-system-prompt "$(cat '${roleFile}')"
`;
  } else {
    scriptContent = `#!/bin/bash
exec ${commands.builder}
`;
  }

  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  // Create tmux session running the launch script
  await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${scriptPath}"`);
  await run(`tmux set-option -t "${sessionName}" status off`);

  // Enable mouse scrolling in tmux
  await run('tmux set -g mouse on');
  await run('tmux set -g set-clipboard on');
  await run('tmux set -g allow-passthrough on');

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run('tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');
  await run('tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"');

  // Start ttyd connecting to the tmux session
  logger.info('Starting worktree terminal...');
  const customIndexPath = resolve(config.codevDir, 'templates', 'ttyd-index.html');
  const hasCustomIndex = existsSync(customIndexPath);
  if (hasCustomIndex) {
    logger.info('Using custom terminal with file click support');
  }

  const ttydProcess = spawnTtyd({
    port,
    sessionName,
    cwd: worktreePath,
    customIndexPath: hasCustomIndex ? customIndexPath : undefined,
  });

  if (!ttydProcess?.pid) {
    fatal('Failed to start ttyd process for worktree');
  }

  const builder: Builder = {
    id: builderId,
    name: 'Worktree session',
    port,
    pid: ttydProcess.pid,
    status: 'spawning',
    phase: 'interactive',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'worktree',
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Worktree ${builderId} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
}

/**
 * Generate a slug from an issue title (max 30 chars, lowercase, alphanumeric + hyphens)
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .replace(/^-|-$/g, '')        // Trim leading/trailing hyphens
    .slice(0, 30);                // Max 30 chars
}

/**
 * GitHub issue structure from gh issue view --json
 */
interface GitHubIssue {
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
 * Fetch a GitHub issue via gh CLI
 */
async function fetchGitHubIssue(issueNumber: number): Promise<GitHubIssue> {
  try {
    const result = await run(`gh issue view ${issueNumber} --json title,body,state,comments`);
    return JSON.parse(result.stdout);
  } catch (error) {
    fatal(`Failed to fetch issue #${issueNumber}. Ensure 'gh' CLI is installed and authenticated.`);
    throw error; // TypeScript doesn't know fatal() never returns
  }
}

/**
 * Check for collision conditions before spawning bugfix
 */
async function checkBugfixCollisions(
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

/**
 * Spawn builder for a GitHub issue (bugfix mode)
 */
async function spawnBugfix(options: SpawnOptions, config: Config): Promise<void> {
  const issueNumber = options.issue!;

  logger.header(`Spawning Bugfix Builder for Issue #${issueNumber}`);

  // Fetch issue from GitHub
  logger.info('Fetching issue from GitHub...');
  const issue = await fetchGitHubIssue(issueNumber);

  const slug = slugify(issue.title);
  const builderId = `bugfix-${issueNumber}`;
  const branchName = `builder/bugfix-${issueNumber}-${slug}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.kv('Title', issue.title);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  // Check for collisions
  await checkBugfixCollisions(issueNumber, worktreePath, issue, !!options.force);

  await ensureDirectories(config);
  await checkDependencies();
  await createWorktree(config, branchName, worktreePath);

  // Comment on the issue (unless --no-comment)
  if (!options.noComment) {
    logger.info('Commenting on issue...');
    try {
      await run(`gh issue comment ${issueNumber} --body "On it! Working on a fix now."`);
    } catch {
      logger.warn('Warning: Failed to comment on issue (continuing anyway)');
    }
  }

  // Build the prompt with issue context
  const prompt = `You are a Builder working on a BUGFIX task.

## Protocol
Follow the BUGFIX protocol: codev/protocols/bugfix/protocol.md

## Issue #${issueNumber}
**Title**: ${issue.title}

**Description**:
${issue.body || '(No description provided)'}

## Your Mission
1. Reproduce the bug
2. Identify root cause
3. Implement fix (< 300 LOC)
4. Add regression test
5. Run CMAP review (3-way parallel: Gemini, Codex, Claude)
6. Create PR with "Fixes #${issueNumber}" in body

If the fix is too complex (> 300 LOC or architectural changes), notify the Architect via:
  af send architect "Issue #${issueNumber} is more complex than expected. [Reason]. Recommend escalating to SPIDER/TICK."

Start by reading the issue and reproducing the bug.`;

  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n\n${prompt}`;

  // Load role
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  const { port, pid, sessionName } = await startBuilderSession(
    config,
    builderId,
    worktreePath,
    commands.builder,
    builderPrompt,
    role?.content ?? null,
    role?.source ?? null,
  );

  const builder: Builder = {
    id: builderId,
    name: `Bugfix #${issueNumber}: ${issue.title.substring(0, 40)}${issue.title.length > 40 ? '...' : ''}`,
    port,
    pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'bugfix',
    issueNumber,
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Bugfix builder for issue #${issueNumber} spawned!`);
  logger.kv('Terminal', `http://localhost:${port}`);
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Spawn a new builder
 */
export async function spawn(options: SpawnOptions): Promise<void> {
  validateSpawnOptions(options);

  const config = getConfig();

  // Prune stale worktrees before spawning to prevent "can't find session" errors
  // This catches orphaned worktrees from crashes, manual kills, or incomplete cleanups
  try {
    await run('git worktree prune', { cwd: config.projectRoot });
  } catch {
    // Non-fatal - continue with spawn even if prune fails
  }

  const mode = getSpawnMode(options);

  switch (mode) {
    case 'spec':
      await spawnSpec(options, config);
      break;
    case 'bugfix':
      await spawnBugfix(options, config);
      break;
    case 'task':
      await spawnTask(options, config);
      break;
    case 'protocol':
      await spawnProtocol(options, config);
      break;
    case 'shell':
      await spawnShell(options, config);
      break;
    case 'worktree':
      await spawnWorktree(options, config);
      break;
  }
}
