# Spec 1647, specify iteration 3: disposition of review findings

Both lanes returned REQUEST_CHANGES, converging on the same contradiction. Every finding was
accepted. None is rebutted.

On claude's "working tree changed" warning: the writer was me. I edited the spec to address
codex's iter-3 findings while the claude lane was still running. No consultant wrote to the
tree.

| Lane | Finding | Disposition |
|---|---|---|
| codex 1 / claude 1 | "Stale-within-TTL data served while suspended" contradicts `dispatch()` replacing the failed entry with `null`; with a single bundle entry the failing workspace blanks entirely | **Accepted and verified** at overview.ts:1368–1373 and 1411–1414. The spec now separates the two paths. (1) The failing workspace's own bundle entry is replaced by a negative entry and blanks: today's `dispatch`, unchanged. (2) Stale data is served only on a suspension caused elsewhere, to a workspace whose positive entry is within TTL: today's `cachedFetch`, unchanged. The residual-risk paragraph now states the regression plainly, including rate limits. Today the searches survive a list failure on their 600 s entries; under the bundle all four blank. Stale-if-error and Approach 3 are named for the owner. The success criterion and test scenario now assert both paths, with a second workspace. |
| codex 2 / claude 2 | The 60 s "guarantee" | **Accepted.** Recast as a sizing rationale. The common case is 1–2 processes (about 2 s); the pathological 20-process case may time out as a whole-bundle failure. The risk row no longer claims worst-case sizing. |
| claude 3 | The isolation path relies on unverified `gh` behaviour (200 with `errors` gives body on stdout and exit 1) | **Accepted.** It was in fact verified on 2026-11-25 (exit 1, partial `data` on stdout, `gh: …` on stderr) but not recorded in the spec. Now a date-stamped constraint, with the note that the forge layer discards stdout on failure, so classification is in-script. |
| claude 4a | `describeMissing` would say "CLI unavailable" for a `null` list section | **Accepted.** The bundle path supplies accurate text (`overview-bundle returned no PRs`). |
| claude 4b | Large outputs across pages imply temp files | **Accepted.** New constraint: `mktemp` outside the repo, `trap` cleanup, Git Bash compatible. The risk row impact is raised to Medium. |
| claude 4c | Churn makes the searches invalidation-driven (6/h → 60/h) | **Accepted.** Stated in item 3. On churn-heavy workspaces the win is in invocations, processes and requests, not points, until #1650. |
