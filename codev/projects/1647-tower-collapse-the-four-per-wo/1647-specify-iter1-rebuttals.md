# Spec 1647, specify iteration 1: disposition of review findings

Both lanes returned REQUEST_CHANGES (codex HIGH, claude HIGH). Every finding was accepted. None
is rebutted.

## codex

| # | Finding | Disposition |
|---|---|---|
| 1 | Exact contract undefined | **Accepted.** Desired State item 2 now defines the input `CODEV_SINCE_DATE` (format, required, validated) and the four required keys `prs`/`issues`/`recentlyClosed`/`recentlyMerged`. Each key maps to its existing contract type, `null` means a failed section, extra keys are ignored, and the malformed-output rule is stated. |
| 2 | Search isolation vs. preserving gh's exit status | **Accepted.** Desired State item 6 gives the classification rule: data present, every error path-scoped to a search field, and no rate limit. It covers path-less, mixed and multiple errors, and failed follow-up pages (search page nulls its section, issue page fails the bundle). The Constraints line names this as the one sanctioned exception. |
| 3 | Projection is not always 52 | **Accepted.** `projectHourlyForgeCalls` takes the resolved plan (bundled, or four-call with the set of runnable constituents) and returns idle and churn figures. Examples: 52/132 with all four, 46/126 with `recently-merged` disabled, 32/72 with `issue-list` disabled. |
| 4 | Partial-success caching and status representation | **Accepted.** A bundle with a `null` section is positively cached for 180 s and counts as a limiter success, with no per-section retry. It is represented exactly as today's failed concept: `recentlyClosed` empty or PR links dropped, `forgeStatus: unavailable`, and `errors.*` only for list sections. |
| 5 | Security test (variables, hostile strings) | **Accepted.** New constraint (fixed query text, cursors via `-f`, `-F` only for placeholders, `CODEV_SINCE_DATE` validated because it enters a search string) plus a success criterion and test scenarios with hostile strings. |

## claude

| # | Finding | Disposition |
|---|---|---|
| 1 | Bundle time limit unspecified; a timeout blanks everything | **Accepted.** Explicit 60 s limit and 40 MB output limit (measured: our PR bodies are about 10 KB, so a 1,000-PR merged search alone could hit 10 MB). Timeout success criterion added. A whole-request failure or timeout blanking all sections is recorded as a residual risk accepted under D2, with Approach 3 named as the remedy. The search cap stays at 1,000, because the architect confirmed today's caps under D3. |
| 2 | Constraints contradict Desired State 5 on exit status | **Accepted.** Same fix as codex 2. |
| 3 | Parity vs. issues-disabled | **Accepted and verified.** GraphQL returns an empty connection with exit 0 on an issues-disabled repo, while `gh issue list` exits 1. Recorded as a named, accepted divergence in Desired State item 5. |
| 4 | `errors.prs`/`errors.issues` in bundle mode | **Accepted.** A whole-bundle failure populates both from the bundle outcome with `describeMissing`'s text. The rate-limit criterion asserts it. |
| 5 | Name the doc surfaces | **Accepted and verified.** Four files are named. arch.md:2269 and doctor.ts:1695/1713 say "18 concepts" against 20 in `KNOWN_CONCEPTS`; corrected in place. |
| 6 | Churn-mode points | **Accepted.** Tables now include churn rows (300 vs. 312 points). While adding them I also corrected my own churn request figures (192 and 132, not 132 and 72). |
| 7 | Doctor should disclose a bundle override bypassing a constituent override | **Accepted.** Added as a doctor reason and a test scenario. |
| 8 | "Still open" item was a decision | **Accepted.** Moved to "Design choices made in this spec". No Critical or Important questions remain. |
