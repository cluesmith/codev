/**
 * Regression guards for cluesmith/codev#1952 — no AI attribution in this repository's commits
 * and PR descriptions.
 *
 * Claude Code appends `Co-Authored-By: Claude … <noreply@anthropic.com>` to commits and
 * "🤖 Generated with [Claude Code]" to PR bodies unless a settings file turns that off. An
 * instruction alone competes with that default and loses some of the time, so the repository
 * carries both: the harness setting (Claude Code) and the stated rule in CLAUDE.md/AGENTS.md
 * (every harness, codex and agy included).
 *
 * Scope is this repository only: adopters decide their own attribution, so the skeleton must
 * not ship the setting.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('#1952 — Claude Code attribution is off for this repository', () => {
  it('.claude/settings.json sets attribution.commit and attribution.pr to empty strings', () => {
    const settings = JSON.parse(read('.claude/settings.json'));
    expect(settings.attribution).toEqual({ commit: '', pr: '' });
  });

  it('the skeleton shipped to adopters does not carry the setting', () => {
    // Today the skeleton has no settings.json at all; if one is added later it must not carry
    // the key.
    const skeletonSettings = path.join(repoRoot, 'codev-skeleton/.claude/settings.json');
    const shipped = fs.existsSync(skeletonSettings)
      ? JSON.parse(fs.readFileSync(skeletonSettings, 'utf-8'))
      : {};
    expect(shipped).not.toHaveProperty('attribution');
  });
});

describe('#1952 — CLAUDE.md and AGENTS.md state the rule for every harness', () => {
  it.each(['CLAUDE.md', 'AGENTS.md'])('%s forbids the Co-Authored-By trailer and the "Generated with" line', (rel) => {
    const git = read(rel).split(/^## Git$/m)[1]?.split(/^## /m)[0] ?? '';
    expect(git, `${rel} should have a ## Git section`).not.toBe('');
    // A prohibition earlier in the same sentence as each term: tolerant of rewording, but not of
    // dropping the "no".
    expect(git).toMatch(/\b(?:no|never|not)\b[^.]*Co-Authored-By/i);
    expect(git).toMatch(/\b(?:no|never|not)\b[^.]*Generated with/i);
  });
});
