/**
 * Start command - launches the architect dashboard
 *
 * Phase 3 (Spec 0090): Uses tower API for project activation.
 * Tower is the single daemon that manages all projects.
 */

import { basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import type { StartOptions } from '../types.js';
import { version as localVersion } from '../../version.js';
import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import { TowerClient } from '../lib/tower-client.js';
import { towerStart } from './tower.js';

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
  // Strip trailing slash to normalize path (e.g., /path/ vs /path)
  const remotePath = match[3]?.replace(/\/$/, '');
  return { user: match[1], host: match[2], remotePath };
}

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

  // Use specified port or find a free local port for the SSH tunnel
  let localPort = options.port ? Number(options.port) : DEFAULT_TOWER_PORT;
  if (!options.port && !(await isPortAvailable(localPort))) {
    // Local Tower likely running on 4100, find an alternative port for the tunnel
    for (let p = localPort + 1; p < localPort + 100; p++) {
      if (await isPortAvailable(p)) {
        localPort = p;
        break;
      }
    }
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
  // No --port needed: Tower always runs on DEFAULT_TOWER_PORT (4100)
  // Wrap in bash -l to source login environment (gets PATH from .profile)
  const innerCommand = `${cdCommand} && af dash start --no-browser`;
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
    '-L', `${localPort}:localhost:${DEFAULT_TOWER_PORT}`,
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
  const pgrep = spawnSync('pgrep', ['-f', `ssh.*${localPort}:localhost:${DEFAULT_TOWER_PORT}.*${host}`]);
  if (pgrep.status === 0) {
    const pid = pgrep.stdout.toString().trim().split('\n')[0];
    logger.info(`To disconnect: kill ${pid}`);
  }
}

/**
 * Default tower port
 */
const DEFAULT_TOWER_PORT = 4100;

/**
 * Start via tower API (Phase 3 - Spec 0090)
 *
 * This is the new way to start projects:
 * 1. Ensure tower is running
 * 2. Call tower's activate API
 * 3. Open browser to tower URL
 */
async function startViaTower(options: StartOptions): Promise<void> {
  const config = getConfig();
  const projectPath = config.projectRoot;

  logger.header('Starting Agent Farm');
  logger.kv('Project', projectPath);

  // Create tower client
  const client = new TowerClient(DEFAULT_TOWER_PORT);

  // Check if tower is running
  const towerRunning = await client.isRunning();

  if (!towerRunning) {
    logger.info('Starting tower daemon...');
    await towerStart({ port: DEFAULT_TOWER_PORT, wait: true });

    // Give tower a moment to fully initialize
    await new Promise((r) => setTimeout(r, 500));
  }

  // Activate project via tower API
  logger.info('Activating project...');
  const result = await client.activateProject(projectPath);

  if (!result.ok) {
    fatal(`Failed to activate project: ${result.error}`);
  }

  if (result.adopted) {
    logger.info('Project auto-adopted (codev/ directory created)');
  }

  // Get project URL from tower
  const projectUrl = client.getProjectUrl(projectPath);

  logger.blank();
  logger.success('Agent Farm started!');
  logger.kv('Dashboard', projectUrl);

  // Open browser only if Tower wasn't already running (user already has it open)
  if (!options.noBrowser && !towerRunning) {
    await openBrowser(projectUrl);
  } else if (towerRunning) {
    logger.info('Tower already running — project visible in your browser.');
  }

  // For remote mode, keep process alive
  if (options.noBrowser) {
    logger.info('Keeping connection alive for remote tunnel...');
    // Block forever - SSH disconnect will kill us
    await new Promise(() => {});
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

  // Use tower API for local starts (Phase 3 - Spec 0090)
  return startViaTower(options);
}

