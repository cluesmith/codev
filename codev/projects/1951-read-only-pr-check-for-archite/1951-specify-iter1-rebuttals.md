# Spec 1951 — iteration 1 rebuttal

Both reviews were accepted in full; nothing was declined. Changes are in commit
`[Spec 1951] Specification with multi-agent review`.

## Codex (REQUEST_CHANGES)

1. **Live-base race** — Accepted. The base tip (`ls-remote`) is now re-read together with the
   head SHA when every check has finished; either moving makes the verdict attention
   ("base|head moved during check; re-run"). New § "The trial merge moves no ref" step 4,
   success criterion "Exact head, live base, no race", test scenario 11, risk row.
2. **`check-attr` needs git 2.40 for `--source`** — Accepted (confirmed: `--source` landed in
   git 2.40). Rather than raise the floor or re-implement attribute matching, the
   "files to read" rule is now globs only (`check.notForReading`); the spec says why
   `linguist-generated` is not honored. `check-attr` is removed from the git allow-list.
3. **Worktree verdict semantics inconsistent** — Accepted. The verdict now answers one
   question, "would removal lose data?", with each category defined: uncommitted
   (non-scaffold) files; unsafe commits (on neither the live base nor the live remote branch,
   with the squash/rebase case decided exactly by local tip == merged PR head); keep-list
   ignored files. Non-keep-list ignored files are declared regenerable (that is what the keep
   list means) and their count is printed. Lifecycle (PR still OPEN, or PR state unavailable)
   is a separate `pr` check: attention / not-run, exit 1, without changing the verdict word.
4. **JSON schema not documented** — Accepted. New § "JSON schema": typed report shapes for all
   three commands and the exit-2 error object, plus a `details` table for every check id.
5. **Trust boundary overstated** — Accepted. New item 4 in § "Read-only enforcement" states it
   precisely: runtime enforcement covers git argv and which concepts are invoked; concept
   scripts run through the dispatcher's shell, so shipped scripts are secured by stub-`PATH`
   tests and review, and project overrides are trusted.

## Claude (COMMENT)

1. **`check-attr --source` / git 2.40** — same as Codex 2; fixed the same way.
2. **"merge-tree is the only write" contradicts the fetch** — Accepted. Reworded: the only
   writes are object-store additions (fetched packs and merge-tree's unreachable objects); no
   ref, `HEAD`, index, working-tree file or `FETCH_HEAD` changes.
3. **No timeout behavior** — Accepted. Every forge call keeps the dispatcher's 30 s limit, and
   `ls-remote`/`fetch` get the same; a timeout is a named `not run` (exit 2 only for the
   anchoring `pr-view`). Success criterion, scenario 12b, risk row.
4. **Multi-PR `check deploy` error semantics** — Accepted as suggested: an unreadable PR is a
   per-PR `not run` (exit 1) and the rest are still reported; exit 2 is reserved for
   repository-, configuration- and usage-level failures. Scenario 15a.
5. **`cleanup.keepIgnored` criterion untickable if #1950 lands second** — Accepted. Assumptions
   now state the landing-order rule: if #1950 has not merged, this project defines the key and
   never-copy list (with #1950's defaults) in one shared place and #1950 adopts it; the
   cross-check test lands with whichever PR is second. Not blocked on #1950.
6. **Missing pre-merge linked-issue check** — Accepted. New `linked-issue` check: closing
   keyword present and matching the `builder/<protocol>-<id>` branch → info; absent → info
   with "close #<id> by hand after merge" (partial fixes legitimately lack one); naming a
   different issue → attention.
7. **Input validation** — Accepted. New § "Input validation": PR numbers, SHAs, builder ids /
   paths and the deploy config strings (no leading `-`, no control characters) are validated
   before any subprocess; attribution regexes are trusted config, compiled once, applied per
   line. Scenario 28a.
8. **Docs criterion omits `.codex` skill mirrors** — Accepted (verified all four copies exist).
   The criterion names `.claude/skills/codev/`, `.codex/skills/codev/` and both skeleton
   mirrors, plus hash regeneration.

"Things I could not check" (the issue body): I diffed the spec against issue #1951's
"What the spec must decide", "What the helpers do" and "Constraints" item by item; every item
is answered in the spec.
