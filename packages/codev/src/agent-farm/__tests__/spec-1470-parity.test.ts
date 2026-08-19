/**
 * Spec 1470, Phase 7 — cross-tree parity and the delay-documentation correction.
 *
 * This phase exists because a false sentence in `--delay`'s help text propagated
 * into this project's own spec as a Constraint and survived until review. The
 * lesson is not "fix the sentence" — it is that a claim repeated across four
 * skill copies, a CLI flag and a type comment has no single place to be wrong,
 * so nothing catches it drifting from the code. These tests are that check.
 *
 * Scope note: the assertions below deliberately do NOT scan `codev/specs`,
 * `codev/plans`, `codev/reviews`, `codev/projects` or `codev/state`. Those are
 * the historical record, and several of them quote the stale wording precisely
 * because they are documenting that it WAS stale. Rewriting history to make a
 * grep pass would destroy the evidence trail this project's review depends on.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../../../');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(repoRoot, rel));

// ---------------------------------------------------------------------------
// Protocol tree parity
// ---------------------------------------------------------------------------

describe('protocol parity between codev/ and codev-skeleton/', () => {
  /**
   * `release` is ours and only ours: it is the procedure for cutting a Codev
   * release, referenced from CLAUDE.md, and adopters have no use for it. It is
   * also `.md`-only — it carries no `protocol.json`.
   *
   * Allowlisted rather than fixed. The asymmetry pre-dates this project and
   * correcting it (either by shipping our release process to adopters or by
   * deleting it) is a decision this phase has no standing to make. What the
   * allowlist buys is that the test fails on a NEW asymmetry, which is the
   * condition worth catching.
   */
  const CODEV_ONLY = new Set(['release']);

  const protocolDirs = (tree: string) =>
    fs
      .readdirSync(path.join(repoRoot, tree, 'protocols'), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();

  it('every protocol we ship has a skeleton counterpart', () => {
    const ours = protocolDirs('codev');
    const skeleton = new Set(protocolDirs('codev-skeleton'));
    const missing = ours.filter(n => !skeleton.has(n) && !CODEV_ONLY.has(n));
    expect(missing, 'protocols present in codev/ but absent from the skeleton').toEqual([]);
  });

  it('the skeleton ships nothing we do not have', () => {
    const ours = new Set(protocolDirs('codev'));
    const extra = protocolDirs('codev-skeleton').filter(n => !ours.has(n));
    expect(extra, 'protocols in the skeleton with no codev/ counterpart').toEqual([]);
  });

  it('the release allowlist entry is still real, not stale', () => {
    // An allowlist nobody re-checks becomes a permanent hole. If `release` ever
    // gains a skeleton counterpart, this fails and the entry gets deleted.
    for (const name of CODEV_ONLY) {
      expect(exists(`codev/protocols/${name}`), `${name} no longer exists in codev/`).toBe(true);
      expect(
        exists(`codev-skeleton/protocols/${name}`),
        `${name} now has a skeleton counterpart — remove it from CODEV_ONLY`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// $schema paths
// ---------------------------------------------------------------------------

describe('protocol.json $schema references', () => {
  /**
   * Every `$schema` must resolve to a file that exists. This is checked across
   * BOTH trees and ALL protocols rather than the one file the plan named,
   * because all nine in `codev/` carried the same broken `../../` path — the
   * single-instance fix would have left eight identical bugs in place.
   *
   * The two trees legitimately use different relative paths: `codev/` has the
   * schema only at `protocols/`, while the skeleton also has a root-level copy.
   * So the invariant worth pinning is "it resolves", not "the string matches".
   */
  const cases = ['codev', 'codev-skeleton'].flatMap(tree =>
    fs
      .readdirSync(path.join(repoRoot, tree, 'protocols'), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => `${tree}/protocols/${e.name}/protocol.json`)
      .filter(rel => exists(rel)),
  );

  it('covers every protocol.json in both trees', () => {
    // Guards the enumeration itself: a glob that silently matches nothing would
    // make every assertion below vacuously pass.
    expect(cases.length).toBeGreaterThanOrEqual(18);
  });

  it.each(cases)('%s resolves its $schema to a real file', rel => {
    const declared = JSON.parse(read(rel)).$schema as string | undefined;
    expect(declared, `${rel} declares no $schema`).toBeTruthy();
    const resolved = path.resolve(path.dirname(path.join(repoRoot, rel)), declared!);
    expect(fs.existsSync(resolved), `${rel}: $schema "${declared}" resolves to ${resolved}`).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// The delay claim
// ---------------------------------------------------------------------------

describe('--delay persistence documentation', () => {
  /**
   * Source of truth, quoted from `servers/delayed-send.ts`: the message body of
   * every `--delay` send is persisted to the durable mailbox at request time, so
   * a plain `--delay` "keeps no timer at all and survives a Tower restart by
   * construction". Only the Ctrl+C nudge of a delayed `--interrupt` is dropped.
   */
  const LIVE_DOCS = [
    'packages/codev/src/agent-farm/cli.ts',
    'packages/codev/src/agent-farm/types.ts',
    '.claude/skills/arch-save/SKILL.md',
    '.codex/skills/arch-save/SKILL.md',
    'codev-skeleton/.claude/skills/arch-save/SKILL.md',
    'codev-skeleton/.codex/skills/arch-save/SKILL.md',
  ];

  it('the source of truth still says what these docs are pinned to', () => {
    // If the implementation ever reverts to dropping bodies on restart, this
    // fails FIRST — so the docs are never "corrected" into a new lie.
    const src = read('packages/codev/src/agent-farm/servers/delayed-send.ts');
    expect(src).toContain('survives a Tower restart by construction');
    expect(src).toContain('Only the in-memory ^C');
  });

  it.each(LIVE_DOCS)('%s carries no stale not-persisted claim', rel => {
    const text = read(rel);
    for (const stale of [
      'dropped if Tower restarts',
      'Not persisted',
      'not persisted',
      'are **not persisted**',
    ]) {
      expect(text.includes(stale), `${rel} still claims "${stale}"`).toBe(false);
    }
  });

  it('the CLI flag and the type comment both state persistence positively', () => {
    expect(read('packages/codev/src/agent-farm/cli.ts')).toContain(
      'survives a Tower restart',
    );
    expect(read('packages/codev/src/agent-farm/types.ts')).toContain('durable mailbox');
  });
});

// ---------------------------------------------------------------------------
// Skill copies
// ---------------------------------------------------------------------------

describe('skill copies across both trees', () => {
  const quartet = (skill: string) => [
    `.claude/skills/${skill}/SKILL.md`,
    `.codex/skills/${skill}/SKILL.md`,
    `codev-skeleton/.claude/skills/${skill}/SKILL.md`,
    `codev-skeleton/.codex/skills/${skill}/SKILL.md`,
  ];

  it.each(['arch-save', 'builder-refresh'])(
    '%s exists in all four locations and is byte-identical',
    skill => {
      const copies = quartet(skill);
      for (const rel of copies) expect(exists(rel), `missing ${rel}`).toBe(true);
      const contents = copies.map(read);
      for (let i = 1; i < contents.length; i++) {
        expect(contents[i], `${copies[i]} differs from ${copies[0]}`).toBe(contents[0]);
      }
    },
  );

  it('the corrected delay paragraph reached every arch-save copy', () => {
    // Distinct from the byte-identity check above: four copies could agree with
    // each other and all still be wrong.
    for (const rel of quartet('arch-save')) {
      expect(read(rel), rel).toContain('Delayed sends **are persisted**');
    }
  });
});
