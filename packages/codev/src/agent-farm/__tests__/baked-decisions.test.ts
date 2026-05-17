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
import { renderTemplate, type TemplateContext } from '../commands/spawn-roles.js';

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

  // Mirror-parity for the Baked Decisions paragraph specifically (Phase 1).
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

// ============================================================================
// Phase 2: Drafting prompts (SPIR/ASPIR specify.md + AIR implement.md + skeleton)
// ============================================================================

interface DraftingPromptFile {
  label: string;
  relPath: string;
  baselineName: string | null; // null for skeleton mirrors
}

const PHASE_2_FILES: DraftingPromptFile[] = [
  {
    label: 'codev SPIR specify.md',
    relPath: 'codev/protocols/spir/prompts/specify.md',
    baselineName: 'spir-specify.md.baseline',
  },
  {
    label: 'codev ASPIR specify.md',
    relPath: 'codev/protocols/aspir/prompts/specify.md',
    baselineName: 'aspir-specify.md.baseline',
  },
  {
    label: 'codev AIR implement.md',
    relPath: 'codev/protocols/air/prompts/implement.md',
    baselineName: 'air-implement.md.baseline',
  },
  {
    label: 'skeleton SPIR specify.md',
    relPath: 'codev-skeleton/protocols/spir/prompts/specify.md',
    baselineName: null,
  },
  {
    label: 'skeleton ASPIR specify.md',
    relPath: 'codev-skeleton/protocols/aspir/prompts/specify.md',
    baselineName: null,
  },
  {
    label: 'skeleton AIR implement.md',
    relPath: 'codev-skeleton/protocols/air/prompts/implement.md',
    baselineName: null,
  },
];

describe('Spec 746 Phase 2: drafting-prompt baked-decisions clause', () => {
  describe('grep regression: required strings present in each file', () => {
    for (const file of PHASE_2_FILES) {
      describe(file.label, () => {
        const content = readRepoFile(file.relPath);

        it('contains the literal "Baked Decisions"', () => {
          expect(content).toContain('Baked Decisions');
        });

        it('uses the carveout phrasing "do not autonomously"', () => {
          expect(content.toLowerCase()).toContain('do not autonomously');
        });

        it('addresses contradictions with "contradict" + "pause" + "flag"', () => {
          const lower = content.toLowerCase();
          expect(lower).toContain('contradict');
          expect(lower).toContain('pause');
          expect(lower).toContain('flag');
        });

        it('mentions the `afx send` escalation path', () => {
          expect(content).toContain('afx send');
        });
      });
    }
  });

  describe('pure-addition diff: baseline lines preserved in order', () => {
    for (const file of PHASE_2_FILES) {
      if (file.baselineName === null) continue;
      it(`${file.label}: post-edit file is a pure-addition diff of its baseline`, () => {
        const baseline = readBaseline(file.baselineName!);
        const current = readRepoFile(file.relPath);
        expectPureAdditionDiff(file.label, baseline, current);
      });
    }
  });

  describe('baked-decisions clause is byte-identical across codev/ and skeleton', () => {
    interface MirrorPair {
      protocol: string;
      codev: string;
      skeleton: string;
    }
    const PAIRS: MirrorPair[] = [
      {
        protocol: 'spir specify.md',
        codev: 'codev/protocols/spir/prompts/specify.md',
        skeleton: 'codev-skeleton/protocols/spir/prompts/specify.md',
      },
      {
        protocol: 'aspir specify.md',
        codev: 'codev/protocols/aspir/prompts/specify.md',
        skeleton: 'codev-skeleton/protocols/aspir/prompts/specify.md',
      },
      {
        protocol: 'air implement.md',
        codev: 'codev/protocols/air/prompts/implement.md',
        skeleton: 'codev-skeleton/protocols/air/prompts/implement.md',
      },
    ];

    // Extract the paragraph containing "Baked Decisions" — from the first line
    // matching it up to the next markdown heading. Works whether the heading
    // is `## Baked Decisions` (AIR), `### 0.5 Baked Decisions` (SPIR/ASPIR),
    // or any other variant the architect might write.
    function extractBakedClause(label: string, fullContent: string): string {
      const lines = fullContent.split('\n');
      const startIdx = lines.findIndex(line => /Baked Decisions/i.test(line));
      if (startIdx === -1) {
        throw new Error(`${label}: no line containing "Baked Decisions" found`);
      }
      // Find the next markdown heading after the start line.
      const endIdx = lines.findIndex(
        (line, i) => i > startIdx && /^#{1,6}\s/.test(line),
      );
      const sectionLines = endIdx === -1 ? lines.slice(startIdx) : lines.slice(startIdx, endIdx);
      while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
        sectionLines.pop();
      }
      return sectionLines.join('\n');
    }

    for (const pair of PAIRS) {
      it(`${pair.protocol}: codev/ and skeleton clauses match`, () => {
        const codevContent = readRepoFile(pair.codev);
        const skeletonContent = readRepoFile(pair.skeleton);
        const codevClause = extractBakedClause(`codev ${pair.protocol}`, codevContent);
        const skeletonClause = extractBakedClause(`skeleton ${pair.protocol}`, skeletonContent);
        expect(skeletonClause).toEqual(codevClause);
      });
    }
  });

  it('codev SPIR specify.md baseline does NOT contain "Baked Decisions" (pollution check)', () => {
    const baseline = readBaseline('spir-specify.md.baseline');
    expect(baseline).not.toContain('Baked Decisions');
  });
});

// ============================================================================
// Phase 3: Reviewer prompts (spec-review / plan-review / impl-review / pr-review + skeleton)
// ============================================================================

interface ReviewerPromptFile {
  label: string;
  relPath: string;
  baselineName: string | null;
}

const PHASE_3_FILES: ReviewerPromptFile[] = [
  {
    label: 'codev SPIR spec-review',
    relPath: 'codev/protocols/spir/consult-types/spec-review.md',
    baselineName: 'spir-spec-review.md.baseline',
  },
  {
    label: 'codev ASPIR spec-review',
    relPath: 'codev/protocols/aspir/consult-types/spec-review.md',
    baselineName: 'aspir-spec-review.md.baseline',
  },
  {
    label: 'codev SPIR plan-review',
    relPath: 'codev/protocols/spir/consult-types/plan-review.md',
    baselineName: 'spir-plan-review.md.baseline',
  },
  {
    label: 'codev ASPIR plan-review',
    relPath: 'codev/protocols/aspir/consult-types/plan-review.md',
    baselineName: 'aspir-plan-review.md.baseline',
  },
  {
    label: 'codev AIR impl-review',
    relPath: 'codev/protocols/air/consult-types/impl-review.md',
    baselineName: 'air-impl-review.md.baseline',
  },
  {
    label: 'codev AIR pr-review',
    relPath: 'codev/protocols/air/consult-types/pr-review.md',
    baselineName: 'air-pr-review.md.baseline',
  },
  {
    label: 'skeleton SPIR spec-review',
    relPath: 'codev-skeleton/protocols/spir/consult-types/spec-review.md',
    baselineName: null,
  },
  {
    label: 'skeleton ASPIR spec-review',
    relPath: 'codev-skeleton/protocols/aspir/consult-types/spec-review.md',
    baselineName: null,
  },
  {
    label: 'skeleton SPIR plan-review',
    relPath: 'codev-skeleton/protocols/spir/consult-types/plan-review.md',
    baselineName: null,
  },
  {
    label: 'skeleton ASPIR plan-review',
    relPath: 'codev-skeleton/protocols/aspir/consult-types/plan-review.md',
    baselineName: null,
  },
  {
    label: 'skeleton AIR impl-review',
    relPath: 'codev-skeleton/protocols/air/consult-types/impl-review.md',
    baselineName: null,
  },
  {
    label: 'skeleton AIR pr-review',
    relPath: 'codev-skeleton/protocols/air/consult-types/pr-review.md',
    baselineName: null,
  },
];

describe('Spec 746 Phase 3: reviewer-prompt baked-decisions clause', () => {
  // Extract the `## Baked Decisions` section from a reviewer-prompt file so
  // that the grep assertions below scope to the new paragraph specifically.
  //
  // This matters because the pre-existing `## Verdict Format` section in all
  // 6 reviewer prompts already contains the literal strings `COMMENT` and
  // `REQUEST_CHANGES`. A file-level `toContain` check would pass even if the
  // new Baked Decisions paragraph lost those tokens, defeating the regression.
  //
  // Fix per Codex Phase 3 iter-1 feedback: extract the section first, assert
  // against the section only.
  function extractBakedSection(label: string, fullContent: string): string {
    const headerIdx = fullContent.indexOf('## Baked Decisions');
    if (headerIdx === -1) {
      throw new Error(`${label}: "## Baked Decisions" heading not found`);
    }
    const rest = fullContent.slice(headerIdx);
    const lines = rest.split('\n');
    const endLine = lines.findIndex(
      (line, i) => i > 0 && /^#{1,6}\s/.test(line),
    );
    const sectionLines = endLine === -1 ? lines : lines.slice(0, endLine);
    while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
      sectionLines.pop();
    }
    return sectionLines.join('\n');
  }

  describe('grep regression: required content present in the extracted Baked Decisions section', () => {
    for (const file of PHASE_3_FILES) {
      describe(file.label, () => {
        const content = readRepoFile(file.relPath);
        const section = extractBakedSection(file.label, content);

        it('contains the literal "Baked Decisions" heading (file-level)', () => {
          expect(content).toContain('## Baked Decisions');
        });

        it('section uses the carveout phrasing "do not autonomously"', () => {
          expect(section.toLowerCase()).toContain('do not autonomously');
        });

        it('section distinguishes COMMENT from REQUEST_CHANGES (not just the file)', () => {
          // Both tokens must appear *inside* the Baked Decisions paragraph —
          // not just in the pre-existing Verdict Format section elsewhere.
          expect(section).toContain('COMMENT');
          expect(section).toContain('REQUEST_CHANGES');
        });

        it('section addresses contradictions with "contradict" + "clarify"', () => {
          const lower = section.toLowerCase();
          expect(lower).toContain('contradict');
          expect(lower).toContain('clarify');
        });
      });
    }
  });

  describe('pure-addition diff: baseline lines preserved in order', () => {
    for (const file of PHASE_3_FILES) {
      if (file.baselineName === null) continue;
      it(`${file.label}: post-edit file is a pure-addition diff of its baseline`, () => {
        const baseline = readBaseline(file.baselineName!);
        const current = readRepoFile(file.relPath);
        expectPureAdditionDiff(file.label, baseline, current);
      });
    }
  });

  describe('baked-decisions clause is byte-identical across codev/ and skeleton', () => {
    interface MirrorPair {
      protocol: string;
      codev: string;
      skeleton: string;
    }
    const PAIRS: MirrorPair[] = [
      {
        protocol: 'spir spec-review',
        codev: 'codev/protocols/spir/consult-types/spec-review.md',
        skeleton: 'codev-skeleton/protocols/spir/consult-types/spec-review.md',
      },
      {
        protocol: 'aspir spec-review',
        codev: 'codev/protocols/aspir/consult-types/spec-review.md',
        skeleton: 'codev-skeleton/protocols/aspir/consult-types/spec-review.md',
      },
      {
        protocol: 'spir plan-review',
        codev: 'codev/protocols/spir/consult-types/plan-review.md',
        skeleton: 'codev-skeleton/protocols/spir/consult-types/plan-review.md',
      },
      {
        protocol: 'aspir plan-review',
        codev: 'codev/protocols/aspir/consult-types/plan-review.md',
        skeleton: 'codev-skeleton/protocols/aspir/consult-types/plan-review.md',
      },
      {
        protocol: 'air impl-review',
        codev: 'codev/protocols/air/consult-types/impl-review.md',
        skeleton: 'codev-skeleton/protocols/air/consult-types/impl-review.md',
      },
      {
        protocol: 'air pr-review',
        codev: 'codev/protocols/air/consult-types/pr-review.md',
        skeleton: 'codev-skeleton/protocols/air/consult-types/pr-review.md',
      },
    ];

    for (const pair of PAIRS) {
      it(`${pair.protocol}: codev/ and skeleton sections match`, () => {
        const codevContent = readRepoFile(pair.codev);
        const skeletonContent = readRepoFile(pair.skeleton);
        // Reuse the same extractBakedSection helper defined at the top of this describe.
        const codevSection = extractBakedSection(`codev ${pair.protocol}`, codevContent);
        const skeletonSection = extractBakedSection(`skeleton ${pair.protocol}`, skeletonContent);
        expect(skeletonSection).toEqual(codevSection);
      });
    }
  });

  it('codev SPIR spec-review baseline does NOT contain "Baked Decisions" (pollution check)', () => {
    const baseline = readBaseline('spir-spec-review.md.baseline');
    expect(baseline).not.toContain('Baked Decisions');
  });
});

// ============================================================================
// Phase 4: Protocol documentation paragraphs + final regression sweep
// ============================================================================

interface ProtocolDocFile {
  label: string;
  relPath: string;
}

const PHASE_4_FILES: ProtocolDocFile[] = [
  { label: 'codev SPIR protocol.md', relPath: 'codev/protocols/spir/protocol.md' },
  { label: 'codev ASPIR protocol.md', relPath: 'codev/protocols/aspir/protocol.md' },
  { label: 'codev AIR protocol.md', relPath: 'codev/protocols/air/protocol.md' },
  { label: 'skeleton SPIR protocol.md', relPath: 'codev-skeleton/protocols/spir/protocol.md' },
  { label: 'skeleton ASPIR protocol.md', relPath: 'codev-skeleton/protocols/aspir/protocol.md' },
  { label: 'skeleton AIR protocol.md', relPath: 'codev-skeleton/protocols/air/protocol.md' },
];

describe('Spec 746 Phase 4: protocol documentation discoverability paragraph', () => {
  describe('grep regression: required content present in each protocol.md', () => {
    for (const file of PHASE_4_FILES) {
      describe(file.label, () => {
        const content = readRepoFile(file.relPath);

        it('contains the "Baked Decisions" keyword', () => {
          expect(content).toContain('Baked Decisions');
        });

        it('mentions category hints (language + framework + dependencies)', () => {
          const lower = content.toLowerCase();
          expect(lower).toContain('language');
          expect(lower).toContain('framework');
          expect(lower).toContain('dependencies');
        });

        it('documents the amend/rescind escape hatch', () => {
          const lower = content.toLowerCase();
          // Either "amend" or "rescind" + a way to do it ("respawn" or "afx send")
          expect(lower).toMatch(/amend|rescind/);
          expect(lower).toMatch(/respawn|afx send/);
        });

        it('describes the absence default explicitly', () => {
          expect(content.toLowerCase()).toContain('no-op default');
        });
      });
    }
  });

  describe('discoverability paragraph is byte-identical across codev/ and skeleton', () => {
    interface DocPair {
      protocol: string;
      codev: string;
      skeleton: string;
    }
    const PAIRS: DocPair[] = [
      {
        protocol: 'spir protocol.md',
        codev: 'codev/protocols/spir/protocol.md',
        skeleton: 'codev-skeleton/protocols/spir/protocol.md',
      },
      {
        protocol: 'aspir protocol.md',
        codev: 'codev/protocols/aspir/protocol.md',
        skeleton: 'codev-skeleton/protocols/aspir/protocol.md',
      },
      {
        protocol: 'air protocol.md',
        codev: 'codev/protocols/air/protocol.md',
        skeleton: 'codev-skeleton/protocols/air/protocol.md',
      },
    ];

    function extractBakedDocsSection(label: string, fullContent: string): string {
      const headerIdx = fullContent.indexOf('## Baked Decisions');
      if (headerIdx === -1) {
        throw new Error(`${label}: "## Baked Decisions" heading not found`);
      }
      const rest = fullContent.slice(headerIdx);
      const lines = rest.split('\n');
      const endLine = lines.findIndex(
        (line, i) => i > 0 && /^#{1,6}\s/.test(line),
      );
      const sectionLines = endLine === -1 ? lines : lines.slice(0, endLine);
      while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
        sectionLines.pop();
      }
      return sectionLines.join('\n');
    }

    for (const pair of PAIRS) {
      it(`${pair.protocol}: codev/ and skeleton sections match`, () => {
        const codevContent = readRepoFile(pair.codev);
        const skeletonContent = readRepoFile(pair.skeleton);
        const codevSection = extractBakedDocsSection(`codev ${pair.protocol}`, codevContent);
        const skeletonSection = extractBakedDocsSection(`skeleton ${pair.protocol}`, skeletonContent);
        expect(skeletonSection).toEqual(codevSection);
      });
    }
  });
});

// ============================================================================
// Phase 4 final sweep: every touched file has the required content,
// and codev/ ↔ skeleton parity holds for the Baked Decisions sections of all 21 files.
// ============================================================================

describe('Spec 746 Phase 4 final sweep: end-to-end regression check', () => {
  // All 30 files touched across Phases 1-4:
  // - Phase 1: 3 codev + 3 skeleton builder-prompts (6)
  // - Phase 2: 3 codev + 3 skeleton drafting prompts (6)
  // - Phase 3: 6 codev + 6 skeleton reviewer prompts (12)
  // - Phase 4: 3 codev + 3 skeleton protocol.md (6)
  const ALL_TOUCHED_FILES = [
    // Phase 1
    'codev/protocols/spir/builder-prompt.md',
    'codev/protocols/aspir/builder-prompt.md',
    'codev/protocols/air/builder-prompt.md',
    'codev-skeleton/protocols/spir/builder-prompt.md',
    'codev-skeleton/protocols/aspir/builder-prompt.md',
    'codev-skeleton/protocols/air/builder-prompt.md',
    // Phase 2
    'codev/protocols/spir/prompts/specify.md',
    'codev/protocols/aspir/prompts/specify.md',
    'codev/protocols/air/prompts/implement.md',
    'codev-skeleton/protocols/spir/prompts/specify.md',
    'codev-skeleton/protocols/aspir/prompts/specify.md',
    'codev-skeleton/protocols/air/prompts/implement.md',
    // Phase 3
    'codev/protocols/spir/consult-types/spec-review.md',
    'codev/protocols/aspir/consult-types/spec-review.md',
    'codev/protocols/spir/consult-types/plan-review.md',
    'codev/protocols/aspir/consult-types/plan-review.md',
    'codev/protocols/air/consult-types/impl-review.md',
    'codev/protocols/air/consult-types/pr-review.md',
    'codev-skeleton/protocols/spir/consult-types/spec-review.md',
    'codev-skeleton/protocols/aspir/consult-types/spec-review.md',
    'codev-skeleton/protocols/spir/consult-types/plan-review.md',
    'codev-skeleton/protocols/aspir/consult-types/plan-review.md',
    'codev-skeleton/protocols/air/consult-types/impl-review.md',
    'codev-skeleton/protocols/air/consult-types/pr-review.md',
    // Phase 4
    'codev/protocols/spir/protocol.md',
    'codev/protocols/aspir/protocol.md',
    'codev/protocols/air/protocol.md',
    'codev-skeleton/protocols/spir/protocol.md',
    'codev-skeleton/protocols/aspir/protocol.md',
    'codev-skeleton/protocols/air/protocol.md',
  ];

  it('30 files were touched across Phases 1-4 (sanity check on the inventory)', () => {
    expect(ALL_TOUCHED_FILES.length).toBe(30);
  });

  describe('cross-phase: every touched file contains "Baked Decisions"', () => {
    for (const relPath of ALL_TOUCHED_FILES) {
      it(relPath, () => {
        const content = readRepoFile(relPath);
        expect(content).toContain('Baked Decisions');
      });
    }
  });
});

// ============================================================================
// Phase 4 end-to-end smoke: render each builder-prompt against a fixture
// issue whose body contains a `## Baked Decisions` section. Verify the
// rendered prompt contains BOTH (1) the Phase 1 instruction paragraph and
// (2) the issue's baked-decisions content verbatim (via {{issue.body}}).
//
// This converts the plan's "manual smoke" deliverable into an automated
// regression test — strictly better than a one-time check at PR time.
// Codex Phase 4 iter-1 flagged the missing smoke evidence; this closes it.
// ============================================================================

describe('Spec 746 end-to-end smoke: builder-prompt rendering with baked-decisions issue', () => {
  const FIXTURE_ISSUE_BODY = [
    '## Background',
    '',
    'We want a persona harness.',
    '',
    '## Baked Decisions',
    '',
    '- Language: Python (match shanutil)',
    '- Framework: minimal stdlib',
    '',
    '## Done When',
    '',
    'It works.',
  ].join('\n');

  function makeContext(protocolName: string): TemplateContext {
    return {
      protocol_name: protocolName.toUpperCase(),
      mode: 'strict',
      mode_soft: false,
      mode_strict: true,
      project_id: '999',
      input_description: 'a test feature',
      issue: {
        number: 999,
        title: 'Test issue with baked decisions',
        body: FIXTURE_ISSUE_BODY,
      },
    };
  }

  for (const protocol of ['spir', 'aspir', 'air']) {
    describe(`${protocol} builder-prompt`, () => {
      const templatePath = path.resolve(repoRoot, `codev/protocols/${protocol}/builder-prompt.md`);
      const template = fs.readFileSync(templatePath, 'utf-8');
      const ctx = makeContext(protocol);
      const rendered = renderTemplate(template, ctx);

      it('rendered prompt contains the Phase 1 instruction paragraph', () => {
        expect(rendered).toContain('## Baked Decisions');
        expect(rendered.toLowerCase()).toContain('do not autonomously override');
      });

      it('rendered prompt contains the issue body verbatim, including its baked-decisions section', () => {
        expect(rendered).toContain('## Background');
        // The issue's own "## Baked Decisions" heading + content reaches the builder.
        expect(rendered).toContain('Language: Python (match shanutil)');
        expect(rendered).toContain('Framework: minimal stdlib');
      });

      it('rendered prompt does NOT contain "{{" handlebars residue (template fully rendered)', () => {
        expect(rendered).not.toContain('{{');
        expect(rendered).not.toContain('}}');
      });
    });
  }

  describe('absence default: rendering with an issue that has no baked-decisions section', () => {
    const PLAIN_ISSUE_BODY = '## Background\n\nA boring feature.\n\n## Done When\n\nIt ships.';

    for (const protocol of ['spir', 'aspir', 'air']) {
      it(`${protocol} builder-prompt: instruction paragraph is still present (it's unconditional)`, () => {
        const template = fs.readFileSync(
          path.resolve(repoRoot, `codev/protocols/${protocol}/builder-prompt.md`),
          'utf-8',
        );
        const ctx: TemplateContext = {
          protocol_name: protocol.toUpperCase(),
          mode: 'strict',
          mode_soft: false,
          mode_strict: true,
          project_id: '999',
          input_description: 'a test feature',
          issue: { number: 999, title: 'Plain issue', body: PLAIN_ISSUE_BODY },
        };
        const rendered = renderTemplate(template, ctx);
        // The instruction paragraph fires on EVERY render. Builders see it even
        // when no baked-decisions section is present — it's a no-op for them.
        // This is intentional: the prompt teaches the convention.
        expect(rendered).toContain('## Baked Decisions');
        expect(rendered).not.toContain('Language: Python'); // no fixture content present
      });
    }
  });
});
