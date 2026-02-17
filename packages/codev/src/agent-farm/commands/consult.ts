/**
 * Consult command - runs a consult command as a subprocess
 *
 * Spawns the consult CLI directly, independent of Tower.
 */

import { spawn } from 'node:child_process';
import { logger, fatal } from '../utils/logger.js';

interface ConsultOptions {
  model: string;
  prompt?: string;
  protocol?: string;
  type?: string;
}

/**
 * Run a consult command as a direct subprocess.
 *
 * Uses flag-based mode routing (Spec 325):
 * - General mode: --prompt "text"
 * - Protocol mode: --protocol <name> --type <type>
 */
export async function consult(options: ConsultOptions): Promise<void> {
  const args = ['-m', options.model];

  if (options.protocol) {
    args.push('--protocol', options.protocol);
  }
  if (options.type) {
    args.push('--type', options.type);
  }
  if (options.prompt) {
    args.push('--prompt', options.prompt);
  }

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
