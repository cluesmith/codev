/**
 * afx team CLI commands — list members and post messages.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadTeamMembers, appendMessage, isValidGitHubHandle } from '../../lib/team.js';
import { findWorkspaceRoot } from '../utils/index.js';
import { executeForgeCommandSync } from '../../lib/forge.js';

/**
 * Detect the current user's forge handle or git username.
 * Uses the `user-identity` forge concept command (default: gh api user).
 */
function detectAuthor(cwd?: string): string {
  try {
    const result = executeForgeCommandSync('user-identity', {}, { cwd, raw: true });
    if (result && typeof result === 'string') return result;
  } catch {
    // Fall back to git config
  }
  try {
    const name = execSync('git config user.name', { encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (name) return name;
  } catch {
    // Fall through to default
  }
  return 'unknown';
}

export async function teamList(options: { cwd?: string }): Promise<void> {
  const root = findWorkspaceRoot(options.cwd);
  const teamDir = path.join(root, 'codev', 'team');
  const result = await loadTeamMembers(teamDir);

  if (result.items.length === 0) {
    console.log('No team members found in codev/team/people/');
    for (const w of result.warnings) {
      console.warn(`  ⚠ ${w}`);
    }
    return;
  }

  if (result.items.length < 2) {
    console.warn('⚠ Team requires 2+ members for the Team tab to appear.');
  }

  // Print table
  const nameW = Math.max(4, ...result.items.map(m => m.name.length));
  const ghW = Math.max(6, ...result.items.map(m => m.github.length));
  const roleW = Math.max(4, ...result.items.map(m => m.role.length));

  console.log(`${'Name'.padEnd(nameW)}  ${'GitHub'.padEnd(ghW)}  ${'Role'.padEnd(roleW)}`);
  console.log(`${'─'.repeat(nameW)}  ${'─'.repeat(ghW)}  ${'─'.repeat(roleW)}`);
  for (const m of result.items) {
    console.log(`${m.name.padEnd(nameW)}  ${m.github.padEnd(ghW)}  ${m.role.padEnd(roleW)}`);
  }

  for (const w of result.warnings) {
    console.warn(`⚠ ${w}`);
  }
}

export async function teamAdd(options: { handle: string; name?: string; role?: string; cwd?: string }): Promise<void> {
  const root = findWorkspaceRoot(options.cwd);
  const handle = options.handle.toLowerCase();

  if (!isValidGitHubHandle(handle)) {
    throw new Error(`Invalid GitHub handle '${options.handle}'`);
  }

  const peopleDir = path.join(root, 'codev', 'team', 'people');
  const filePath = path.join(peopleDir, `${handle}.md`);

  // Check if file already exists
  try {
    await fs.access(filePath);
    throw new Error(`Team member '${handle}' already exists at codev/team/people/${handle}.md`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    // File doesn't exist — proceed
  }

  // Ensure directory exists
  await fs.mkdir(peopleDir, { recursive: true });

  const memberName = options.name || handle;
  const memberRole = options.role || 'Team Member';
  const content = `---\nname: ${memberName}\ngithub: ${handle}\nrole: ${memberRole}\n---\n`;

  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`Added team member '${handle}' at codev/team/people/${handle}.md`);
}

export async function teamMessage(options: { text: string; author?: string; cwd?: string }): Promise<void> {
  const root = findWorkspaceRoot(options.cwd);
  const messagesPath = path.join(root, 'codev', 'team', 'messages.md');
  const author = options.author || detectAuthor(options.cwd);

  await appendMessage(messagesPath, author, options.text);
  console.log(`Message posted by ${author}`);
}
