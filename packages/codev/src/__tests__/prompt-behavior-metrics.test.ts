/**
 * Behavioural-metrics baseline script (Spec 1252, M12a / T14).
 *
 * The metrics exist so that a word-count win cannot be declared while agent
 * behaviour silently degrades. For a before/after comparison to mean anything,
 * the committed-artifact metrics must be DETERMINISTIC: the same commit must
 * yield the same numbers.
 *
 * B5 (consult cost/duration) is deliberately absent from this module and from
 * the determinism assertion — it derives from a rolling 30-day machine-local
 * DB, so it is not reproducible from a commit. It is advisory context and
 * drives no rollback trigger. (T14 originally asserted determinism over
 * "B1–B5", which was self-contradictory; caught at delta review.)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { measureBehavior, render } from '../lib/prompt-behavior-metrics.js';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Build a throwaway repo root with a hand-written status.yaml corpus. */
function fixtureRoot(statusYamls: Record<string, string>, prose: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'codev-behavior-'));
  for (const [proj, body] of Object.entries(statusYamls)) {
    const d = path.join(root, 'codev', 'projects', proj);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'status.yaml'), body);
  }
  for (const [rel, body] of Object.entries(prose)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

const TWO_PHASE_PROJECT = `
id: '900'
protocol: spir
history:
  - iteration: 1
    plan_phase: phase_1
    reviews:
      - {model: gemini, verdict: APPROVE}
      - {model: codex, verdict: REQUEST_CHANGES}
      - {model: claude, verdict: APPROVE}
  - iteration: 2
    plan_phase: phase_1
    reviews:
      - {model: gemini, verdict: APPROVE}
      - {model: codex, verdict: REQUEST_CHANGES}
      - {model: claude, verdict: COMMENT}
  - iteration: 1
    plan_phase: phase_2
    reviews:
      - {model: gemini, verdict: APPROVE}
`;

describe('behavioural metrics (M12a / T14)', () => {
  it('is DETERMINISTIC over B1–B4 for a fixed corpus', () => {
    const root = fixtureRoot({ '900-x': TWO_PHASE_PROJECT });
    try {
      const a = measureBehavior(root);
      const b = measureBehavior(root);
      expect(a).toEqual(b);
      // and stable across a re-render
      expect(render(a)).toEqual(render(b));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('computes B1 as the REQUEST_CHANGES share of all verdicts', () => {
    const root = fixtureRoot({ '900-x': TWO_PHASE_PROJECT });
    try {
      const m = measureBehavior(root);
      // 7 verdicts: 4 APPROVE, 2 REQUEST_CHANGES, 1 COMMENT
      expect(m.b1_totalVerdicts).toBe(7);
      expect(m.b1_verdictCounts['REQUEST_CHANGES']).toBe(2);
      expect(m.b1_requestChangesRate).toBeCloseTo(28.57, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('computes B2 as max(iteration) per plan_phase, not rounds-to-unanimity', () => {
    // The corpus above never reaches 3x APPROVE on phase_1 — which is exactly
    // the real-world pattern (0 of 48 terminal phases in this repo end
    // unanimously; porch advances on builder rebuttal). A rounds-to-unanimity
    // metric would never resolve here; max(iteration) does.
    const root = fixtureRoot({ '900-x': TWO_PHASE_PROJECT });
    try {
      const m = measureBehavior(root);
      expect(m.b2_phaseCount).toBe(2); // phase_1, phase_2
      expect(m.b2_roundsPerPhaseMax).toBe(2); // phase_1 reached iteration 2
      expect(m.b2_roundsPerPhaseMean).toBeCloseTo(1.5, 2);
      expect(m.b4_roundsPerProjectMean).toBeCloseTo(3, 2); // 2 + 1
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores projects with empty history (pir/bugfix/air contribute nothing)', () => {
    const root = fixtureRoot({
      '900-x': TWO_PHASE_PROJECT,
      '901-y': "id: '901'\nprotocol: bugfix\nhistory: []\n",
    });
    try {
      const m = measureBehavior(root);
      expect(m.sampleProjects).toEqual(['900-x']);
      expect(m.b4_projectCount).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('survives a malformed status.yaml without aborting the run', () => {
    const root = fixtureRoot({
      '900-x': TWO_PHASE_PROJECT,
      '902-bad': 'id: [unclosed\n  ::: not yaml :::\n',
    });
    try {
      const m = measureBehavior(root);
      expect(m.sampleProjects).toEqual(['900-x']); // bad file skipped, run completes
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('B3 emits excerpts, not just counts, so a human can adjudicate', () => {
    const root = fixtureRoot(
      {},
      {
        'codev/reviews/1-x.md': 'I ran git add -A by mistake and it staged secrets\n',
        'codev/state/b_thread.md': 'Reminder: never use git add -A here.\n',
      }
    );
    try {
      const m = measureBehavior(root);
      const hit = m.b3_candidateHits.find((h) => h.rule === 'git-add-all');
      expect(hit, 'the confessional line should be flagged').toBeTruthy();
      expect(hit!.excerpt).toContain('git add -A');
      expect(hit!.file).toBe('codev/reviews/1-x.md');
      expect(hit!.line).toBe(1);

      // The prescriptive "never use..." line is documentation, not a breach.
      expect(m.b3_candidateHits.filter((h) => h.file.endsWith('b_thread.md'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT report gate-rejection counts (the data does not exist)', () => {
    // Appendix D §2: no `rejected` gate state is ever persisted and
    // `requested_at` is overwritten on re-request, so a rejected-then-approved
    // gate is indistinguishable from a clean approval. A plausible-looking zero
    // would be worse than an absent metric.
    const m = measureBehavior(REPO_ROOT);
    expect(Object.keys(m)).not.toContain('gateRejections');
    expect(JSON.stringify(m)).not.toMatch(/gateReject/i);
  });

  it('reproduces the committed baseline numbers on this repo', () => {
    // Guards against a refactor silently changing what the baseline means.
    const m = measureBehavior(REPO_ROOT);
    expect(m.b1_totalVerdicts).toBe(160);
    expect(m.b1_requestChangesRate).toBeCloseTo(51.88, 1);
    expect(m.b2_roundsPerPhaseMean).toBeCloseTo(1.12, 2);
    expect(m.b4_roundsPerProjectMean).toBeCloseTo(3.06, 2);
  });
});
