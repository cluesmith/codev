/**
 * Team directory infrastructure for Codev.
 *
 * Reads team member files from codev/team/people/*.md (YAML frontmatter)
 * and messages from codev/team/messages.md (append-only log).
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// =============================================================================
// Types
// =============================================================================

export interface TeamMember {
  name: string;
  github: string;
  role: string;
  filePath: string;
}

export interface TeamMessage {
  author: string;
  timestamp: string;
  body: string;
  channel: string;
}

export interface MessageChannel {
  name: string;
  getMessages(): Promise<TeamMessage[]>;
}

export interface LoadResult<T> {
  items: T[];
  warnings: string[];
}

// =============================================================================
// Frontmatter Parsing
// =============================================================================

/**
 * Parse YAML frontmatter from a markdown file content string.
 * Splits on `---` delimiters and parses the middle section with js-yaml.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const secondDash = trimmed.indexOf('---', 3);
  if (secondDash === -1) return null;

  const frontmatterStr = trimmed.slice(3, secondDash).trim();
  if (!frontmatterStr) return null;

  try {
    const parsed = yaml.load(frontmatterStr);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// =============================================================================
// Team Members
// =============================================================================

// GitHub's documented rules say no trailing hyphens or consecutive hyphens,
// but real accounts like "timeleft--" exist. Match what GitHub actually allows:
// starts with alphanumeric, then any mix of alphanumeric and hyphens.
const GITHUB_HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export function isValidGitHubHandle(handle: string): boolean {
  return GITHUB_HANDLE_RE.test(handle) && handle.length <= 39;
}

/**
 * Load team members from codev/team/people/*.md files.
 * Returns parsed members and any warnings encountered.
 */
export async function loadTeamMembers(teamDir: string): Promise<LoadResult<TeamMember>> {
  const peopleDir = path.join(teamDir, 'people');
  const warnings: string[] = [];
  const members: TeamMember[] = [];
  const seenHandles = new Set<string>();

  let files: string[];
  try {
    const entries = await fs.readdir(peopleDir);
    files = entries.filter(f => f.endsWith('.md')).sort();
  } catch {
    return { items: [], warnings: [`people/ directory not found: ${peopleDir}`] };
  }

  for (const file of files) {
    const filePath = path.join(peopleDir, file);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      warnings.push(`Could not read ${file}`);
      continue;
    }

    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      warnings.push(`Malformed YAML frontmatter in ${file}`);
      continue;
    }

    const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
    const github = typeof frontmatter.github === 'string' ? frontmatter.github.trim() : '';
    const role = typeof frontmatter.role === 'string' ? frontmatter.role.trim() : 'member';

    if (!name) {
      warnings.push(`Missing 'name' field in ${file}`);
      continue;
    }
    if (!github) {
      warnings.push(`Missing 'github' field in ${file}`);
      continue;
    }
    if (!isValidGitHubHandle(github)) {
      warnings.push(`Invalid GitHub handle '${github}' in ${file} (skipped)`);
      continue;
    }

    const handleLower = github.toLowerCase();
    if (seenHandles.has(handleLower)) {
      warnings.push(`Duplicate GitHub handle '${github}' in ${file} (skipped)`);
      continue;
    }
    seenHandles.add(handleLower);

    members.push({ name, github, role, filePath });
  }

  return { items: members, warnings };
}

// =============================================================================
// Messages
// =============================================================================

const MESSAGE_HEADER_RE = /^\*\*([^*]+)\*\*\s*\|\s*(.+)$/;

/**
 * Parse a single message block (text between --- separators).
 * Expected format:
 *   **author** | timestamp
 *   body text
 */
export function parseMessageBlock(block: string): TeamMessage | null {
  const lines = block.trim().split('\n');
  if (lines.length === 0) return null;

  const headerMatch = lines[0].match(MESSAGE_HEADER_RE);
  if (!headerMatch) return null;

  const author = headerMatch[1].trim();
  const timestamp = headerMatch[2].trim();
  const body = lines.slice(1).join('\n').trim();

  if (!author || !timestamp) return null;

  return { author, timestamp, body, channel: 'file' };
}

/**
 * Load messages from an append-only messages.md file.
 * Each message is separated by `---`.
 */
export async function loadMessages(messagesPath: string): Promise<LoadResult<TeamMessage>> {
  const warnings: string[] = [];
  let content: string;

  try {
    content = await fs.readFile(messagesPath, 'utf-8');
  } catch {
    return { items: [], warnings: [] };
  }

  const blocks = content.split(/^---$/m);
  const messages: TeamMessage[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Skip the header line (# Team Messages) and comments
    if (trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;

    const message = parseMessageBlock(trimmed);
    if (message) {
      messages.push(message);
    } else if (trimmed.length > 0 && !trimmed.startsWith('#') && !trimmed.startsWith('<!--')) {
      warnings.push(`Malformed message block skipped: ${trimmed.slice(0, 50)}...`);
    }
  }

  return { items: messages, warnings };
}

// =============================================================================
// Team Detection
// =============================================================================

/**
 * Check if a valid team exists (codev/team/ with 2+ valid member files in people/).
 * Reads and validates frontmatter to ensure members have required fields.
 */
export async function hasTeam(teamDir: string): Promise<boolean> {
  const result = await loadTeamMembers(teamDir);
  return result.items.length >= 2;
}

// =============================================================================
// Message Appending
// =============================================================================

const MESSAGES_HEADER = `# Team Messages

<!-- Append new messages below. Do not edit or delete existing entries. -->
`;

/**
 * Append a message to the messages.md file.
 * Creates the file with header if it doesn't exist.
 */
export async function appendMessage(
  messagesPath: string,
  author: string,
  text: string,
): Promise<void> {
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

  let exists = false;
  try {
    await fs.access(messagesPath);
    exists = true;
  } catch {
    // File doesn't exist — will create it
  }

  if (!exists) {
    await fs.mkdir(path.dirname(messagesPath), { recursive: true });
    await fs.writeFile(messagesPath, MESSAGES_HEADER, 'utf-8');
  }

  const entry = `\n---\n**${author}** | ${timestamp}\n${text}\n`;
  await fs.appendFile(messagesPath, entry, 'utf-8');
}

// =============================================================================
// FileMessageChannel
// =============================================================================

export class FileMessageChannel implements MessageChannel {
  name = 'file';
  private messagesPath: string;

  constructor(messagesPath: string) {
    this.messagesPath = messagesPath;
  }

  async getMessages(): Promise<TeamMessage[]> {
    const result = await loadMessages(this.messagesPath);
    return result.items;
  }
}
