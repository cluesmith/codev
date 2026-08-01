# Phase 2 — Three role files (G6, G3, G5)

**Decisions**: 3 · **Rollback groups**: G6 (architect), G3 (builder), G5 (consultant) —
**three group-pure commits**, so a G3 revert cannot pull architect work out with it.
**Suite**: green · **Build**: rerun before testing (`copy-skeleton`).

## Batch 1 — 6 files

| File | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `codev/roles/architect.md` | 2048 | 807 | P1, P4, P7 | Command walkthroughs → the `afx`/`porch`/`consult` skills that already own them. Risk-triage table, PRFT contract, UX-verification rule and boundaries kept. |
| `codev-skeleton/roles/architect.md` | 2048 | 807 | P1, P4, P7 | Byte-identical twin. |
| `codev/roles/builder.md` | 1837 | 849 | P1, P7 | Mode contract, gates, deliverables, thread, notifications, wait discipline, worktree path discipline, scope, flaky-test rule all kept. Numbered "core loop" walkthroughs and repeated ALL-CAPS prohibitions deleted. |
| `codev-skeleton/roles/builder.md` | 1837 | 849 | P1, P7 | Byte-identical twin. |
| `codev/roles/consultant.md` | 252 | 252 | none | **Inspected, unchanged.** Already conformant — states a contract, not a procedure. Under the acceptance model a conformant file passes *as-is*; shrinking it further would be size-chasing, which the charter amendment explicitly rejects. |
| `codev-skeleton/roles/consultant.md` | 252 | 252 | none | Unchanged. |

- `ALWAYS_ON_WORDS`: 29,833 → **28,844** (−989; SPIR spawn 6,364 → 5,371)
- `ALWAYS_ON(architect)`: 8,599 → **2,914**
- `TOTAL_AUTHORED_WORDS`: 148,925 → **144,373**

**Deleted vs relocated (M0c): all deletion, no relocation.** The command walkthroughs were not
moved — the `afx`, `porch` and `consult` skills already carry that material, so copying it would
have created a second owner for content that has one. Authored total falls by 4,552 (both trees
× two files), more than always-on, which is what pure deletion looks like.

## Verified before cutting, not assumed

The plan flagged an open question: *is anything in `architect.md` load-bearing for
multi-architect coordination (Specs 755/786/823)?* **Answer: no.** Grepped the file for
`architect:<name>`, sibling/multi-architect language, `spawnedByArchitect`, and `whoami` —
**zero matches**. The multi-architect addressing contract lives in CLAUDE.md (kept there in
Phase 1). Recording it as checked rather than leaving the question open.

## What was deleted, and why it was safe

| Cut | Principle | Reasoning |
|---|---|---|
| Architect: `afx`/`porch`/`consult` command blocks and the 14-row Quick Reference | P4 | Each CLI has a skill that is the single owner of its flags; the role doc was a stale second copy (it still advertised `porch approve` without the `--a-human-explicitly-approved-this` flag the command now requires). |
| Architect: step-by-step "Starting a New Feature", "Monitoring Progress", "Cleanup" walkthroughs | P1 | Sequenced narration of three commands. The obligations (close the issue; clean up the worktree) survive as contract lines. |
| Architect: "Release Management" state diagram | P1, P7 | Aspirational process with no mechanism behind it in this repo. |
| Builder: the numbered "Core Loop" and "What You DON'T Do in Strict Mode" | P1, P7 | The mode table plus one sentence carries it. |
| Builder: "Getting Started" 3-step list, duplicated protocol summary | P1 | The protocol is inlined into the spawn prompt; restating it in the role doc is a second, drift-prone copy. |
| Both: ALL-CAPS repetition of prohibitions already stated once | P7 | Each prohibition survives exactly once. |

## Kept verbatim

Required scar canonicals verified byte-for-byte against
`builder/spir-1252:codev/resources/scar-rules.yaml`:

- `roles/builder.md` → `no-hand-edit-status` ✓ (and `human-gates` carried in the Gates section)
- `roles/architect.md` → `afx-from-root` ✓
- `roles/consultant.md` → none required

## M10 — assertions retired: **none**

`spec-1273-wait-discipline-docs.test.ts` (18 assertions over both role-doc copies) passes
**unmodified**. Three of its assertions initially failed against my rewrite:

| Failure | Cause | Resolution |
|---|---|---|
| `## Waiting on external work` heading missing | I had renamed it to "Waiting on work you don't control" | **Reverted my heading.** The rename bought nothing; the assertion protects that the section exists. |
| "never chain foreground poll loops" not found | **Line wrap split the phrase** across two lines | Unwrapped. |
| "queues unread until your current turn ends" not found | I had dropped the word "current" | Restored. |

In all three the *behaviour* survived the rewrite — only the strings moved. **The right response
was to adjust my prose, not Spec 1273's assertions**: the strings encode a wait-discipline
incident, preserving them cost nothing in conformance, and editing a prior spec's protection to
fit new prose is precisely the silent-erosion M10 exists to prevent.

## Hazard worth naming (third occurrence)

Reflowing prose silently breaks any string match that spans a line wrap — it has now broken
scar canonicals (Phase 1) and a prior spec's test assertions (here). **Any exact-match string in
a rewritten file must be verified after the rewrite, not assumed**, and canonicals must stay on
one line however long.

## Post-inspection fix (architect-required, same phase, G6-pure)

**Finding**: my rewrite created a cross-file contradiction. `builder.md` correctly encoded the
relay convention — *"Approval reaches you as a message from the architect. Then you run
`porch approve`; the architect does not run it for you"* — while `architect.md` kept the **old**
worked example showing the architect running
`(cd .builders/<id> && porch approve ...)`. The two roles disagreed on who the approval actor is.

`builder.md` was correct: it matches the owner's standing convention, and it is what actually
happened at both of this project's own gates — so `architect.md`'s example contradicted observed
behaviour.

**Fix** (`21ac428c`): the Gates section is now relay-shaped — read, decide, `afx send` the
approval; the builder executes against its own porch state. The
`--a-human-explicitly-approved-this` explanation is kept because the *why* is load-bearing.
architect.md 761 → 807 words: **the fix made the file longer, which is fine** — conformance is
the criterion, not size.

**Worth recording plainly**: this is the same stale-second-owner class I had just caught on the
porch-approve flag syntax, one level up — and I introduced it, by fixing one owner and leaving
the other. Catching a class of defect is not the same as being immune to it. The general form:
*when a rewrite changes a convention, every file that documents that convention is in scope,
not just the one being edited.*
