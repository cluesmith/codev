/**
 * Wait-discipline guidance and command docs — Spec 1273, phase 7.
 *
 * These are docs tests, which are usually a smell. They earn their place here
 * because of a specific, repeatedly-observed failure in this repo: guidance and
 * reference material live in FOUR parallel trees — `codev/` (this workspace's
 * copies) and `codev-skeleton/` (what adopters get), each with a Claude and a
 * Codex skill variant. Updating one and forgetting its twin is the single most
 * common documentation defect here, and it is invisible in review because the
 * file you are reading looks correct.
 *
 * The standing lesson is "after any framework change, grep BOTH trees". This
 * file is that grep, executed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');

const read = (rel: string) => readFileSync(resolve(REPO, rel), 'utf-8');

const ROLE_DOCS = ['codev/roles/builder.md', 'codev-skeleton/roles/builder.md'];
const COMMAND_DOCS = [
  'codev/resources/commands/agent-farm.md',
  'codev-skeleton/resources/commands/agent-farm.md',
];
const SKILL_DOCS = ['.claude/skills/afx/SKILL.md', '.codex/skills/afx/SKILL.md'];

describe('Spec 1273 phase 7 — wait discipline reaches the builder role doc', () => {
  for (const doc of ROLE_DOCS) {
    describe(doc, () => {
      it('carries the wait-discipline section', () => {
        expect(read(doc)).toContain('## Waiting on external work');
      });

      it('states all three rules', () => {
        const text = read(doc);
        // 1. A wait claims a producer exists.
        expect(text).toMatch(/wait is a claim that a producer exists/i);
        // 2. Background tasks that end the turn.
        expect(text).toMatch(/background tasks that end your turn/i);
        // 3. Never chain foreground poll loops — the rule the incident turned on.
        expect(text).toMatch(/never chain foreground poll loops/i);
      });

      it('explains WHY the poll-loop rule matters, not just the rule', () => {
        // A rule without its reason does not survive contact with a builder that
        // thinks its case is special. The reason is that an unending turn makes
        // the builder unreachable by everyone, including the order to stop.
        const text = read(doc);
        expect(text).toMatch(/queues unread until your current turn ends/i);
      });

      it('names the escape hatch so a stuck builder knows it can be reached', () => {
        const text = read(doc);
        expect(text).toContain('afx interrupt');
        expect(text).toContain('afx refresh');
      });
    });
  }

  it('keeps the two role-doc copies byte-identical', () => {
    // The four-tier resolver means `codev/roles/builder.md` SHADOWS the skeleton
    // copy for this workspace. Skeleton-only would leave our own builders without
    // the guidance; codev-only would leave every adopter without it. Drift
    // between them is silent, so it is asserted.
    const [ours, skeleton] = ROLE_DOCS.map(read);
    expect(ours).toBe(skeleton);
  });
});

describe('Spec 1273 phase 7 — both commands are documented where they are looked up', () => {
  for (const doc of COMMAND_DOCS) {
    describe(doc, () => {
      it('documents afx refresh and afx interrupt', () => {
        const text = read(doc);
        expect(text).toContain('### afx refresh');
        expect(text).toContain('### afx interrupt');
      });

      it('documents every refresh flag the CLI accepts', () => {
        // Kept in sync with cli.ts's registration by hand; a flag that exists
        // and is undocumented is a flag nobody uses.
        const text = read(doc);
        for (const flag of [
          '--note',
          '--file',
          '--dry-run',
          '--interrupt-first',
          '--mode',
          '--timeout',
          '--min-bytes',
          '--quiet-window',
        ]) {
          expect(text).toContain(flag);
        }
      });

      it('states the fail-safe property rather than only listing steps', () => {
        // The reason an architect can run this on a live builder at all is that
        // every gate aborts without clearing. If the docs omit that, the command
        // reads as far more dangerous than it is and goes unused.
        expect(read(doc)).toMatch(/aborts?\s+\*?\*?without clearing/i);
      });
    });
  }
});

describe('Spec 1273 phase 7 — both skill trees, not just the Claude one', () => {
  for (const doc of SKILL_DOCS) {
    it(`${doc} lists afx refresh and afx interrupt`, () => {
      // The repo maintains parallel Claude and Codex skill trees. Updating only
      // the Claude one leaves Codex-driven agents unable to discover the
      // commands — they would have no reason to believe refresh exists.
      expect(existsSync(resolve(REPO, doc))).toBe(true);
      const text = read(doc);
      expect(text).toContain('## afx refresh');
      expect(text).toContain('## afx interrupt');
    });
  }

  it('keeps the two skill trees byte-identical', () => {
    const [claude, codex] = SKILL_DOCS.map(read);
    expect(claude).toBe(codex);
  });
});
