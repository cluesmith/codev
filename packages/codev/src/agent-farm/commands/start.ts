/**
 * Start command - launches the architect dashboard
 */

import { resolve, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { StartOptions, ArchitectState } from '../types.js';
import { version as localVersion } from '../../version.js';
import { getConfig, ensureDirectories } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { spawnDetached, commandExists, findAvailablePort, openBrowser, run, isProcessRunning } from '../utils/shell.js';
import { checkCoreDependencies } from '../utils/deps.js';
import { loadState, setArchitect } from '../state.js';
import { handleOrphanedSessions, warnAboutStaleArtifacts } from '../utils/orphan-handler.js';
import { getPortBlock, cleanupStaleEntries } from '../utils/port-registry.js';
import { loadRolePrompt } from '../utils/roles.js';
import { initHQConnector, isHQEnabled } from '../hq-connector.js';

/**
 * Parsed remote target
 */
interface ParsedRemote {
  user: string;
  host: string;
  remotePath?: string;
}

/**
 * Check if a local port is available by attempting to bind to it.
 * More reliable than fetch() which may miss some port conflicts.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Parse remote target string: user@host or user@host:/path
 */
export function parseRemote(remote: string): ParsedRemote {
  // Match: user@host or user@host:/path
  const match = remote.match(/^([^@]+)@([^:]+)(?::(.+))?$/);
  if (!match) {
    throw new Error(`Invalid remote format: ${remote}. Use user@host or user@host:/path`);
  }
  // Strip trailing slash to avoid duplicate port allocations (e.g., /path/ vs /path)
  const remotePath = match[3]?.replace(/\/$/, '');
  return { user: match[1], host: match[2], remotePath };
}

// loadRolePrompt imported from ../utils/roles.js

/**
 * Check if passwordless SSH is configured for a host
 * Returns true if SSH works without password, false otherwise
 */
async function checkPasswordlessSSH(user: string, host: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ssh = spawn('ssh', [
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',  // Fail immediately if password required
      '-o', 'StrictHostKeyChecking=accept-new',
      `${user}@${host}`,
      'true',  // Just run 'true' to test connection
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    ssh.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ssh.on('error', (err) => resolve({ ok: false, error: err.message }));
    ssh.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
      }
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      ssh.kill();
      resolve({ ok: false, error: 'connection timeout' });
    }, 15000);
  });
}

/**
 * Check remote CLI versions and warn about mismatches
 */
async function checkRemoteVersions(user: string, host: string): Promise<void> {
  const commands = ['codev', 'af', 'consult', 'generate-image'];
  const versionCmd = commands.map(cmd => `${cmd} --version 2>/dev/null || echo "${cmd}: not found"`).join(' && echo "---" && ');
  // Wrap in bash -l to source login environment (gets PATH from .profile)
  const wrappedCmd = `bash -l -c '${versionCmd.replace(/'/g, "'\\''")}'`;

  return new Promise((resolve) => {
    const ssh = spawn('ssh', [
      '-o', 'ConnectTimeout=5',
      '-o', 'BatchMode=yes',
      `${user}@${host}`,
      wrappedCmd,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    ssh.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    ssh.on('error', () => {
      // SSH failed, skip version check
      resolve();
    });

    ssh.on('exit', (code) => {
      if (code !== 0) {
        // SSH failed or commands failed, skip version check
        resolve();
        return;
      }

      // Parse output: each command's version separated by "---"
      const outputs = stdout.split('---').map(s => s.trim());
      const mismatches: string[] = [];

      for (let i = 0; i < commands.length && i < outputs.length; i++) {
        const output = outputs[i];
        const cmd = commands[i];

        if (output.includes('not found')) {
          mismatches.push(`${cmd}: not installed on remote`);
        } else {
          // Extract version number (e.g., "1.5.3" from "@cluesmith/codev@1.5.3" or "1.5.3")
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          if (versionMatch) {
            const remoteVer = versionMatch[1];
            if (remoteVer !== localVersion) {
              mismatches.push(`${cmd}: local ${localVersion}, remote ${remoteVer}`);
            }
          }
        }
      }

      if (mismatches.length > 0) {
        logger.blank();
        logger.warn('Version mismatch detected:');
        for (const m of mismatches) {
          logger.warn(`  ${m}`);
        }
        logger.info('Consider updating: npm install -g @cluesmith/codev');
        logger.blank();
      }

      resolve();
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      ssh.kill();
      resolve();
    }, 10000);
  });
}

/**
 * Start Agent Farm on a remote machine via SSH
 */
async function startRemote(options: StartOptions): Promise<void> {
  const config = getConfig();
  const { user, host, remotePath } = parseRemote(options.remote!);

  // Clean up stale port allocations (handles machine restarts, killed processes)
  cleanupStaleEntries();

  // Determine local port - use specified, or get from port registry
  // Use a synthetic path for remote connections so they get their own port block
  let localPort: number;
  if (options.port) {
    localPort = Number(options.port);
  } else {
    // Register with a unique key for this remote target
    const remoteKey = `remote:${user}@${host}:${remotePath || 'default'}`;
    localPort = getPortBlock(remoteKey);
  }

  logger.header('Starting Remote Agent Farm');
  logger.kv('Host', `${user}@${host}`);
  if (remotePath) logger.kv('Path', remotePath);
  logger.kv('Local Port', localPort);

  // Build the remote command
  // If no path specified, use the current directory name to find project on remote
  const projectName = basename(config.projectRoot);
  const cdCommand = remotePath
    ? `cd ${remotePath}`
    : `cd ${projectName} 2>/dev/null || cd ~/${projectName} 2>/dev/null`;
  // Always pass --no-browser to remote since we open browser locally
  // Wrap in bash -l to source login environment (gets PATH from .profile)
  const innerCommand = `${cdCommand} && af dash start --port ${localPort} --no-browser`;
  const remoteCommand = `bash -l -c '${innerCommand.replace(/'/g, "'\\''")}'`;

  // Check passwordless SSH is configured
  logger.info('Checking SSH connection...');
  const sshResult = await checkPasswordlessSSH(user, host);
  if (!sshResult.ok) {
    logger.blank();
    fatal(`Cannot connect to ${user}@${host}: ${sshResult.error}

Passwordless SSH is required for remote access. Set it up with:
  ssh-copy-id ${user}@${host}

Then verify with:
  ssh ${user}@${host} "echo connected"`);
  }

  // Check remote CLI versions (non-blocking warning)
  logger.info('Checking remote versions...');
  await checkRemoteVersions(user, host);

  logger.info('Connecting via SSH...');

  // Spawn SSH with port forwarding, -f backgrounds after auth
  const sshArgs = [
    '-f',  // Background after authentication
    '-L', `${localPort}:localhost:${localPort}`,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    `${user}@${host}`,
    remoteCommand,
  ];

  const result = spawnSync('ssh', sshArgs, {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    logger.error('SSH connection failed');
    process.exit(1);
  }

  logger.blank();
  logger.success('Remote Agent Farm connected!');
  logger.kv('Dashboard', `http://localhost:${localPort}`);
  logger.info('SSH tunnel running in background');

  if (!options.noBrowser) {
    await openBrowser(`http://localhost:${localPort}`);
  }

  // Find and report the SSH PID for cleanup
  const pgrep = spawnSync('pgrep', ['-f', `ssh.*${localPort}:localhost:${localPort}.*${host}`]);
  if (pgrep.status === 0) {
    const pid = pgrep.stdout.toString().trim().split('\n')[0];
    logger.info(`To disconnect: kill ${pid}`);
  }
}

/**
 * Start the architect dashboard
 */
export async function start(options: StartOptions = {}): Promise<void> {
  // Handle remote mode
  if (options.remote) {
    return startRemote(options);
  }

  const config = getConfig();

  // Clean up stale port allocations (handles machine restarts, killed processes)
  cleanupStaleEntries();

  // Check for and clean up orphaned tmux sessions
  await handleOrphanedSessions({ kill: true });

  // Warn about stale artifacts from bash-era
  warnAboutStaleArtifacts(config.codevDir);

  // Check if already running
  const state = loadState();
  if (state.architect) {
    // Validate that the architect process is actually alive
    const isAlive = await isProcessRunning(state.architect.pid);

    if (isAlive) {
      // Dashboard port is architect port - 1 (architect runs on base+1, dashboard on base)
      const runningDashboardPort = state.architect.port - 1;
      logger.warn(`Architect already running on port ${state.architect.port}`);
      logger.info(`Dashboard: http://localhost:${runningDashboardPort}`);

      // In remote mode (--no-browser), keep process alive so SSH tunnel stays connected
      if (options.noBrowser) {
        logger.info('Keeping connection alive for remote tunnel...');
        // Block forever - SSH disconnect will kill us
        await new Promise(() => {});
      }
      return;
    } else {
      // PID is dead but state exists - clear stale state and continue
      logger.info('Clearing stale architect state (process no longer running)');
      setArchitect(null);
    }
  }

  // Ensure directories exist
  await ensureDirectories(config);

  // Check all core dependencies (node, tmux, git)
  await checkCoreDependencies();

  // Determine dashboard port early (needed for role prompt and server)
  // If --port was specified, use it for dashboard (important for remote tunneling)
  const dashboardPort = options.port ? Number(options.port) : config.dashboardPort;

  // Command is passed from index.ts (already resolved via CLI > config.json > default)
  let cmd = options.cmd || 'claude';

  // Check if base command exists before we wrap it in a launch script
  const baseCmdName = cmd.split(' ')[0];
  if (!(await commandExists(baseCmdName))) {
    fatal(`Command not found: ${baseCmdName}`);
  }

  // Load architect role if available and not disabled
  if (!options.noRole) {
    const role = loadRolePrompt(config, 'architect');
    if (role) {
      // Write a minimal pointer - AI reads the full file
      const roleFile = resolve(config.stateDir, 'architect-role.md');
      const shortPointer = `You are an Architect. Read codev/roles/architect.md before starting work.

Dashboard: http://localhost:${dashboardPort}
`;
      writeFileSync(roleFile, shortPointer, 'utf-8');

      const launchScript = resolve(config.stateDir, 'launch-architect.sh');
      writeFileSync(launchScript, `#!/bin/bash
cd "${config.projectRoot}"
while true; do
  ${cmd} --append-system-prompt "$(cat '${roleFile}')"
  echo ""
  echo "Claude exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
`, { mode: 0o755 });

      cmd = launchScript;
      logger.info(`Loaded architect role (${role.source})`);
    }
  }

  // Find available port for architect terminal
  // Architect terminal runs on dashboard port + 1 to avoid conflicts
  let architectPort = config.architectPort;
  if (options.port !== undefined) {
    const parsedPort = Number(options.port);
    if (!Number.isFinite(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      fatal(`Invalid port: ${options.port}. Must be a number between 1024-65535`);
    }
    architectPort = parsedPort + 1; // Offset from dashboard port
  }

  logger.header('Starting Agent Farm');
  logger.kv('Project', config.projectRoot);
  logger.kv('Command', cmd);
  logger.kv('Port', architectPort);

  // Start architect in tmux session for persistence
  // Use port in session name to ensure uniqueness across projects
  const sessionName = `af-architect-${architectPort}`;

  // Kill any existing session
  try {
    await run(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);
  } catch {
    // Ignore
  }

  // Create tmux session with the command
  // Note: Inner double quotes handle paths with spaces (e.g., "My Drive")
  await run(`tmux new-session -d -s ${sessionName} -x 200 -y 50 '"${cmd}"'`, { cwd: config.projectRoot });
  await run(`tmux set-option -t ${sessionName} status off`);
  await run(`tmux set-option -t ${sessionName} -g mouse on`);
  await run(`tmux set-option -t ${sessionName} -g set-clipboard on`);
  await run(`tmux set-option -t ${sessionName} -g allow-passthrough on`);

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run(`tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`);
  await run(`tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`);

  // node-pty backend: the dashboard server handles terminal WebSocket connections
  const bindHost = options.allowInsecureRemote ? '0.0.0.0' : undefined;

  if (options.allowInsecureRemote) {
    logger.warn('   Running remotely with 0.0.0.0 is INSECURE. Anyone can access your dashboard.');
    logger.warn('   DEPRECATED: Use `af dash start --remote user@host` for secure remote access instead.');
    logger.warn('   This option will be removed in a future version.\n');
  }

  // Use tmux PID as architect PID for state tracking
  const tmuxPidResult = await run(`tmux list-sessions -F '#{session_name}:#{pid}' | grep '^${sessionName}:' | cut -d: -f2`);
  const architectPid = parseInt(tmuxPidResult.stdout, 10) || 0;

  // Save architect state
  const architectState: ArchitectState = {
    port: architectPort,
    pid: architectPid,
    cmd,
    startedAt: new Date().toISOString(),
    tmuxSession: sessionName,
  };

  setArchitect(architectState);

  // Wait a moment for tmux session to be ready
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Start the dashboard server on the main port
  await startDashboard(config.projectRoot, dashboardPort, architectPort, bindHost);

  // Initialize HQ connector if CODEV_HQ_URL is set
  if (isHQEnabled()) {
    initHQConnector(config.projectRoot);
  }

  logger.blank();
  logger.success('Agent Farm started!');
  logger.kv('Dashboard', `http://localhost:${dashboardPort}`);
  if (isHQEnabled()) {
    logger.kv('HQ', process.env.CODEV_HQ_URL!);
  }

  // Open dashboard in browser (unless --no-browser)
  if (!options.noBrowser) {
    await openBrowser(`http://localhost:${dashboardPort}`);
  }
}

/**
 * Wait for a server to respond on a given port
 * Returns true if server responds, false if timeout
 */
async function waitForServer(port: number, timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(500),
      });
      if (response.ok || response.status === 404) {
        return true; // Server is responding
      }
    } catch {
      // Server not ready yet, continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

/**
 * Start the dashboard HTTP server
 */
async function startDashboard(projectRoot: string, port: number, _architectPort: number, bindHost?: string): Promise<void> {
  const config = getConfig();

  // Try TypeScript source first (dev mode), then compiled JS
  const tsScript = resolve(config.serversDir, 'dashboard-server.ts');
  const jsScript = resolve(config.serversDir, 'dashboard-server.js');

  let command: string;
  let args: string[];

  // Args: <port> [bindHost]
  const serverArgs = [String(port)];
  if (bindHost) {
    serverArgs.push(bindHost);
  }

  if (existsSync(tsScript)) {
    // Dev mode: run with tsx
    command = 'npx';
    args = ['tsx', tsScript, ...serverArgs];
  } else if (existsSync(jsScript)) {
    // Prod mode: run compiled JS
    command = 'node';
    args = [jsScript, ...serverArgs];
  } else {
    logger.warn('Dashboard server not found, skipping dashboard');
    return;
  }

  logger.debug(`Starting dashboard: ${command} ${args.join(' ')}`);

  const serverProcess = spawnDetached(command, args, {
    cwd: projectRoot,
    env: process.env,
  });

  if (!serverProcess.pid) {
    logger.warn('Failed to start dashboard server');
    return;
  }

  // Wait for server to actually be ready
  const isReady = await waitForServer(port, 5000);
  if (!isReady) {
    logger.warn(`Dashboard server did not respond on port ${port} within 5 seconds`);
    logger.warn('Check for errors above or run with DEBUG=1 for more details');
  }
}
