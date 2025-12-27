/**
 * Tunnel command for Agent Farm (Spec 0062 - Secure Remote Access)
 *
 * Outputs SSH command for accessing Agent Farm remotely via SSH tunnel.
 * This enables secure remote access without exposing the dashboard to the network.
 */

import { networkInterfaces, userInfo, platform } from 'node:os';
import { getArchitect } from '../state.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';

/**
 * Get all non-loopback IPv4 addresses from network interfaces
 */
function getLocalIPs(): string[] {
  const interfaces = networkInterfaces();
  const ips: string[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      // Skip loopback, internal, and IPv6
      if (addr.internal) continue;
      if (addr.family !== 'IPv4') continue;
      ips.push(addr.address);
    }
  }

  return ips;
}

export interface TunnelOptions {
  // No options currently, but keeping interface for future extensions
}

/**
 * Display SSH tunnel command for remote access
 */
export function tunnel(_options: TunnelOptions = {}): void {
  // Check if Agent Farm is running
  const architect = getArchitect();

  if (!architect) {
    logger.error('Agent Farm is not running. Start with: af start');
    process.exit(1);
  }

  // Windows-specific guidance
  if (platform() === 'win32') {
    logger.warn('Note: Windows requires OpenSSH Server to be enabled.');
    logger.info('See: https://docs.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse');
    console.log('');
    logger.info('Alternatively, use WSL2 or Tailscale for remote access.');
    console.log('');
  }

  // Get network info
  const ips = getLocalIPs();
  const user = userInfo().username;

  // Dashboard port is architect port minus 1
  const config = getConfig();
  const dashboardPort = config.dashboardPort;

  // Output SSH command
  console.log('');
  logger.header('Remote Access via SSH Tunnel');
  console.log('');
  console.log('Run this command on your other device:\n');

  if (ips.length === 0) {
    console.log(`  ssh -L ${dashboardPort}:localhost:${dashboardPort} ${user}@<your-ip>`);
  } else {
    for (const ip of ips) {
      console.log(`  ssh -L ${dashboardPort}:localhost:${dashboardPort} ${user}@${ip}`);
    }
  }

  console.log(`\nThen open: http://localhost:${dashboardPort}`);

  // SSH config suggestion
  console.log('\nTip: Add to ~/.ssh/config for easy access:');
  console.log('  Host agent-farm');
  console.log(`    HostName ${ips[0] || '<your-ip>'}`);
  console.log(`    User ${user}`);
  console.log(`    LocalForward ${dashboardPort} localhost:${dashboardPort}`);
  console.log('');
}
