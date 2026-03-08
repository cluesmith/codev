/**
 * Unit tests for af team CLI commands.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadMessages } from '../lib/team.js';

// We test the command logic by importing the functions directly.
// The CLI wiring in cli.ts is tested via the integration/E2E layer.
import { teamList, teamMessage } from '../agent-farm/commands/team.js';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-cli-test-'));
  // Create a minimal git repo so findWorkspaceRoot works
  await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
  // Create codev directory
  await fs.mkdir(path.join(tmpDir, 'codev', 'team', 'people'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function createMember(name: string, github: string, role = 'member') {
  const content = `---\nname: ${name}\ngithub: ${github}\nrole: ${role}\n---\n`;
  await fs.writeFile(path.join(tmpDir, 'codev', 'team', 'people', `${github}.md`), content);
}

// =============================================================================
// teamList
// =============================================================================

describe('teamList', () => {
  it('prints members as a formatted table', async () => {
    await createMember('Alice Smith', 'alice', 'architect');
    await createMember('Bob Jones', 'bob');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await teamList({ cwd: tmpDir });

    expect(logs.some(l => l.includes('Alice Smith'))).toBe(true);
    expect(logs.some(l => l.includes('alice'))).toBe(true);
    expect(logs.some(l => l.includes('Bob Jones'))).toBe(true);
    expect(logs.some(l => l.includes('architect'))).toBe(true);
  });

  it('warns when no members found', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await teamList({ cwd: tmpDir });

    expect(logs.some(l => l.includes('No team members found'))).toBe(true);
  });

  it('warns when <2 members', async () => {
    await createMember('Alice', 'alice');

    const warns: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args.join(' ')));

    await teamList({ cwd: tmpDir });

    expect(warns.some(w => w.includes('2+ members'))).toBe(true);
  });
});

// =============================================================================
// teamMessage
// =============================================================================

describe('teamMessage', () => {
  it('appends a message to messages.md', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    await teamMessage({ text: 'Hello team!', author: 'alice', cwd: tmpDir });

    expect(logs.some(l => l.includes('Message posted by alice'))).toBe(true);

    // Verify message was actually written
    const messagesPath = path.join(tmpDir, 'codev', 'team', 'messages.md');
    const result = await loadMessages(messagesPath);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].author).toBe('alice');
    expect(result.items[0].body).toBe('Hello team!');
  });

  it('creates messages.md if it does not exist', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await teamMessage({ text: 'First!', author: 'bob', cwd: tmpDir });

    const messagesPath = path.join(tmpDir, 'codev', 'team', 'messages.md');
    const content = await fs.readFile(messagesPath, 'utf-8');
    expect(content).toContain('# Team Messages');
    expect(content).toContain('**bob**');
    expect(content).toContain('First!');
  });

  it('appends multiple messages', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await teamMessage({ text: 'msg1', author: 'alice', cwd: tmpDir });
    await teamMessage({ text: 'msg2', author: 'bob', cwd: tmpDir });

    const messagesPath = path.join(tmpDir, 'codev', 'team', 'messages.md');
    const result = await loadMessages(messagesPath);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].author).toBe('alice');
    expect(result.items[1].author).toBe('bob');
  });

  it('uses provided author override', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await teamMessage({ text: 'auto', author: 'cron-bot', cwd: tmpDir });

    const messagesPath = path.join(tmpDir, 'codev', 'team', 'messages.md');
    const result = await loadMessages(messagesPath);
    expect(result.items[0].author).toBe('cron-bot');
  });

  it('auto-detects author when not provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Without explicit author, detectAuthor will try gh then git config.
    // In this test env, at least one should succeed and produce a non-empty string.
    await teamMessage({ text: 'auto-detect test', cwd: tmpDir });

    const messagesPath = path.join(tmpDir, 'codev', 'team', 'messages.md');
    const result = await loadMessages(messagesPath);
    expect(result.items).toHaveLength(1);
    // Author should be a non-empty string (from gh or git config)
    expect(result.items[0].author.length).toBeGreaterThan(0);
  });
});
