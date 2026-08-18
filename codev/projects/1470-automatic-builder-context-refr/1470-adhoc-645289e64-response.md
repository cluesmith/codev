# Ad-hoc adversarial review of commit `645289e64` — findings and response

**Why this exists.** Porch force-advanced Phase 4 at its iteration ceiling, so six fixes shipped
without a CMAP round. The architect ruled against a porch rollback and ordered an ad-hoc consult
outside porch instead, scoped to that commit and framed adversarially: *can the regression still go
unobserved, and does `--dry-run` now report every side effect the real run would perform, in order?*

Reviewers: Codex and Claude. Raw outputs are gitignored like every consult output in this repo;
this is the committed record, matching the convention of the per-iteration rebuttals.

**Headline: the consult found a bypass in a safety check I had added roughly an hour earlier, two
inaccuracies in the rehearsal's own reporting, two fixes with no assertions at all, and — the
sharpest finding — that my de-duplication had protected one of three doors.**

---

## HIGH — the containment check was a string test, not a path test *(Codex)*

`resolve(process.cwd()).startsWith(resolve(builder.worktree))` is not path containment.

```
builder.worktree = /a/b
cwd              = /a/b-other      →  "/a/b-other".startsWith("/a/b") === true
```

So a registry row pointing at a **prefix sibling** sailed through the guard added specifically to
catch mismatched rows. Verified in node before changing anything. It also **falsely refuses**
legitimate runs when the registry records one spelling of a path and `process.cwd()` reports
another — a symlinked worktree versus its physical target.

**Fixed** with `isInside()`: `realpathSync` both sides, then `relative()` — component-wise rather
than character-wise, with a lexical fallback so a path that does not exist yet produces a sensible
answer instead of an exception.

Tested against **real directories**: the directory itself, a subdirectory, a prefix sibling, a
parent, an unrelated tree, a symlink in both directions, and a missing path. The prefix-sibling test
carries a control asserting that `startsWith` **would** have accepted it, so the test cannot quietly
stop discriminating if the predicate is rewritten later.

## The sharpest finding — "fix 1 protects one of three doors" *(Claude)*

Exporting `buildContextFsPort()` closed the copied-binding hole **for one call site**. There were
three hand-rolled copies of the identical port:

| Location | Path |
|---|---|
| driven refresh | `commands/reset.ts` |
| Tower harness detection | `servers/mailbox-wiring.ts` |
| self-refresh | `commands/self-refresh.ts` |

A stub in **any** of them silently nulls the porch context for that path, and a regression test can
only observe the copy it imports. My fix protected my door and left two open.

**Consolidated to one implementation**, moved to `reset/context.ts` — beside the `ContextFsPort`
interface it implements — so a Tower server does not have to import a command module to obtain it.
`grep -rn "listDirs: (p"` over `src/` now returns exactly one hit.

This is the fourth appearance of one pattern on this project: nonce *type* fixed while *length* stayed
open; stability window validated while three sibling parameters were not; porch task text fixed while
the CLI follow-up still dropped the flag; and now one fs port fixed while two copies remained. **The
cure that works is not vigilance — it is making the thing singular so there is nowhere else to
look.**

## MEDIUM — the dry-run action list was wrong in two ways *(Codex)*

It reported four actions; the real run performs five. The omission was the **challenge rewrite**,
which is a pre-clear write and the thing that makes a challenge single-use — safety-critical, not
housekeeping. And it said "WOULD DELETE" for a deletion that is best-effort and whose failure is
deliberately swallowed.

Reporting four of five mutations tells a reader the rehearsal covers everything. **Fixed** to the
true five-step order with accurate verbs, including "WOULD ATTEMPT TO DELETE".

## MEDIUM — "this refresh WOULD proceed" overstated the rehearsal *(Codex)*

A dry run stops before the re-orientation write, Tower scheduling, the challenge rewrite, the clear
and the deletion — so it cannot speak for any of them. It establishes that non-mutating preflight
passes, which is genuinely useful and is a different claim.

**Fixed**: "passed all non-mutating preflight checks", with a second line naming what was and was
not exercised.

## Two fixes had no assertions at all *(Codex's non-vacuity table)*

The most useful single artifact of the review: a table going fix by fix, asking whether reverting it
would fail a test. Two would not have.

- **The dry-run action list** — behaviour changed, nothing asserted.
- **The illustrative-nonce warning** — behaviour changed, nothing asserted.

I had described both in a rebuttal as though they were covered. Both are now asserted, including the
ordering of the action list and the position of the challenge rewrite between the re-entry and the
clear.

Codex also judged the parser positive control weaker than it should be: it excluded only `EXIT:1`
rather than requiring `error === undefined` **and** that the command body ran. Tightened.

## Also taken

- **`?? 15` hardcoded in the dry-run delay line** *(Claude)*. Phase 8 is scheduled to set
  `DEFAULT_REENTRY_DELAY_SECONDS` from a live measurement, and a hardcoded default would have begun
  lying the moment it did. Now references the constant.
- **Test cwd is now a subdirectory** (`.../spir-1470/packages/codev`) rather than the worktree root,
  which exercises the documented "may run from a subdirectory" behaviour the earlier fixture left
  uncovered.

## What the reviewers confirmed holds

Worth recording, since these reviews mostly surface defects:

- Importing `buildContextFsPort()` genuinely closes the copied-binding hole for the call site it
  covers, and the mutation proves it.
- The dry-run actions are in true chronological order, and nothing is reported that the real run does
  not do — the omission was one-directional.
- Mocking `process.cwd()` was the right repair; relaxing the check to suit a fixture that was lying
  about where it ran would have been the worse fix.
- The containment check's *intent* is correct and worth keeping. Only the comparator was wrong.

---

## Net

1 bypass closed in a safety check, 1 three-way duplication collapsed to one implementation, 2
reporting inaccuracies corrected, 2 untested fixes given assertions, 2 smaller items. New test file
for containment (7 tests); command tests 48 → 51. Full suite 5163 green.

Every ad-hoc consult on this project has found something real, which is now a strong enough pattern
to state plainly: **the reviews are not catching my sloppiness, they are catching the class of defect
that unit tests structurally cannot see** — a caller's assumptions, a duplicated safety detail, a
rehearsal's honesty, a comparator that is subtly the wrong operation. Those are exactly the defects
that survive a green suite.
