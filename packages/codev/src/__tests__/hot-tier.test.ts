/**
 * Spec 987 — Hot/cold governance docs.
 * Phase 1: the always-on HOT tier files (arch-critical.md, lessons-critical.md)
 * exist at every placement location and stay within the hard cap.
 *
 * The cap is the load-bearing mechanism: always-on injection is only affordable
 * because each hot file is tiny. This test fails loudly if a hot file grows past
 * the cap (the displacement discipline must demote to the cold doc instead).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HOT_CAP_LINES,
  HOT_CAP_ENTRIES,
  HOT_CAP_MAP_TOPICS,
  bulletsUnder,
  topLevelHeadings,
  mapTopics,
  sectionsNamedBy,
} from '../lib/governance-bootstrap.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

const HOT_FILES = ['arch-critical.md', 'lessons-critical.md'] as const;

// Placement (verified against the four-tier resolver + scaffold sources):
//  - codev/resources       : this repo's tier-2 instance (real curated content)
//  - codev-skeleton/templates : copy source for init/adopt/update
//  - codev-skeleton/resources : runtime tier-4 fallback (resolveCodevFile)
//  - codev/templates       : instance template mirror
const PLACEMENTS = [
  'codev/resources',
  'codev-skeleton/templates',
  'codev-skeleton/resources',
  'codev/templates',
] as const;

// Real curated content lives in the instance; the skeleton/template copies are
// generic starters with placeholders, so structural asserts apply only here.
const REAL_DIR = 'codev/resources';

// The cap and map rules are shared with the bootstrap validator (Spec 1797), so this test
// and `codev bootstrap-docs` enforce one definition. The raw line count below (comments
// included) is this test's stricter policy for the shipped placements.
const CAP_LINES = HOT_CAP_LINES;
const CAP_FACTS = HOT_CAP_ENTRIES;
const CAP_MAP_TOPICS = HOT_CAP_MAP_TOPICS;

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

// Match `wc -l` semantics: count newline characters.
function lineCount(content: string): number {
  return (content.match(/\n/g) ?? []).length;
}

// Which cold doc each real hot file maps.
const COLD_DOC: Record<string, string> = {
  'arch-critical.md': 'codev/resources/arch.md',
  'lessons-critical.md': 'codev/resources/lessons-learned.md',
};

describe('Spec 987 — hot tier placement and cap', () => {
  it('every hot file exists at all four placement locations and is non-empty', () => {
    for (const dir of PLACEMENTS) {
      for (const file of HOT_FILES) {
        const rel = `${dir}/${file}`;
        expect(fs.existsSync(path.join(repoRoot, rel)), `${rel} should exist`).toBe(true);
        expect(read(rel).trim().length, `${rel} should be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('every placed hot file is within the line cap', () => {
    for (const dir of PLACEMENTS) {
      for (const file of HOT_FILES) {
        const rel = `${dir}/${file}`;
        expect(lineCount(read(rel)), `${rel} exceeds ${CAP_LINES}-line cap`).toBeLessThanOrEqual(
          CAP_LINES
        );
      }
    }
  });

  it('the real instance hot files have capped facts and a capped cold-doc map', () => {
    for (const file of HOT_FILES) {
      const rel = `${REAL_DIR}/${file}`;
      const content = read(rel);

      const facts = bulletsUnder(content, 'Critical').length;
      expect(facts, `${rel}: facts present`).toBeGreaterThan(0);
      expect(facts, `${rel}: facts exceed cap`).toBeLessThanOrEqual(CAP_FACTS);

      const mapEntries = bulletsUnder(content, 'Map').length;
      expect(mapEntries, `${rel}: cold-doc map present`).toBeGreaterThan(0);
      expect(mapEntries, `${rel}: map exceeds cap`).toBeLessThanOrEqual(CAP_MAP_TOPICS);

      // The map must point at its sibling cold doc with "consult when" guidance.
      expect(content).toMatch(/## Map of (arch|lessons-learned)\.md \(consult when/);
    }
  });

  it('every map topic in the real hot files names a real top-level section of its cold doc', () => {
    // Accuracy (not completeness): the map is bounded/curated by design, so it need not
    // list every cold-doc section — but every topic it DOES list must be a real one.
    for (const file of HOT_FILES) {
      const hot = read(`${REAL_DIR}/${file}`);
      const headings = topLevelHeadings(read(COLD_DOC[file]));
      const topics = mapTopics(hot);
      expect(topics.length, `${file}: map should have topics`).toBeGreaterThan(0);
      for (const topic of topics) {
        expect(
          sectionsNamedBy(topic, headings).length === 1,
          `${file}: map topic "${topic}" must name exactly one top-level section of ${COLD_DOC[file]}`
        ).toBe(true);
      }
    }
  });

  it('keeps the cold reference docs (not retired)', () => {
    for (const cold of ['codev/resources/arch.md', 'codev/resources/lessons-learned.md']) {
      expect(fs.existsSync(path.join(repoRoot, cold)), `${cold} must still exist`).toBe(true);
    }
  });
});
