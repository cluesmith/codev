/**
 * Start command - launches the architect dashboard
 */

import { resolve, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { StartOptions, ArchitectState } from '../types.js';
import { version as localVersion } from '../../version.js';
import { getConfig, ensureDirectories } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { spawnDetached, commandExists, findAvailablePort, openBrowser, run, spawnTtyd } from '../utils/shell.js';
import { checkCoreDependencies } from '../utils/deps.js';
import { loadState, setArchitect } from '../state.js';
import { handleOrphanedSessions, warnAboutStaleArtifacts } from '../utils/orphan-handler.js';
import { getPortBlock } from '../utils/port-registry.js';
import { loadRolePrompt } from '../utils/roles.js';

/**
 * Rename a Claude session after it starts
 * Sends /rename command to the tmux session after a brief delay
 */
function renameClaudeSession(sessionName: string, displayName: string): void {
  // Wait for Claude to be ready, then send /rename command
  setTimeout(async () => {
    try {
      const safeName = displayName.replace(/"/g, '\\"');
      await run(`tmux send-keys -t "${sessionName}" "/rename ${safeName}" C-m`);
    } catch {
      // Non-fatal - session naming is a nice-to-have
    }
  }, 2000);
}

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
  return { user: match[1], host: match[2], remotePath: match[3] };
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

  // Determine local port - use specified, or get from port registry
  let localPort: number;
  if (options.port) {
    localPort = Number(options.port);
  } else {
    // Use the port registry to get a consistent port block for this project
    const basePort = getPortBlock(config.projectRoot);
    localPort = basePort; // Dashboard port is the base port
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
  const innerCommand = `${cdCommand} && af start --port ${localPort} --no-browser`;
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

  // Spawn SSH with port forwarding
  const sshArgs = [
    '-L', `${localPort}:localhost:${localPort}`,
    '-t',  // Force TTY for remote af start
    '-o', 'ServerAliveInterval=30',  // Keep connection alive
    '-o', 'ServerAliveCountMax=3',
    `${user}@${host}`,
    remoteCommand,
  ];

  const ssh: ChildProcess = spawn('ssh', sshArgs, {
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  // Track if we've seen the dashboard URL
  let dashboardReady = false;
  let dashboardUrl = '';

  // Parse SSH stdout for the dashboard URL
  ssh.stdout?.on('data', (data: Buffer) => {
    const output = data.toString();
    process.stdout.write(output); // Echo to user

    // Look for dashboard URL in output
    const dashboardMatch = output.match(/Dashboard:\s*(http:\/\/localhost:\d+)/);
    if (dashboardMatch && !dashboardReady) {
      dashboardReady = true;
      dashboardUrl = dashboardMatch[1];

      // Give it a moment to fully start, then open browser
      setTimeout(async () => {
        logger.blank();
        logger.success('Remote Agent Farm connected!');
        logger.kv('Dashboard', `http://localhost:${localPort}`);

        if (!options.noBrowser) {
          await openBrowser(`http://localhost:${localPort}`);
        }

        if (options.attach) {
          // Attach mode: stay connected, user must Ctrl+C to disconnect
          logger.info('Press Ctrl+C to disconnect');
        } else {
          // Default: detach and return shell to user, SSH tunnel runs in background
          logger.kv('SSH PID', String(ssh.pid));
          logger.info('Tunnel running in background. Kill with: kill ' + ssh.pid);

          // Unref to allow parent to exit while SSH keeps running
          ssh.unref();
          if (ssh.stdout) (ssh.stdout as unknown as { unref: () => void }).unref();
          if (ssh.stderr) (ssh.stderr as unknown as { unref: () => void }).unref();
          process.stdin.unref();

          // Exit after a brief delay to let output flush
          setTimeout(() => process.exit(0), 100);
        }
      }, 1000);
    }

    // Detect common remote errors
    if (output.includes('command not found: af') || output.includes('af: command not found')) {
      logger.blank();
      logger.error('Agent Farm (af) is not installed on the remote machine');
      logger.info('Install it with: npm install -g @cluesmith/codev');
    }
    if (output.includes('not a git repository') || output.includes('fatal: not a git repository')) {
      logger.blank();
      logger.error('Remote directory is not a git repository');
      logger.info('Specify the correct path: af start --remote user@host:/path/to/project');
    }
  });

  // Handle SSH exit
  ssh.on('exit', (code) => {
    logger.blank();
    if (code === 0) {
      logger.info('Remote session ended');
    } else if (code === 255) {
      logger.error(`SSH connection failed to ${user}@${host}`);
      logger.info('');
      logger.info('Common causes:');
      logger.info('  • Host unreachable: Check network/firewall and that the host is running');
      logger.info(`  • SSH keys: Run \`ssh-copy-id ${user}@${host}\` to set up key-based auth`);
      logger.info(`  • Unknown host: Run \`ssh ${user}@${host}\` once to add to known_hosts`);
    } else if (code === 127) {
      logger.error('Command not found on remote machine');
      logger.info('Ensure Agent Farm is installed: npm install -g @cluesmith/codev');
    } else if (code === 1) {
      logger.error('Remote command failed');
      logger.info('Check that:');
      logger.info('  • The project path exists on the remote machine');
      logger.info('  • You have permission to access the directory');
      logger.info('  • Agent Farm dependencies (tmux, ttyd) are installed');
    } else {
      logger.error(`Remote session ended with exit code ${code}`);
    }
    process.exit(code || 0);
  });

  // Handle SIGINT to gracefully close SSH
  process.on('SIGINT', () => {
    logger.info('Closing remote connection...');
    ssh.kill('SIGTERM');
  });

  // Keep the process alive
  await new Promise(() => {}); // Never resolves - waits for SSH exit
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

  // Check for and clean up orphaned tmux sessions
  await handleOrphanedSessions({ kill: true });

  // Warn about stale artifacts from bash-era
  warnAboutStaleArtifacts(config.codevDir);

  // Check if already running
  const state = loadState();
  if (state.architect) {
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
  }

  // Ensure directories exist
  await ensureDirectories(config);

  // Check all core dependencies (node, tmux, ttyd, git)
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
      // Write role to a file and create a launch script to avoid shell escaping issues
      // The architect.md file contains backticks, $variables, and other shell-sensitive chars
      const roleFile = resolve(config.stateDir, 'architect-role.md');
      // Inject the actual dashboard port into the role prompt
      const roleContent = role.content.replace(/\{PORT\}/g, String(dashboardPort));
      writeFileSync(roleFile, roleContent, 'utf-8');

      const launchScript = resolve(config.stateDir, 'launch-architect.sh');
      writeFileSync(launchScript, `#!/bin/bash
cd "${config.projectRoot}"
exec ${cmd} --append-system-prompt "$(cat '${roleFile}')"
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

  // Start ttyd attached to the tmux session
  const customIndexPath = resolve(config.templatesDir, 'ttyd-index.html');
  const hasCustomIndex = existsSync(customIndexPath);
  if (hasCustomIndex) {
    logger.info('Using custom terminal with file click support');
  }

  const bindHost = options.allowInsecureRemote ? '0.0.0.0' : undefined;

  if (options.allowInsecureRemote) {
    logger.warn('⚠️  INSECURE MODE: Binding to 0.0.0.0 - accessible from any network!');
    logger.warn('   No authentication - anyone on your network can access the terminal.');
    logger.warn('   DEPRECATED: Use `af start --remote user@host` for secure remote access instead.');
  }

  const ttydProcess = spawnTtyd({
    port: architectPort,
    sessionName,
    cwd: config.projectRoot,
    customIndexPath: hasCustomIndex ? customIndexPath : undefined,
    bindHost,
  });

  if (!ttydProcess?.pid) {
    fatal('Failed to start ttyd process');
  }

  // Rename Claude session for better history tracking
  const projectName = basename(config.projectRoot);
  renameClaudeSession(sessionName, `Architect ${projectName}`);

  // Save architect state
  const architectState: ArchitectState = {
    port: architectPort,
    pid: ttydProcess.pid,
    cmd,
    startedAt: new Date().toISOString(),
    tmuxSession: sessionName,
  };

  setArchitect(architectState);

  // Wait a moment for ttyd to start
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Start the dashboard server on the main port
  await startDashboard(config.projectRoot, dashboardPort, architectPort, bindHost);

  logger.blank();
  logger.success('Agent Farm started!');
  logger.kv('Dashboard', `http://localhost:${dashboardPort}`);

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
