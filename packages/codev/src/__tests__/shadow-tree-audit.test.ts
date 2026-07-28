/**
 * Local-unique content audit — process guard (Spec 1252, M11 / T11).
 *
 * The audit exists so that deleting the shadow tree cannot silently destroy
 * codev-specific functionality. This test guards the PROCESS, not just the
 * outcome: every shadow copy must appear in the committed audit with a valid
 * classification, and nothing classified `local-unique` may be reconciled or
 * deleted without a recorded architect ruling.
 *
 * The audit table is machine-parseable BY CONTRACT (fixed 6-column pipe table,
 * enumerated values) — a builder rewriting it as free prose breaks this test,
 * which is the point: weakening the audit must be loud.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getSkeletonDir, listSkeletonFiles } from '../lib/skeleton.js';
import { FRAMEWORK_DRIFT_DIRS } from '../lib/protocol-drift-audit.js';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const AUDIT_PATH = path.join(REPO_ROOT, 'codev', 'resources', '1252-shadow-tree-audit.md');

const CLASSIFICATIONS = new Set(['rot', 'local-unique']);
const TERMINAL_STATES = new Set(['TS1', 'TS2', 'TS3', 'TS4', 'pending']);

interface AuditRow {
  file: string;
  divergence: string;
  classification: string;
  terminalState: string;
  note: string;
}

/** Parse the audit's fixed 6-column table. Throws loudly on shape violations. */
function parseAudit(): AuditRow[] {
  const text = fs.readFileSync(AUDIT_PATH, 'utf-8');
  const rows: AuditRow[] = [];
  for (const line of text.split('\n')) {
    // data rows: | n | `path` | divergence | classification | ts | note |
    const m = line.match(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|([^|]+)\|([^|]+)\|([^|]+)\|(.*)\|\s*$/);
    if (!m) continue;
    rows.push({
      file: m[1].trim(),
      divergence: m[2].trim(),
      classification: m[3].trim(),
      terminalState: m[4].trim(),
      note: m[5].trim(),
    });
  }
  return rows;
}

/** The actual shadow-copy set, computed the same way the audit computed it. */
function actualShadowCopies(): Map<string, 'identical' | 'differs'> {
  const skeletonDir = getSkeletonDir();
  const out = new Map<string, 'identical' | 'differs'>();
  const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  for (const sub of FRAMEWORK_DRIFT_DIRS) {
    for (const rel of listSkeletonFiles(sub)) {
      if (!/\.(md|json)$/.test(rel)) continue;
      const local = path.join(REPO_ROOT, 'codev', rel);
      if (!fs.existsSync(local)) continue;
      out.set(
        rel,
        sha(local) === sha(path.join(skeletonDir, rel)) ? 'identical' : 'differs'
      );
    }
  }
  return out;
}

describe('shadow-tree audit (M11 / T11)', () => {
  it('audit file exists and parses to exactly one row per shadow copy', () => {
    const rows = parseAudit();
    const actual = actualShadowCopies();
    expect(rows.length, 'one audit row per shadow copy').toBe(actual.size);
    const audited = new Set(rows.map((r) => r.file));
    for (const rel of actual.keys()) {
      expect(audited.has(rel), `shadow copy missing from audit: ${rel}`).toBe(true);
    }
  });

  it('every row carries a valid classification and terminal state', () => {
    for (const r of parseAudit()) {
      expect(CLASSIFICATIONS.has(r.classification), `${r.file}: bad classification "${r.classification}"`).toBe(true);
      expect(TERMINAL_STATES.has(r.terminalState), `${r.file}: bad terminal state "${r.terminalState}"`).toBe(true);
      expect(r.note.length, `${r.file}: every row needs a non-empty note`).toBeGreaterThan(0);
    }
  });

  it('divergence column matches reality (audit cannot go stale silently)', () => {
    const actual = actualShadowCopies();
    for (const r of parseAudit()) {
      const real = actual.get(r.file);
      if (!real) continue; // deletion handled in the M8 test below
      expect(r.divergence, `${r.file}: audit says "${r.divergence}" but tree says "${real}"`).toBe(real);
    }
  });

  it('pending is only ever used with local-unique + an ESCALATED note', () => {
    for (const r of parseAudit()) {
      if (r.terminalState === 'pending') {
        expect(r.classification, `${r.file}: pending requires local-unique`).toBe('local-unique');
        expect(r.note, `${r.file}: a pending row must cite its escalation`).toMatch(/ESCALATED/);
      }
      if (r.classification === 'rot') {
        expect(r.terminalState, `${r.file}: rot rows resolve immediately`).not.toBe('pending');
      }
    }
  });

  /**
   * Completion guard: "pending escalation" is NOT a terminal state. Flip when
   * the architect has ruled on all escalations (before M8 deletion executes).
   * The spec's completion rule: all rows in TS1–TS4, zero open escalations.
   */
  const ALL_ESCALATIONS_RESOLVED = false;

  it.skipIf(!ALL_ESCALATIONS_RESOLVED)('at completion: zero rows remain pending', () => {
    const pending = parseAudit().filter((r) => r.terminalState === 'pending');
    expect(pending.map((r) => r.file)).toEqual([]);
  });

  /**
   * M8 process guard (arms itself once deletion starts): any shadow copy that
   * no longer exists locally must have been audited as TS1/TS2/TS4 — a file
   * that vanished while `pending` or `TS3` (retain!) is a process violation.
   */
  it('no file was deleted while pending or marked TS3-retain', () => {
    for (const r of parseAudit()) {
      const local = path.join(REPO_ROOT, 'codev', r.file);
      if (!fs.existsSync(local)) {
        expect(
          ['TS1', 'TS2', 'TS4'].includes(r.terminalState),
          `${r.file} is gone from codev/ but its audit state is "${r.terminalState}" — ` +
            `deletion without a resolving ruling is exactly what M11 forbids`
        ).toBe(true);
      }
    }
  });
});
