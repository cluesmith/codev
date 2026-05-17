/**
 * Spec 746: Baked Architectural Decisions
 *
 * Verifies that the SPIR/ASPIR/AIR builder-prompts (and their codev-skeleton
 * mirrors) include the "Baked Decisions" instruction paragraph after their
 * `## Protocol` section, with carveout + contradiction-handling wording.
 *
 * Two test families:
 *   1. Grep regression: each touched file contains the required literal strings.
 *   2. Pure-addition diff: the post-change file is a strict line-superset of
 *      its captured baseline (zero removed lines, zero modified lines).
 *
 * Baselines for the 12 prompt files touched across Phases 1-3 are captured
 * under __tests__/fixtures/baselines/ before any edits and asserted against
 * here. Phases 2 and 3 extend this file with their own grep + diff tests.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Helpers
// ============================================================================

const repoRoot = path.resolve(__dirname, '../../../../..');
const baselineDir = path.resolve(__dirname, 'fixtures/baselines');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(repoRoot, relativePath), 'utf-8');
}

function readBaseline(baselineName: string): string {
  return fs.readFileSync(path.resolve(baselineDir, baselineName), 'utf-8');
}

/**
 * Assert that `current` is a pure-addition diff of `baseline` — every line of
 * the baseline appears in `current` in the same relative order, with zero
 * removed lines and zero modified lines. Additional lines in `current` are
 * permitted (those are the additions).
 *
 * Algorithm: walk both files line by line, advancing the baseline pointer only
 * when a match is found. If the current pointer reaches end-of-file before the
 * baseline pointer does, a baseline line was removed or modified — fail.
 */
function expectPureAdditionDiff(label: string, baseline: string, current: string): void {
  const baseLines = baseline.split('\n');
  const currLines = current.split('\n');
  let bi = 0;
  let ci = 0;
  while (bi < baseLines.length && ci < currLines.length) {
    if (baseLines[bi] === currLines[ci]) {
      bi++;
    }
    ci++;
  }
  if (bi < baseLines.length) {
    const missing = baseLines.slice(bi, bi + 5).join('\n');
    throw new Error(
      `${label}: pure-addition diff violated — baseline line ${bi + 1} ` +
        `("${baseLines[bi]}") not found in current file after exhausting it. ` +
        `Next ${Math.min(5, baseLines.length - bi)} missing line(s):\n${missing}`,
    );
  }
}

// ============================================================================
// Phase 1: Builder-prompt instruction (SPIR/ASPIR/AIR + skeleton)
// ============================================================================

interface BuilderPromptFile {
  label: string;
  relPath: string;
  baselineName: string | null; // null for skeleton mirrors (codev/ is the canonical baseline)
}

const PHASE_1_FILES: BuilderPromptFile[] = [
  {
    label: 'codev SPIR builder-prompt',
    relPath: 'codev/protocols/spir/builder-prompt.md',
    baselineName: 'spir-builder-prompt.md.baseline',
  },
  {
    label: 'codev ASPIR builder-prompt',
    relPath: 'codev/protocols/aspir/builder-prompt.md',
    baselineName: 'aspir-builder-prompt.md.baseline',
  },
  {
    label: 'codev AIR builder-prompt',
    relPath: 'codev/protocols/air/builder-prompt.md',
    baselineName: 'air-builder-prompt.md.baseline',
  },
  {
    label: 'skeleton SPIR builder-prompt',
    relPath: 'codev-skeleton/protocols/spir/builder-prompt.md',
    baselineName: null,
  },
  {
    label: 'skeleton ASPIR builder-prompt',
    relPath: 'codev-skeleton/protocols/aspir/builder-prompt.md',
    baselineName: null,
  },
  {
    label: 'skeleton AIR builder-prompt',
    relPath: 'codev-skeleton/protocols/air/builder-prompt.md',
    baselineName: null,
  },
];

describe('Spec 746 Phase 1: builder-prompt baked-decisions instruction', () => {
  describe('grep regression: required strings present in each file', () => {
    for (const file of PHASE_1_FILES) {
      describe(file.label, () => {
        const content = readRepoFile(file.relPath);

        it('contains the "Baked Decisions" heading', () => {
          expect(content).toContain('## Baked Decisions');
        });

        it('uses the carveout phrasing "do not autonomously"', () => {
          expect(content.toLowerCase()).toContain('do not autonomously');
        });

        it('addresses contradictions with "contradict" + "pause"', () => {
          const lower = content.toLowerCase();
          expect(lower).toContain('contradict');
          expect(lower).toContain('pause');
        });

        it('mentions the `afx send` escalation path', () => {
          expect(content).toContain('afx send');
        });
      });
    }
  });

  describe('pure-addition diff: baseline lines are preserved in order', () => {
    for (const file of PHASE_1_FILES) {
      if (file.baselineName === null) continue; // skeleton mirrors don't have a baseline; codev/ is the source of truth
      it(`${file.label}: post-edit file is a pure-addition diff of its baseline`, () => {
        const baseline = readBaseline(file.baselineName!);
        const current = readRepoFile(file.relPath);
        expectPureAdditionDiff(file.label, baseline, current);
      });
    }
  });

  it('codev SPIR builder-prompt baseline does NOT contain the new heading (pollution check)', () => {
    // Catches the failure mode where the baseline was captured AFTER an edit.
    const baseline = readBaseline('spir-builder-prompt.md.baseline');
    expect(baseline).not.toContain('## Baked Decisions');
  });

  // Mirror-parity for the Baked Decisions paragraph specifically.
  //
  // The codev/ and codev-skeleton/ copies of each builder-prompt have
  // pre-existing structural differences outside this work's scope (skeleton
  // has Multi-PR Workflow / Verify Phase sections that codev/ doesn't, and
  // a different PR-merged notification string). Those are PRE-EXISTING and
  // not Phase 1's responsibility to reconcile.
  //
  // What IS Phase 1's responsibility: ensure the Baked Decisions paragraph
  // itself is byte-identical across both copies, so future drift in this
  // paragraph (e.g., someone edits codev/ but forgets skeleton) is caught.
  describe('baked-decisions paragraph is byte-identical across codev/ and skeleton', () => {
    const PROTOCOLS = ['spir', 'aspir', 'air'] as const;
    const BAKED_HEADER = '## Baked Decisions';

    // Extract the Baked Decisions paragraph from a file's full content.
    // Returns the heading + body up to (but not including) the next heading
    // or the end of file. Throws if the heading is not found.
    function extractBakedSection(label: string, fullContent: string): string {
      const headerIdx = fullContent.indexOf(BAKED_HEADER);
      if (headerIdx === -1) {
        throw new Error(`${label}: "${BAKED_HEADER}" heading not found`);
      }
      const rest = fullContent.slice(headerIdx);
      // Find the next markdown heading line (starts with #, on its own line).
      const lines = rest.split('\n');
      const endLine = lines.findIndex(
        (line, i) => i > 0 && /^#{1,6}\s/.test(line),
      );
      const sectionLines = endLine === -1 ? lines : lines.slice(0, endLine);
      // Trim trailing blank lines so a stray newline doesn't cause false mismatches.
      while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
        sectionLines.pop();
      }
      return sectionLines.join('\n');
    }

    for (const protocol of PROTOCOLS) {
      it(`${protocol}: codev/ and skeleton Baked Decisions paragraphs match`, () => {
        const codevContent = readRepoFile(`codev/protocols/${protocol}/builder-prompt.md`);
        const skeletonContent = readRepoFile(`codev-skeleton/protocols/${protocol}/builder-prompt.md`);
        const codevSection = extractBakedSection(`codev ${protocol}`, codevContent);
        const skeletonSection = extractBakedSection(`skeleton ${protocol}`, skeletonContent);
        expect(skeletonSection).toEqual(codevSection);
      });
    }
  });
});
