/**
 * Tests for the `codev.referencePRInArchitect` command (issue #1043).
 *
 * Mirrors the test pattern from `extension-architect-commands.test.ts` and
 * `menu-when-clauses.test.ts`: read package.json and extension.ts as source
 * text, assert structural invariants without spinning up the full extension.
 *
 * Verifies:
 *   1. The command is declared in package.json with the $(mention) icon.
 *   2. The view/item/context inline entry targets `codev.pullRequests` /
 *      `pull-request` only (not backlog-item or any other viewItem).
 *   3. The command is hidden from the command palette (when: false).
 *   4. extension.ts registers `codev.referencePRInArchitect` and calls
 *      `buildArchitectReferenceInjection` for the injection text.
 *   5. The injection format for a PR with title matches `#<id> "<title>" `.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildArchitectReferenceInjection } from '../architect-reference-injection.js';

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);

const EXT_SRC = readFileSync(
  resolve(__dirname, '../extension.ts'),
  'utf8',
);

const commands: Array<{ command: string; title: string; icon?: string }> =
  PKG.contributes.commands;

const viewItemMenuEntries: Array<{ command: string; when: string; group?: string }> =
  PKG.contributes.menus['view/item/context'];

const paletteEntries: Array<{ command: string; when?: string }> =
  PKG.contributes.menus.commandPalette;

describe('codev.referencePRInArchitect — package.json', () => {
  it('declares the command with the $(mention) icon', () => {
    const cmd = commands.find(c => c.command === 'codev.referencePRInArchitect');
    expect(cmd, 'command declaration missing').toBeDefined();
    expect(cmd!.icon).toBe('$(mention)');
  });

  it('has a unique title not shared with any other command', () => {
    const title = commands.find(c => c.command === 'codev.referencePRInArchitect')?.title;
    expect(title).toBeDefined();
    const sharing = commands.filter(c => c.title === title);
    expect(sharing).toHaveLength(1);
  });

  it('has a view/item/context inline entry for pull-request rows', () => {
    const entry = viewItemMenuEntries.find(
      e => e.command === 'codev.referencePRInArchitect',
    );
    expect(entry, 'view/item/context entry missing').toBeDefined();
    expect(entry!.when).toContain('view == codev.pullRequests');
    expect(entry!.when).toContain('viewItem == pull-request');
    expect(entry!.group).toBe('inline@1');
  });

  it('does NOT appear on backlog rows or any other viewItem', () => {
    const prEntry = viewItemMenuEntries.find(
      e => e.command === 'codev.referencePRInArchitect',
    );
    expect(prEntry!.when).not.toContain('backlog-item');
    expect(prEntry!.when).not.toContain('codev.backlog');
  });

  it('is hidden from the command palette', () => {
    const entry = paletteEntries.find(e => e.command === 'codev.referencePRInArchitect');
    expect(entry, 'commandPalette entry missing').toBeDefined();
    expect(entry!.when).toBe('false');
  });
});

describe('codev.referencePRInArchitect — extension.ts', () => {
  it('registers the command', () => {
    expect(EXT_SRC).toMatch(
      /(?:registerCommand|regCli)\(['"]codev\.referencePRInArchitect['"]/,
    );
  });

  it('calls buildArchitectReferenceInjection for the injection text', () => {
    const block = EXT_SRC.split("regCli('codev.referencePRInArchitect'")[1] ?? '';
    expect(block).toMatch(/buildArchitectReferenceInjection\(/);
  });

  it('guards on PullRequestTreeItem instanceof before extracting fields', () => {
    const block = EXT_SRC.split("regCli('codev.referencePRInArchitect'")[1] ?? '';
    expect(block).toMatch(/instanceof PullRequestTreeItem/);
  });
});

describe('injection format for PR rows', () => {
  it('produces `#<id> "<title>" ` for a PR with a title', () => {
    expect(buildArchitectReferenceInjection('42', 'Fix the thing'))
      .toBe('#42 "Fix the thing" ');
  });

  it('falls back to `#<id> ` when title is undefined', () => {
    expect(buildArchitectReferenceInjection('42', undefined))
      .toBe('#42 ');
  });

  it('escapes embedded double-quotes in the PR title', () => {
    expect(buildArchitectReferenceInjection('7', 'Has "quoted" word'))
      .toBe('#7 "Has \\"quoted\\" word" ');
  });
});
