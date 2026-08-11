# Review Phase (PR-level) — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES.

Codex raised five items. Four are fixed. The fifth — a real security finding — is corrected in
the documentation and escalated, because the honest fix is Tower-wide and patching one route
would be theatre.

## 1. (Security) Request trust on the command route

**Accepted.** Codex is right, and I verified the finding independently before responding.

Tower's existing request-trust boundary is weaker than my spec claimed. The specifics and the
fix are tracked privately as a security advisory, so they are not restated here.

Two things follow, and both are settled:

**The spec's claim is corrected.** It described a safeguard in terms that overstated what is
actually in place. Documenting protection that is not there is worse than documenting none, so
the wording was fixed in place.

**The fix does not belong in this PR.** The property is pre-existing and Tower-wide rather than
anything this channel introduces, and addressing it properly is an architectural change with a
client migration — not a line in a builder's PR. Applying a partial measure to the newest route
alone would move the label rather than the risk, and would leave an inconsistent model that is
harder to reason about later than a known, tracked gap. What this PR adds is one more capability
behind the existing boundary, and the spec now says exactly that.

Escalated to the architect, who verified it independently and routed it to the owner for
disclosure handling.

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
