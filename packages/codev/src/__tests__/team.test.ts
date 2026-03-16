/**
 * Unit tests for lib/team.ts — Team directory infrastructure.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseFrontmatter,
  isValidGitHubHandle,
  loadTeamMembers,
  parseMessageBlock,
  loadMessages,
  hasTeam,
  appendMessage,
  FileMessageChannel,
} from '../lib/team.js';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createTeamDir(members: Record<string, string>, messages?: string): Promise<string> {
  const teamDir = path.join(tmpDir, 'codev', 'team');
  const peopleDir = path.join(teamDir, 'people');
  await fs.mkdir(peopleDir, { recursive: true });

  for (const [filename, content] of Object.entries(members)) {
    await fs.writeFile(path.join(peopleDir, filename), content, 'utf-8');
  }

  if (messages !== undefined) {
    await fs.writeFile(path.join(teamDir, 'messages.md'), messages, 'utf-8');
  }

  return teamDir;
}

// =============================================================================
// parseFrontmatter
// =============================================================================

describe('parseFrontmatter', () => {
  it('parses valid YAML frontmatter', () => {
    const result = parseFrontmatter('---\nname: Alice\ngithub: alice\nrole: architect\n---\nSome notes.');
    expect(result).toEqual({ name: 'Alice', github: 'alice', role: 'architect' });
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('Just regular text')).toBeNull();
  });

  it('returns null for content with only one ---', () => {
    expect(parseFrontmatter('---\nname: Alice\nno closing')).toBeNull();
  });

  it('returns null for empty frontmatter', () => {
    expect(parseFrontmatter('---\n---\nBody text')).toBeNull();
  });

  it('returns null for invalid YAML', () => {
    expect(parseFrontmatter('---\n: invalid: yaml: [\n---')).toBeNull();
  });

  it('handles leading whitespace', () => {
    const result = parseFrontmatter('  \n---\nname: Bob\n---');
    expect(result).toEqual({ name: 'Bob' });
  });
});

// =============================================================================
// isValidGitHubHandle
// =============================================================================

describe('isValidGitHubHandle', () => {
  it('accepts valid handles', () => {
    expect(isValidGitHubHandle('alice')).toBe(true);
    expect(isValidGitHubHandle('alice-bob')).toBe(true);
    expect(isValidGitHubHandle('Alice123')).toBe(true);
    expect(isValidGitHubHandle('a')).toBe(true);
    expect(isValidGitHubHandle('alice-')).toBe(true);
    expect(isValidGitHubHandle('timeleft--')).toBe(true);
  });

  it('rejects invalid handles', () => {
    expect(isValidGitHubHandle('')).toBe(false);
    expect(isValidGitHubHandle('-alice')).toBe(false);
    expect(isValidGitHubHandle('al ice')).toBe(false);
    expect(isValidGitHubHandle('al@ice')).toBe(false);
    expect(isValidGitHubHandle('a'.repeat(40))).toBe(false);
  });
});

// =============================================================================
// loadTeamMembers
// =============================================================================

describe('loadTeamMembers', () => {
  it('loads valid member files', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice Smith\ngithub: alice\nrole: architect\n---\nNotes.',
      'bob.md': '---\nname: Bob Jones\ngithub: bob\n---\nMore notes.',
    });

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe('Alice Smith');
    expect(result.items[0].github).toBe('alice');
    expect(result.items[0].role).toBe('architect');
    expect(result.items[1].name).toBe('Bob Jones');
    expect(result.items[1].role).toBe('member'); // default
    expect(result.warnings).toHaveLength(0);
  });

  it('skips files with missing name field', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\ngithub: alice\n---',
    });

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toContainEqual(expect.stringContaining("Missing 'name'"));
  });

  it('skips files with missing github field', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice\n---',
    });

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toContainEqual(expect.stringContaining("Missing 'github'"));
  });

  it('skips files with malformed YAML', async () => {
    const teamDir = await createTeamDir({
      'bad.md': 'no frontmatter here',
    });

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toContainEqual(expect.stringContaining('Malformed YAML'));
  });

  it('skips files with invalid GitHub handles', async () => {
    const teamDir = await createTeamDir({
      'valid.md': '---\nname: Valid User\ngithub: valid-user\n---',
      'bad-spaces.md': '---\nname: Bad Spaces\ngithub: bad user\n---',
      'bad-chars.md': '---\nname: Bad Chars\ngithub: user@name\n---',
    });

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].github).toBe('valid-user');
    expect(result.warnings).toContainEqual(expect.stringContaining("Invalid GitHub handle 'bad user'"));
    expect(result.warnings).toContainEqual(expect.stringContaining("Invalid GitHub handle 'user@name'"));
  });

  it('deduplicates by GitHub handle (first file wins)', async () => {
    const teamDir = await createTeamDir({
      'alice1.md': '---\nname: Alice Original\ngithub: alice\n---',
      'alice2.md': '---\nname: Alice Duplicate\ngithub: alice\n---',
    });

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Alice Original');
    expect(result.warnings).toContainEqual(expect.stringContaining('Duplicate'));
  });

  it('handles case-insensitive duplicate detection', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice\ngithub: Alice\n---',
      'alice2.md': '---\nname: Alice2\ngithub: alice\n---',
    });

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(1);
  });

  it('returns warning when people/ directory does not exist', async () => {
    const result = await loadTeamMembers(path.join(tmpDir, 'nonexistent'));
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('people/ directory not found');
  });

  it('ignores non-.md files', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice\ngithub: alice\n---',
    });
    await fs.writeFile(path.join(teamDir, 'people', 'readme.txt'), 'ignore me');

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(1);
  });

  it('handles empty people/ directory', async () => {
    const teamDir = await createTeamDir({});

    const result = await loadTeamMembers(teamDir);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// =============================================================================
// parseMessageBlock
// =============================================================================

describe('parseMessageBlock', () => {
  it('parses a valid message block', () => {
    const block = '**alice** | 2026-03-06 14:30 UTC\nHello team!';
    const result = parseMessageBlock(block);
    expect(result).toEqual({
      author: 'alice',
      timestamp: '2026-03-06 14:30 UTC',
      body: 'Hello team!',
      channel: 'file',
    });
  });

  it('handles multi-line body', () => {
    const block = '**bob** | 2026-03-06 15:00 UTC\nLine one\nLine two\nLine three';
    const result = parseMessageBlock(block);
    expect(result?.body).toBe('Line one\nLine two\nLine three');
  });

  it('handles empty body', () => {
    const block = '**alice** | 2026-03-06 14:30 UTC';
    const result = parseMessageBlock(block);
    expect(result?.body).toBe('');
  });

  it('returns null for invalid format', () => {
    expect(parseMessageBlock('just some text')).toBeNull();
    expect(parseMessageBlock('')).toBeNull();
  });

  it('returns null for missing author', () => {
    expect(parseMessageBlock('**** | 2026-03-06 14:30 UTC\nHello')).toBeNull();
  });
});

// =============================================================================
// loadMessages
// =============================================================================

describe('loadMessages', () => {
  it('loads valid messages file', async () => {
    const teamDir = await createTeamDir({}, [
      '# Team Messages',
      '',
      '<!-- Append new messages below. -->',
      '',
      '---',
      '**alice** | 2026-03-06 14:30 UTC',
      'First message.',
      '',
      '---',
      '**bob** | 2026-03-06 15:12 UTC',
      'Second message.',
      '',
    ].join('\n'));

    const result = await loadMessages(path.join(teamDir, 'messages.md'));
    expect(result.items).toHaveLength(2);
    expect(result.items[0].author).toBe('alice');
    expect(result.items[1].author).toBe('bob');
  });

  it('returns empty array for missing file', async () => {
    const result = await loadMessages(path.join(tmpDir, 'nonexistent.md'));
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('skips malformed entries', async () => {
    const teamDir = await createTeamDir({}, [
      '# Team Messages',
      '',
      '---',
      '**alice** | 2026-03-06 14:30 UTC',
      'Valid message.',
      '',
      '---',
      'This is not a valid message format',
      '',
      '---',
      '**bob** | 2026-03-06 15:00 UTC',
      'Another valid one.',
      '',
    ].join('\n'));

    const result = await loadMessages(path.join(teamDir, 'messages.md'));
    expect(result.items).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Malformed message block');
  });

  it('handles empty messages file', async () => {
    const teamDir = await createTeamDir({}, '# Team Messages\n');
    const result = await loadMessages(path.join(teamDir, 'messages.md'));
    expect(result.items).toHaveLength(0);
  });
});

// =============================================================================
// hasTeam
// =============================================================================

describe('hasTeam', () => {
  it('returns true with 2+ .md files in people/', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice\ngithub: alice\n---',
      'bob.md': '---\nname: Bob\ngithub: bob\n---',
    });
    expect(await hasTeam(teamDir)).toBe(true);
  });

  it('returns false with only 1 .md file', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice\ngithub: alice\n---',
    });
    expect(await hasTeam(teamDir)).toBe(false);
  });

  it('returns false with 0 .md files', async () => {
    const teamDir = await createTeamDir({});
    expect(await hasTeam(teamDir)).toBe(false);
  });

  it('returns false when directory does not exist', async () => {
    expect(await hasTeam(path.join(tmpDir, 'nonexistent'))).toBe(false);
  });

  it('only counts .md files', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice\ngithub: alice\n---',
    });
    await fs.writeFile(path.join(teamDir, 'people', 'readme.txt'), 'ignore');
    expect(await hasTeam(teamDir)).toBe(false);
  });

  it('returns false when 2+ .md files exist but are invalid', async () => {
    const teamDir = await createTeamDir({
      'bad1.md': '---\nname: No GitHub\n---',
      'bad2.md': 'no frontmatter at all',
    });
    expect(await hasTeam(teamDir)).toBe(false);
  });

  it('returns false with mix of valid and invalid totaling <2 valid', async () => {
    const teamDir = await createTeamDir({
      'alice.md': '---\nname: Alice\ngithub: alice\n---',
      'bad.md': '---\nname: Missing GitHub\n---',
    });
    expect(await hasTeam(teamDir)).toBe(false);
  });
});

// =============================================================================
// appendMessage
// =============================================================================

describe('appendMessage', () => {
  it('creates file with header when it does not exist', async () => {
    const messagesPath = path.join(tmpDir, 'codev', 'team', 'messages.md');
    await appendMessage(messagesPath, 'alice', 'Hello team!');

    const content = await fs.readFile(messagesPath, 'utf-8');
    expect(content).toContain('# Team Messages');
    expect(content).toContain('**alice**');
    expect(content).toContain('Hello team!');
    expect(content).toContain('UTC');
  });

  it('appends to existing file', async () => {
    const teamDir = await createTeamDir({}, '# Team Messages\n');
    const messagesPath = path.join(teamDir, 'messages.md');

    await appendMessage(messagesPath, 'alice', 'First');
    await appendMessage(messagesPath, 'bob', 'Second');

    const content = await fs.readFile(messagesPath, 'utf-8');
    expect(content).toContain('**alice**');
    expect(content).toContain('**bob**');
    expect(content).toContain('First');
    expect(content).toContain('Second');
  });

  it('messages are parseable after appending', async () => {
    const messagesPath = path.join(tmpDir, 'messages.md');
    await appendMessage(messagesPath, 'alice', 'Test message');

    const result = await loadMessages(messagesPath);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].author).toBe('alice');
    expect(result.items[0].body).toBe('Test message');
    expect(result.items[0].channel).toBe('file');
  });
});

// =============================================================================
// FileMessageChannel
// =============================================================================

describe('FileMessageChannel', () => {
  it('returns messages from file', async () => {
    const teamDir = await createTeamDir({}, [
      '# Team Messages',
      '',
      '---',
      '**alice** | 2026-03-06 14:30 UTC',
      'Hello!',
      '',
    ].join('\n'));

    const channel = new FileMessageChannel(path.join(teamDir, 'messages.md'));
    expect(channel.name).toBe('file');

    const messages = await channel.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].author).toBe('alice');
    expect(messages[0].channel).toBe('file');
  });

  it('returns empty array for missing file', async () => {
    const channel = new FileMessageChannel(path.join(tmpDir, 'nonexistent.md'));
    const messages = await channel.getMessages();
    expect(messages).toHaveLength(0);
  });
});
