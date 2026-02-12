/**
 * Consult command - runs a consult command as a subprocess
 *
 * Spawns the consult CLI directly, independent of Tower.
 */

import { spawn } from 'node:child_process';
import { logger, fatal } from '../utils/logger.js';

interface ConsultOptions {
  model: string;
  type?: string;
}

/**
 * Run a consult command as a direct subprocess
 */
export async function consult(
  subcommand: string,
  target: string,
  options: ConsultOptions
): Promise<void> {
  // Build the consult command arguments
  const args = ['--model', options.model];
  if (options.type) {
    args.push('--type', options.type);
  }
  args.push(subcommand, target);

  logger.info(`Running: consult ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn('consult', args, {
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        fatal('consult CLI not found. Install with: npm install -g @cluesmith/codev');
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`consult exited with code ${code}`));
      }
    });
  });
}
