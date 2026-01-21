/**
 * Kickoff command - Start a new protocol-driven project
 *
 * This command combines:
 * 1. Creating a git worktree
 * 2. Initializing porch state
 * 3. Starting the porch loop in the builder
 */

import { resolve, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { Builder, Config } from '../types.js';
import { getConfig, ensureDirectories, getResolvedCommands } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run, commandExists, findAvailablePort, spawnTtyd } from '../utils/shell.js';
import { loadState, upsertBuilder } from '../state.js';
import { loadRolePrompt } from '../utils/roles.js';

export interface KickoffOptions {
  project: string;
  title?: string;   // Project title (required if no spec/porch state exists)
  protocol?: string;
  noRole?: boolean;
  resume?: boolean; // Resume existing porch state
}

/**
 * Get project name from config
 */
function getProjectName(config: Config): string {
  return basename(config.projectRoot);
}

/**
 * Get tmux session name
 */
function getSessionName(config: Config, builderId: string): string {
  return `builder-${getProjectName(config)}-${builderId}`;
}

/**
 * Find an available port
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
 * Find spec file by project ID
 */
async function findSpecFile(codevDir: string, projectId: string): Promise<string | null> {
  const specsDir = resolve(codevDir, 'specs');

  if (!existsSync(specsDir)) {
    return null;
  }

  const files = await readdir(specsDir);

  for (const file of files) {
    if (file.startsWith(projectId) && file.endsWith('.md')) {
      return resolve(specsDir, file);
    }
  }

  for (const file of files) {
    if (file.startsWith(projectId + '-') && file.endsWith('.md')) {
      return resolve(specsDir, file);
    }
  }

  return null;
}

/**
 * Find porch state for a project
 */
interface PorchState {
  id: string;
  title: string;
  protocol: string;
  state: string;
  statusPath: string;
}

async function findPorchState(codevDir: string, projectId: string): Promise<PorchState | null> {
  const projectsDir = resolve(codevDir, 'projects');

  if (!existsSync(projectsDir)) {
    return null;
  }

  const dirs = await readdir(projectsDir);

  for (const dir of dirs) {
    if (dir.startsWith(`${projectId}-`)) {
      const statusPath = resolve(projectsDir, dir, 'status.yaml');
      if (existsSync(statusPath)) {
        const content = readFileSync(statusPath, 'utf-8');
        // Simple YAML parsing for the fields we need
        const idMatch = content.match(/^id:\s*"?([^"\n]+)"?/m);
        const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?/m);
        const protocolMatch = content.match(/^protocol:\s*"?([^"\n]+)"?/m);
        const stateMatch = content.match(/^state:\s*"?([^"\n]+)"?/m);

        if (idMatch && titleMatch) {
          return {
            id: idMatch[1],
            title: titleMatch[1],
            protocol: protocolMatch?.[1] || 'spider',
            state: stateMatch?.[1] || 'unknown',
            statusPath,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Create git branch and worktree
 */
async function createWorktree(config: Config, branchName: string, worktreePath: string): Promise<void> {
  logger.info('Creating branch...');
  try {
    await run(`git branch ${branchName}`, { cwd: config.projectRoot });
  } catch {
    logger.debug('Branch may already exist');
  }

  logger.info('Creating worktree...');
  try {
    await run(`git worktree add "${worktreePath}" ${branchName}`, { cwd: config.projectRoot });
  } catch (error) {
    fatal(`Failed to create worktree: ${error}`);
  }

  // Symlink .env
  const rootEnvPath = resolve(config.projectRoot, '.env');
  const worktreeEnvPath = resolve(worktreePath, '.env');
  if (existsSync(rootEnvPath) && !existsSync(worktreeEnvPath)) {
    try {
      symlinkSync(rootEnvPath, worktreeEnvPath);
      logger.info('Linked .env from project root');
    } catch {
      logger.debug('Failed to symlink .env');
    }
  }

}

/**
 * Check dependencies
 */
async function checkDependencies(): Promise<void> {
  if (!(await commandExists('git'))) {
    fatal('git not found');
  }

  if (!(await commandExists('ttyd'))) {
    fatal('ttyd not found. Install with: brew install ttyd');
  }

  if (!(await commandExists('porch'))) {
    logger.warn('porch command not found in PATH. Falling back to codev porch.');
  }
}

/**
 * Get porch command
 * When running from the codev source repo, use the local build for latest fixes
 */
async function getPorchCommand(config: Config): Promise<string> {
  // Check if we're in the codev source repo - use local build
  const localPorch = resolve(config.projectRoot, 'packages/codev/bin/porch.js');
  if (existsSync(localPorch)) {
    return `node "${localPorch}"`;
  }

  if (await commandExists('porch')) {
    return 'porch';
  }
  return 'codev porch';
}

/**
 * Kickoff a new protocol-driven project
 */
export async function kickoff(options: KickoffOptions): Promise<void> {
  const { project: projectId, title, protocol: protocolName = 'spider', noRole, resume } = options;

  const config = getConfig();

  // Find spec file OR porch state
  const specFile = await findSpecFile(config.codevDir, projectId);
  let porchState = await findPorchState(config.codevDir, projectId);

  // Need either a spec, porch state, or title to proceed
  if (!specFile && !porchState && !title) {
    fatal(`No spec or porch state found for project: ${projectId}\n` +
          `Either:\n` +
          `  1. Create a spec file (codev/specs/${projectId}-*.md)\n` +
          `  2. Provide a title: af kickoff -p ${projectId} --title "feature-name"\n` +
          `  3. Initialize porch manually: porch init ${protocolName} ${projectId} <project-name>`);
  }

  // If we have a title but no porch state, we'll initialize porch before creating worktree
  const needsInitialization = !specFile && !porchState && title;

  // Derive the project title from spec, porch state, or provided title
  const projectTitle = specFile
    ? basename(specFile, '.md').replace(/^\d+-/, '') // Strip leading number from spec filename
    : porchState?.title || title!;

  // Derive names from spec or porch state or title
  const specName = specFile ? basename(specFile, '.md') : `${projectId}-${projectTitle}`;
  const builderId = projectId;
  const safeName = projectTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const actualProtocol = porchState?.protocol || protocolName;

  // Use worktrees/ directory with protocol-prefixed naming per spec 0073
  const worktreesDir = resolve(config.projectRoot, 'worktrees');
  const worktreeName = `${actualProtocol.toLowerCase()}_${projectId}_${safeName}`;
  const branchName = `builder/${projectId}-${safeName}`;
  const worktreePath = resolve(worktreesDir, worktreeName);

  // Check for plan file (only if spec exists)
  const planFile = specFile ? resolve(config.codevDir, 'plans', `${basename(specFile, '.md')}.md`) : null;
  const hasPlan = planFile ? existsSync(planFile) : false;

  // Check if porch state already exists
  const hasExistingState = !!porchState;

  logger.header(`Kickoff Builder ${builderId}`);
  logger.kv('Spec', specFile || '(to be created)');
  logger.kv('Protocol', (porchState?.protocol || protocolName).toUpperCase());
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);
  logger.kv('Porch State', hasExistingState ? 'exists (resume)' : 'new');

  await ensureDirectories(config);
  await checkDependencies();

  // Ensure worktrees directory exists
  if (!existsSync(worktreesDir)) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(worktreesDir, { recursive: true });
  }

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    if (resume) {
      logger.info('Resuming existing worktree');
    } else {
      fatal(`Worktree already exists at ${worktreePath}\nUse --resume to continue, or run: af cleanup --project ${projectId}`);
    }
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  const porchCmd = await getPorchCommand(config);

  // Initialize porch state if not resuming existing
  // IMPORTANT: Run from worktree so state is created there, not in main project
  if (!hasExistingState && !resume) {
    logger.info('Initializing porch state...');
    try {
      await run(`${porchCmd} init ${protocolName} ${projectId} "${safeName}"`, {
        cwd: worktreePath,
      });
      logger.success('Porch state initialized');
    } catch (error) {
      logger.warn(`Failed to initialize porch state: ${error}`);
      logger.info('Builder will start without porch orchestration');
    }
  }

  // Build the prompt
  const specRelPath = specFile ? `codev/specs/${basename(specFile)}` : `codev/specs/${projectId}-${safeName}.md`;
  const planRelPath = `codev/plans/${projectId}-${safeName}.md`;
  const protocolPath = `codev/protocols/${actualProtocol.toLowerCase()}/protocol.md`;

  let initialPrompt = `## Protocol
Follow the ${actualProtocol.toUpperCase()} protocol STRICTLY: ${protocolPath}
Read and internalize the protocol before starting any work.

## Porch Orchestration
This builder is orchestrated by Porch. Check your current state with:
  porch status ${projectId}

Current porch state: ${porchState?.state || 'initializing'}

## Task`;

  if (specFile) {
    initialPrompt += `
Implement the feature specified in ${specRelPath}.`;
    if (hasPlan) {
      initialPrompt += ` Follow the implementation plan in ${planRelPath}.`;
    }
    initialPrompt += `

Start by reading the protocol, spec${hasPlan ? ', and plan' : ''}, then begin implementation.`;
  } else {
    // No spec yet - builder starts from specify phase
    initialPrompt += `
Project: ${porchState?.title || safeName}

You are starting from the SPECIFY phase. Your first task is to:
1. Read the protocol (${protocolPath})
2. Understand what "${porchState?.title || safeName}" means
3. Create the specification file at ${specRelPath}

The porch orchestrator will guide you through each phase. Follow the signals it expects.`;
  }

  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.

${initialPrompt}`;

  // Load role
  const role = noRole ? null : loadRolePrompt(config, 'builder');
  const commands = getResolvedCommands();

  // Start builder session
  const port = await findFreePort(config);
  const sessionName = getSessionName(config, builderId);

  logger.info('Creating tmux session...');

  // Write prompt and role files
  const promptFile = resolve(worktreePath, '.builder-prompt.txt');
  writeFileSync(promptFile, builderPrompt);

  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  let scriptContent: string;

  // Builder startup script runs porch, which orchestrates Claude sessions
  // The role file is written for reference but porch handles the actual invocations
  if (role) {
    const roleFile = resolve(worktreePath, '.builder-role.md');
    const roleWithPort = role.content.replace(/\{PORT\}/g, String(config.dashboardPort));
    writeFileSync(roleFile, roleWithPort);
    logger.info(`Loaded role (${role.source})`);
  }

  // Run porch as the main orchestrator
  // Porch will invoke Claude for each phase with appropriate context
  // Don't use exec so the session stays alive if porch exits
  scriptContent = `#!/bin/zsh
cd "${worktreePath}"
echo "Starting porch orchestrator for project ${projectId}..."
echo "Protocol: ${protocolName.toUpperCase()}"
echo ""
${porchCmd} run ${projectId}
EXIT_CODE=$?
echo ""
echo "═══════════════════════════════════════════════════"
echo "Porch exited with code $EXIT_CODE"
echo "To restart: ${porchCmd} run ${projectId}"
echo "To exit: type 'exit'"
echo "═══════════════════════════════════════════════════"
exec zsh
`;

  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, '755');

  // Create tmux session
  await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${scriptPath}"`);
  await run(`tmux set-option -t "${sessionName}" status off`);
  await run('tmux set -g mouse on');
  await run('tmux set -g set-clipboard on');
  await run('tmux set -g allow-passthrough on');

  // Start ttyd
  logger.info('Starting builder terminal...');
  const customIndexPath = resolve(config.templatesDir, 'ttyd-index.html');
  const hasCustomIndex = existsSync(customIndexPath);

  const ttydProcess = spawnTtyd({
    port,
    sessionName,
    cwd: worktreePath,
    customIndexPath: hasCustomIndex ? customIndexPath : undefined,
  });

  if (!ttydProcess?.pid) {
    fatal('Failed to start ttyd process');
  }

  const builder: Builder = {
    id: builderId,
    name: specName,
    port,
    pid: ttydProcess.pid,
    status: 'spawning',
    phase: 'init',
    worktree: worktreePath,
    branch: branchName,
    tmuxSession: sessionName,
    type: 'spec',
  };

  upsertBuilder(builder);

  logger.blank();
  logger.success(`Builder ${builderId} kicked off!`);
  logger.kv('Terminal', `http://localhost:${port}`);
  logger.kv('Porch Status', `porch status ${projectId}`);
  logger.kv('Porch Run', `porch run ${projectId}`);
}
