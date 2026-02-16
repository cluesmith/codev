/**
 * Shared display utilities for CLI output formatting
 */

import chalk from 'chalk';

/**
 * Get chalk color function for a builder type
 */
export function getTypeColor(type: string): (text: string) => string {
  switch (type) {
    case 'spec':
      return chalk.cyan;
    case 'bugfix':
      return chalk.red;
    case 'task':
      return chalk.magenta;
    case 'protocol':
      return chalk.yellow;
    case 'worktree':
      return chalk.blue;
    case 'shell':
      return chalk.gray;
    default:
      return chalk.white;
  }
}
