/**
 * CLI prompt utilities
 * Extracted from init.ts and adopt.ts to eliminate duplication
 * (Maintenance Run 0004)
 */

import * as readline from 'node:readline';

/**
 * Prompt user for text input
 * @param question - The question to display
 * @param defaultValue - Optional default value shown in brackets
 * @returns The user's input or the default value
 */
export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for yes/no confirmation
 * @param question - The question to display
 * @param defaultYes - Whether 'yes' is the default (true) or 'no' is (false)
 * @returns true if user confirmed, false otherwise
 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') {
        resolve(defaultYes);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}
