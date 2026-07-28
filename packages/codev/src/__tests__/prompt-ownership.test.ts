/**
 * Ownership map enforcement (Spec 1252, M1/M4 — T7 + T12).
 *
 * T12 — completeness: every normative candidate in the declared inventory
 * boundary resolves to a disposition, and the catch-all cannot absorb
 * cross-surface duplication. Validated against seeded lines so it cannot pass
 * vacuously (Codex's spec-review requirement).
 *
 * T7 — single-owner: for every `enforcement: automated` class, the pattern
 * matches on exactly the declared owner (scar: false) or on all
 * must_appear_on (scar: true). Assertions DERIVE from the map file —
 * restating ownership in test code would itself violate the single-owner
 * rule. The real classes are `manual` until Phase 7 dedups their
 * restatements; the enforcement machinery is proven here against fixtures.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractCandidates,
  loadOwnershipMap,
  validateMap,
  checkCompleteness,
  computeCompleteness,
  resolveDisposition,
  type OwnershipMap,
} from '../lib/prompt-ownership.js';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('ownership map — structure (M1)', () => {
  it('loads and passes structural validation', () => {
    const map = loadOwnershipMap(REPO_ROOT);
    expect(validateMap(map, REPO_ROOT)).toEqual([]);
  });

  it('every instruction class has exactly one owner', () => {
    const map = loadOwnershipMap(REPO_ROOT);
    for (const c of map.instructions) {
      expect(typeof c.owner, `${c.id}: owner must be a single surface id`).toBe('string');
    }
  });

  it('records why codev/resources/ is outside the drift regime (Q7 / required M1 coverage)', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, 'codev/resources/prompt-ownership.yaml'),
      'utf-8'
    );
    expect(raw).toMatch(/codev\/resources\/ is also deliberately excluded/);
    expect(raw).toMatch(/user-evolved/);
  });
});

describe('completeness (M1 / T12)', () => {
  it('zero undispositioned candidates on the live boundary', () => {
    const report = checkCompleteness(REPO_ROOT);
    expect(
      report.undispositioned.map((c) => `${c.file}:${c.line} ${c.text.slice(0, 80)}`),
      'every normative candidate needs a disposition (mapped | scar | out-of-scope)'
    ).toEqual([]);
    expect(report.total).toBeGreaterThan(50); // extractor actually ran
  });

  it('no cross-surface duplication hides behind the catch-all', () => {
    const report = checkCompleteness(REPO_ROOT);
    expect(
      report.multiFileViaCatchAll.map((c) => `${c.file}:${c.line} ${c.text.slice(0, 80)}`),
      'a normative text on 2+ files must have a specific disposition — add one ' +
        '(mapped/scar/out-of-scope) rather than letting the catch-all absorb it'
    ).toEqual([]);
  });

  it('a missing boundary file fails LOUDLY, never silently shrinking the scan', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'codev-ownership-'));
    try {
      expect(() => extractCandidates(root, ['does/not/exist.md'])).toThrow(
        /inventory_boundary file missing/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('SEEDED: a new normative line is undispositioned until someone dispositions it', () => {
    // Guards T12 against vacuous passing: prove the extractor + resolver
    // actually flag novel content. A map without the catch-all must leave the
    // seeded line undispositioned.
    const map = loadOwnershipMap(REPO_ROOT);
    const noCatchAll: OwnershipMap = {
      ...map,
      dispositions: map.dispositions.filter((d) => !d.catch_all),
    };
    const root = fs.mkdtempSync(path.join(tmpdir(), 'codev-ownership-'));
    try {
      fs.mkdirSync(path.join(root, 'seed'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'seed/a.md'),
        'Some prose.\nNEVER frobnicate the sprocket without a permit.\n'
      );
      const cands = extractCandidates(root, ['seed/a.md']);
      expect(cands.length).toBe(1);
      expect(resolveDisposition(noCatchAll, cands[0])).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('SEEDED: duplicating a line across two files trips the REAL catch-all guard', () => {
    // Exercises computeCompleteness itself (not a local re-implementation):
    // a catch-all-only map over two files sharing one normative line must
    // report both candidates via multiFileViaCatchAll.
    const root = fs.mkdtempSync(path.join(tmpdir(), 'codev-ownership-'));
    try {
      fs.mkdirSync(path.join(root, 'seed'));
      const line = 'ALWAYS varnish the widget before shipping.\n';
      fs.writeFileSync(path.join(root, 'seed/a.md'), line);
      fs.writeFileSync(path.join(root, 'seed/b.md'), line);
      const map: OwnershipMap = {
        inventory_boundary: ['seed/a.md', 'seed/b.md'],
        surfaces: [],
        instructions: [],
        dispositions: [
          { match: '/.*/', disposition: 'out-of-scope', note: 'catch-all', catch_all: true },
        ],
      };
      const cands = extractCandidates(root, map.inventory_boundary);
      expect(cands.length).toBe(2);
      const report = computeCompleteness(map, cands);
      expect(report.undispositioned).toEqual([]);
      expect(report.multiFileViaCatchAll.map((c) => c.file).sort()).toEqual([
        'seed/a.md',
        'seed/b.md',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('companion prompt-ownership.md parity marker matches the live extractor', () => {
    // The human companion must be validated against the YAML/extractor
    // (Codex, Phase-6 review): its t12-parity marker pins the live counts, so
    // the .md cannot silently drift from reality.
    const md = fs.readFileSync(
      path.join(REPO_ROOT, 'codev/resources/prompt-ownership.md'),
      'utf-8'
    );
    const m = md.match(
      /<!-- t12-parity: total=(\d+) mapped=(\d+) scar=(\d+) out-of-scope=(\d+) classes=(\d+) -->/
    );
    expect(m, 'prompt-ownership.md must carry the t12-parity marker').toBeTruthy();
    const report = checkCompleteness(REPO_ROOT);
    const map = loadOwnershipMap(REPO_ROOT);
    expect(Number(m![1]), 'total').toBe(report.total);
    expect(Number(m![2]), 'mapped').toBe(report.byDisposition['mapped']);
    expect(Number(m![3]), 'scar').toBe(report.byDisposition['scar']);
    expect(Number(m![4]), 'out-of-scope').toBe(report.byDisposition['out-of-scope']);
    expect(Number(m![5]), 'classes').toBe(map.instructions.length);
    // and every class id is documented in the companion
    for (const c of map.instructions) {
      expect(md, `companion missing class ${c.id}`).toContain(c.id);
    }
  });
});

describe('single-owner enforcement (M4 / T7)', () => {
  /** Build the T7 assertion set from a map — used for both live and fixture maps. */
  function t7Failures(root: string, map: OwnershipMap): string[] {
    const failures: string[] = [];
    const surfaceById = new Map(map.surfaces.map((s) => [s.id, s]));
    for (const c of map.instructions) {
      if (c.enforcement !== 'automated') continue;
      const allowed = new Set(
        c.scar ? (c.must_appear_on ?? []) : [c.owner]
      );
      const matcher = c.pattern.startsWith('/')
        ? new RegExp(c.pattern.slice(1, -1))
        : null;
      for (const s of map.surfaces) {
        const p = path.join(root, s.path);
        if (!fs.existsSync(p)) continue;
        const content = fs.readFileSync(p, 'utf-8');
        const hit = matcher ? matcher.test(content) : content.includes(c.pattern);
        // No exemption for `references` surfaces: a well-formed reference
        // points at the owner without reproducing the rule text, so it never
        // trips the pattern. If it does, that's a restatement — exactly what
        // T7 exists to catch (Codex, Phase-6 iter-2).
        if (hit && !allowed.has(s.id)) {
          failures.push(`${c.id}: pattern found on non-owner surface ${s.id}`);
        }
        if (!hit && allowed.has(s.id)) {
          failures.push(`${c.id}: pattern MISSING from required surface ${s.id}`);
        }
      }
    }
    return failures;
  }

  it('live map: all automated classes hold', () => {
    const map = loadOwnershipMap(REPO_ROOT);
    expect(t7Failures(REPO_ROOT, map)).toEqual([]);
  });

  it('FIXTURE: machinery detects a restatement on a non-owner surface', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'codev-t7-'));
    try {
      fs.writeFileSync(path.join(root, 'owner.md'), 'RULE-X applies here.\n');
      fs.writeFileSync(path.join(root, 'other.md'), 'RULE-X applies here too.\n');
      const map: OwnershipMap = {
        inventory_boundary: [],
        surfaces: [
          { id: 'owner', path: 'owner.md', load: 'always-on' },
          { id: 'other', path: 'other.md', load: 'always-on' },
        ],
        instructions: [
          {
            id: 'rule-x',
            summary: 'x',
            owner: 'owner',
            scar: false,
            pattern: 'RULE-X',
            enforcement: 'automated',
          },
        ],
        dispositions: [],
      };
      const failures = t7Failures(root, map);
      expect(failures).toEqual(['rule-x: pattern found on non-owner surface other']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('every manual class carries a justification naming its path to automated', () => {
    const map = loadOwnershipMap(REPO_ROOT);
    for (const c of map.instructions) {
      if (c.enforcement === 'manual') {
        expect(
          c.manual_justification ?? '',
          `${c.id}: manual classes must say why and when they flip`
        ).toMatch(/Phase 7|dedup|include|retention/i);
      }
    }
  });
});
