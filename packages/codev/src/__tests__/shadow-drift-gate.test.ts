/**
 * Shadow-drift CI gate (Spec 1252, M2 / T5).
 *
 * ## Why this exists
 *
 * `protocol-drift-audit` (#1210) has detected shadow drift since it shipped, and
 * `codev doctor` has been reporting it. Nobody read it. Seventeen framework
 * files drifted anyway — including `protocols/spir/builder-prompt.md`, whose
 * served copy lost the `Verify Phase` and `Multi-PR Mechanics` sections, so
 * every SPIR builder spawned in this repo was missing its verify instructions
 * while adopters got them.
 *
 * The gap was never detection. It was that nothing FAILED. This gate is the
 * missing half: it turns the existing audit into a build-breaking check.
 *
 * It deliberately does NOT reimplement detection — it calls
 * `auditProtocolDrift()` and adjudicates the result against an explicit
 * allowlist.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { auditProtocolDrift, FRAMEWORK_DRIFT_DIRS } from '../lib/protocol-drift-audit.js';
import { getSkeletonDir, listSkeletonFiles, findWorkspaceRoot } from '../lib/skeleton.js';
import {
  SHADOW_DRIFT_ALLOWLIST,
  ALLOWLISTED_PATHS,
  type AllowEntry,
} from './fixtures/shadow-drift-allowlist.js';

const WORKSPACE_ROOT = findWorkspaceRoot(path.resolve(__dirname, '../../../..'));

/** Findings that represent real divergence from the skeleton. */
function differingFindings(root: string) {
  return auditProtocolDrift(root).filter((f) => f.status === 'differs');
}

describe('shadow-drift gate (M2)', () => {
  it('reports no un-adjudicated drift in this workspace', () => {
    const unexpected = differingFindings(WORKSPACE_ROOT)
      .filter((f) => !ALLOWLISTED_PATHS.has(f.relativePath))
      .map((f) => `${f.tier}/${f.relativePath}`);

    expect(
      unexpected,
      unexpected.length
        ? `Un-adjudicated shadow drift.\n\n` +
            `These project-local copies differ from the installed skeleton and are not in\n` +
            `the allowlist:\n` +
            unexpected.map((p) => `  - ${p}`).join('\n') +
            `\n\nEither reconcile them to the skeleton (decision D1 — the skeleton is\n` +
            `authoritative), or add an allowlist entry WITH a justification if a human\n` +
            `has adjudicated the divergence. Do not add an entry merely to go green.\n`
        : undefined
    ).toEqual([]);
  });

  it('every allowlist entry carries a non-empty justification', () => {
    const unjustified = SHADOW_DRIFT_ALLOWLIST.filter((e: AllowEntry) => !e.note?.trim());
    expect(unjustified.map((e) => e.relativePath)).toEqual([]);
  });

  it('allowlist contains no stale entries for files that no longer drift', () => {
    // An entry that outlives its drift is how an allowlist silently becomes
    // permanent. Once a file is reconciled, its entry must be removed.
    const actuallyDrifting = new Set(
      differingFindings(WORKSPACE_ROOT).map((f) => f.relativePath)
    );
    const stale = SHADOW_DRIFT_ALLOWLIST.filter(
      (e) => !actuallyDrifting.has(e.relativePath)
    ).map((e) => e.relativePath);

    expect(
      stale,
      stale.length
        ? `Stale allowlist entries — these files no longer differ from the skeleton, ` +
            `so their entries must be deleted:\n` + stale.map((p) => `  - ${p}`).join('\n')
        : undefined
    ).toEqual([]);
  });

  /**
   * A gate that has only ever seen a clean tree is indistinguishable from a
   * no-op. This proves it bites: seed a real divergence in a temp workspace and
   * require the audit to catch it.
   */
  it('BITES: a seeded divergence is detected as drift', () => {
    const rel = listSkeletonFiles(FRAMEWORK_DRIFT_DIRS[0]).find((f) => f.endsWith('.md'));
    expect(rel, 'skeleton has no framework .md files — build the skeleton first').toBeTruthy();

    const root = fs.mkdtempSync(path.join(tmpdir(), 'codev-drift-gate-'));
    try {
      const skeletonBytes = fs.readFileSync(path.join(getSkeletonDir(), rel!));

      // (a) A byte-identical copy must NOT be reported as drift.
      const local = path.join(root, 'codev', rel!);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, skeletonBytes);
      expect(differingFindings(root).map((f) => f.relativePath)).toEqual([]);

      // (b) One mutated byte must be.
      fs.writeFileSync(local, Buffer.concat([skeletonBytes, Buffer.from('\n<!-- drift -->\n')]));
      expect(differingFindings(root).map((f) => f.relativePath)).toContain(rel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Phase-3 lifecycle guard (M2, per Gemini's iteration-2 review).
   *
   * PENDING_RECONCILE is a Phase-1-only concession. Once Phase 3 has reconciled
   * the 17 drifted files, no such entry may remain — otherwise the allowlist
   * becomes the permanent exemption it was designed to prevent.
   *
   * Enable by flipping PHASE_3_COMPLETE in Phase 3's commit.
   */
  const PHASE_3_COMPLETE = false;

  it.skipIf(!PHASE_3_COMPLETE)(
    'after Phase 3, no PENDING_RECONCILE entries remain',
    () => {
      const pending = SHADOW_DRIFT_ALLOWLIST.filter(
        (e) => e.reason === 'PENDING_RECONCILE'
      ).map((e) => e.relativePath);
      expect(
        pending,
        `Phase 3 is complete, so every PENDING_RECONCILE entry must be gone. ` +
          `Only ESCALATED (open M11 adjudication) or TS3_RETAINED entries may remain.`
      ).toEqual([]);
    }
  );
});
