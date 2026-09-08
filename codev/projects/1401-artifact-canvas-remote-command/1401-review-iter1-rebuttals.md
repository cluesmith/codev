# Review Phase (PR-level) — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES.

Codex raised five items. Four are fixed here. The fifth is a Tower-wide concern outside this
change's scope, verified and routed to the maintainers.

## 1. Request handling on the command route

**Accepted, and out of scope for this PR.** Codex raised a Tower-wide concern about how requests
are handled. I verified it independently, and it is pre-existing rather than anything this
channel introduces: addressing it properly is an architectural change with a client migration,
and a partial measure applied to the newest route alone would not improve matters.

The spec previously characterised Tower's request handling in terms it should not have; that
wording is removed rather than restated, since this spec is not the place to describe
Tower-wide behaviour it does not own.

Raised with the architect and routed to the maintainers, tracked separately from this PR.

## 2. The live VS Code end-to-end check is incomplete

Unchanged and unclosable by a builder; see the phase 6 iteration-3 rebuttal. It is the PR's
stated blocking human check, front and centre in the body with a four-step script, and both other
reviewers describe the escalation as correct.

## 3. The branch is 9 commits behind `main`

**Fixed.** Rebased onto `origin/main` (70 commits replayed cleanly, no conflicts) and
force-pushed with lease. The branch is now 0 behind, and the full suite was re-run against the
merged state: build green, 4847 tests pass, repo-wide `check-types` clean. CI re-triggered on the
new head.

## 4. Spec and plan lack `approved` / `validated` frontmatter

**Fixed.** Both now carry the convention used by sibling artifacts (e.g. spec 1380):
`approved: 2026-08-11` with `validated: [gemini, codex, claude]`, matching the actual human gate
dates and the three consultation lanes that ran.

## 5. `webview/main.ts` claims it is excluded from type-checking

**Fixed, and this one is the root of an error I propagated.** The file's own header said it was
"intentionally excluded from the extension's `tsc` typecheck". That is half true — it is excluded
from the *host* `tsconfig.json` — but `tsconfig.webview.json` checks it and `check-types` runs
both configs.

I read that comment early on and repeated its implication in the plan, in a phase 3 rebuttal, and
in the review draft, each time overstating why the manual pass matters. A reviewer caught the
claim in phase 6; this finding caught the source. The comment now states both halves explicitly,
so the next reader does not inherit the same wrong conclusion.

## Gemini, Claude (APPROVE)

No blocking concerns. Claude's summary notes merge is conditional on the escalated live pass,
which matches the PR body.
