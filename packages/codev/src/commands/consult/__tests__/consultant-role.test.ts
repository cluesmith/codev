/**
 * The instruction half of the #1649 fix.
 *
 * A `consult -m claude` review lane reverted three guards in a builder's
 * worktree to check whether the tests covering them were vacuous. It had the
 * capability — `allowedTools` is the Agent SDK's *auto-approve* list, not a
 * restriction, so under `permissionMode: 'bypassPermissions'` every tool
 * including `Edit` is reachable — and, more to the point, nothing had ever told
 * it not to. `consultant.md` said "You have filesystem access — use it to verify
 * your claims" and stopped there.
 *
 * The owner's decision was to fix that by instruction rather than by stripping
 * tools. That makes `consultant.md` load-bearing: it is the control. These tests
 * pin that the instruction is present, that it addresses the specific temptation
 * that caused the incident, and that it actually reaches the model.
 *
 * They assert on meaning, not on wording — each check looks for a phrase the
 * instruction cannot lose without losing its point. Rewriting the section for
 * clarity is fine; deleting the prohibition is what must fail here.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → consult → commands → src → codev → packages → repo root
const repoRoot = path.resolve(here, '../../../../../..');

const OURS = path.join(repoRoot, 'codev/roles/consultant.md');
const SKELETON = path.join(repoRoot, 'codev-skeleton/roles/consultant.md');

const read = (p: string) => fs.readFileSync(p, 'utf-8');

describe('consultant.md forbids mutating the tree under review (#1649)', () => {
  for (const [label, file] of [['our instance', OURS], ['shipped skeleton', SKELETON]] as const) {
    describe(label, () => {
      it('exists', () => {
        expect(fs.existsSync(file)).toBe(true);
      });

      it('states outright that the consultant does not modify the tree', () => {
        const text = read(file).toLowerCase();
        expect(text).toContain('never modify');
        expect(text).toMatch(/tree under review|tree you are reviewing/);
      });

      it('forbids state-changing commands, not just file edits', () => {
        // The lane can reach `Bash` too, and `git checkout` undoes a builder's
        // work just as thoroughly as an `Edit` does.
        const text = read(file).toLowerCase();
        expect(text).toMatch(/never run a command that changes state|state-changing command/);
        expect(text).toContain('git checkout');
      });

      it('closes the "I will restore it afterwards" loophole', () => {
        // The incident's lane did restore some of its edits — two of the five
        // Edit calls landed *after* the builder's first restore. Intending to
        // put it back is not a defence.
        expect(read(file).toLowerCase()).toMatch(/restore[^.]*does not make it safe|even if you intend to restore/);
      });

      it('names the vacuity check and gives a read-only way to answer it', () => {
        // This is the exact reasoning that produced the incident: "would these
        // tests still pass if the guard were gone?" Forbidding the mutation
        // without offering the alternative just leaves the reviewer stuck.
        const text = read(file).toLowerCase();
        expect(text).toContain('vacuity');
        expect(text).toMatch(/report the finding|reason about/);
      });

      it('holds even when the review prompt itself asks for an edit', () => {
        // Reproduced exactly this: a prompt saying "remove the guard with the
        // Edit tool" got four Edit calls out of the lane.
        expect(read(file).toLowerCase()).toMatch(/even when the review prompt invites it|if a prompt asks you to edit/);
      });
    });
  }

  it('keeps the two trees byte-identical', () => {
    // codev/ is our instance and codev-skeleton/ is what adopters install. An
    // instruction that only exists in one of them protects only one of them.
    expect(read(SKELETON)).toBe(read(OURS));
  });

  it('keeps the pre-existing file-access guidance it was appended to', () => {
    const text = read(OURS);
    expect(text).toContain('ALWAYS read files directly from disk');
    expect(text).toContain('# Role: Consultant');
  });
});
