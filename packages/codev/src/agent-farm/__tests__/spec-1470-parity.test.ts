/**
 * Spec 1470, Phase 7 — cross-tree parity and the delay-documentation correction.
 *
 * Spec test 39 (cross-tree parity) is covered JOINTLY by this file and
 * `commands/porch/__tests__/spec-1470-boundary-config.test.ts`. That file owns
 * schema-content parity — that all three `protocol-schema.json` copies describe
 * `context_refresh` identically. This file owns structural parity: protocol
 * directories, `$schema` resolution (including through a real scaffold), skill
 * copies, and the delay claim. Neither is complete alone.
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
import os from 'node:os';
import path from 'node:path';
import { copyProtocols } from '../../lib/scaffold.js';

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

  /**
   * The discriminating test, and the reason the skeleton was changed too.
   *
   * Asserting resolution *inside* the skeleton tree passes with either `../` or
   * `../../`, because the skeleton happens to carry a schema at both levels. But
   * `copyProtocols` copies `codev-skeleton/protocols/*` into a project's
   * `codev/protocols/` and does NOT copy the skeleton's root-level schema — so
   * `../../` resolved in the skeleton and broke the moment it was scaffolded.
   * That is precisely how all nine files in our own `codev/` came to be broken.
   *
   * Fixing only our tree would have left the generator emitting the same bug
   * into every adopter's project. This drives the REAL scaffold function, so it
   * fails if either the paths or the copy behaviour regresses.
   */
  it('every scaffolded project gets a $schema that resolves', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec1470-scaffold-'));
    try {
      copyProtocols(tmp, path.join(repoRoot, 'codev-skeleton'));
      const dir = path.join(tmp, 'codev', 'protocols');
      const protocols = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'protocol.json')));

      expect(protocols.length, 'scaffold copied no protocols — the check would be vacuous')
        .toBeGreaterThanOrEqual(9);

      for (const entry of protocols) {
        const file = path.join(dir, entry.name, 'protocol.json');
        const declared = JSON.parse(fs.readFileSync(file, 'utf-8')).$schema as string;
        const resolved = path.resolve(path.dirname(file), declared);
        expect(
          fs.existsSync(resolved),
          `scaffolded ${entry.name}: $schema "${declared}" does not resolve`,
        ).toBe(true);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

  /**
   * Scoped to the delay-describing region of each file rather than the whole
   * file. A blanket scan would fail on an unrelated, entirely legitimate "not
   * persisted" elsewhere in `cli.ts` or `types.ts` — and it would fail with a
   * message pointing at the wrong thing, which is worse than not checking.
   */
  const delayRegion = (rel: string): string => {
    const text = read(rel);
    if (rel.endsWith('SKILL.md')) return text;
    const lines = text.split('\n');
    const anchor = lines.findIndex(l => /--delay|SendOptions|\bdelay\?:/.test(l));
    expect(anchor, `${rel}: found no --delay/SendOptions anchor to scope the scan to`).toBeGreaterThan(-1);
    return lines.slice(Math.max(0, anchor - 6), anchor + 20).join('\n');
  };

  it.each(LIVE_DOCS)('%s carries no stale not-persisted claim', rel => {
    const text = delayRegion(rel);
    for (const stale of ['dropped if Tower restarts', 'not persisted', 'Not persisted']) {
      expect(text.includes(stale), `${rel} still claims "${stale}" near its delay docs`).toBe(false);
    }
  });

  it('names the one thing a restart DOES drop', () => {
    // "Survives a restart" alone is over-broad: a delayed `--interrupt` still
    // loses its Ctrl+C nudge. A correction that trades one imprecise claim for
    // another has not fixed anything.
    // Scoped to the `--delay` option's OWN line. A whole-file `toContain('--interrupt')`
    // passes on the unrelated `--interrupt` option defined a few lines above — it
    // was written that way first, and a mutation check caught that deleting the
    // caveat changed nothing.
    const delayOption = read('packages/codev/src/agent-farm/cli.ts')
      .split('\n')
      .find(l => l.includes(".option('--delay <seconds>'"));
    expect(delayOption, "cli.ts no longer defines a --delay option").toBeDefined();
    expect(delayOption, 'the --delay help claims restart-survival without naming the exception')
      .toContain('--interrupt');
    expect(read('packages/codev/src/agent-farm/types.ts')).toContain('Ctrl+C nudge');
    for (const rel of [
      '.claude/skills/arch-save/SKILL.md',
      '.codex/skills/arch-save/SKILL.md',
      'codev-skeleton/.claude/skills/arch-save/SKILL.md',
      'codev-skeleton/.codex/skills/arch-save/SKILL.md',
    ]) {
      expect(read(rel), rel).toContain('delayed `--interrupt`');
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
