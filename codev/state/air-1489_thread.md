# air-1489 — Rename `afx reset` → `afx refresh`

Protocol: AIR (strict). Issue #1489. No spec/plan/review files by design — the review goes in
the PR body.

## 2026-08-17 — Implement

### Scope calls I made (the issue left these to my discretion)

**Internal file/directory names stay `reset*`.** `commands/reset.ts`, `commands/reset/`,
`ResetOptions`, `runReset`, `ResetPreflightError`, `formatResetReport` are untouched. Issue point 5
explicitly allows this and warns against ballooning the diff; renaming the directory would have
turned a ~250-line naming change into a several-hundred-line move with no user-visible benefit.
The one exception is the **exported command entry point**, `reset()` → `refresh()`, because that is
the symbol the CLI wires the canonical command to and reading `await reset(...)` under an
`afx refresh` registration is exactly the confusion the rename exists to remove.

**The builder-facing header changed too: "CONTEXT RESET" → "CONTEXT REFRESH".** Issue point 3 only
names `--dry-run` output, log lines and error messages. But the save request and the re-orientation
frame are read by an *agent* under the same vocabulary the issue is trying to fix, and #1470's
automatic flow is "builder context refresh". Leaving the payloads saying RESET would have split the
vocabulary at exactly the point where it matters most. Side benefit: `confirmClear`'s pattern is
`/context (?:cleared|reset)/i`, and the old `CONTEXT RESET INCOMING` header collided with it (a real
false-positive, fixed structurally in Spec 1273 by only scanning post-clear output). The new header
no longer collides — but the orchestrator test deliberately **keeps** a colliding line in
`PRE_CLEAR_BUFFER` so the window logic is not allowed to start depending on that luck.

**The nonce marker `<!-- codev-reset: … -->` stays.** It is a wire format between the command and
the builder within a single run, and it appears in state files that may already exist on disk.
Renaming it buys nothing and would make a live builder's stale-file detection read oddly.

### The alias

`afx reset` and `afx refresh` are registered as two commands over one shared action body
(`registerRefresh` in `cli.ts`), canonical name first so `--help` leads with it. Commander's
`.alias()` was rejected: it gives no way to tell which spelling the caller typed, and the deprecated
spelling has to announce itself. The notice goes to **stderr** via `process.stderr.write` —
`logger.warn` writes to stdout, which carries the run report.

### Sweep

`grep -rn "afx reset"` across the repo is clean except for (a) the deprecation lines that mention it
on purpose, and (b) `codev/specs/`, `codev/plans/`, `codev/reviews/`, `codev/projects/`,
`codev/state/` — historical artifacts of Spec 1273 and friends, which are records of what was
written at the time and are not rewritten.

### Environment note

The worktree ships without `node_modules`; `pnpm install --frozen-lockfile` plus
`pnpm --filter "@cluesmith/codev^..." build` were needed before vitest could resolve
`@cluesmith/codev-sdk/tower-client`.

## 2026-08-17 — PR #1490 + CMAP

`gemini=APPROVE (HIGH)`, `codex=COMMENT (HIGH)`, `claude=APPROVE (HIGH)`. **No blocking findings.**

Codex's only note is diff size (693 lines) against AIR's nominal ~300 — it says explicitly this is
"not blocking", and the production-code delta is small; the bulk is comment rewrites, docs, the
alias test suite and this thread file. Claude independently re-ran the affected suites (6 files /
197 tests green) and re-verified the sweep, and both it and Codex endorsed the `CONTEXT REFRESH`
payload rename that I had flagged as the debatable call.

### Verified reviewer claims rather than taking them on trust

**Claude's finding #1 is real.** `codev-skeleton/.claude/skills/afx/SKILL.md` and its `.codex` twin
have no `afx reset`/`afx interrupt` section at all — their headings stop at `afx cron`, and the file
was last touched by #1143, well before Spec 1273. So there was nothing in the skeleton skill trees
for this PR to rename, and the issue's sweep is complete by its own terms; but **adopters will never
discover `afx refresh`**. The docs test's `SKILL_DOCS` only covers the root `.claude`/`.codex`
trees, which is why the drift is invisible. Backfilling a whole missing section is Spec 1273 work,
not a rename — flagged to the architect for a follow-up issue rather than widened into this PR.

**The reviewers' suggested live `--dry-run` could not run from here.** I first confirmed by reading
`runReset` that `dryRun` returns before `fs.write`, before the optional interrupt and before any
terminal send — genuinely zero-write, so self-targeting was safe. But `afx refresh air-1489
--dry-run` fails at the registry lookup: from inside a worktree the workspace resolves to the
worktree path, and `afx status` reports "Workspace: not active in tower". Pre-existing scoping,
untouched by this change, and running afx from the main workspace root is not a builder's call. So
the attempt did exercise the real resolve path under the new name and emitted the renamed error
text, but assembly end-to-end remains covered by the orchestrator tests rather than a live run.

**`afx db reset` still exists** and is legitimately destructive (Claude's minor note #2). No
collision with the top-level registration — commander scopes it under `db` — but "reset is
deprecated" is now marginally ambiguous in the help surface. Left alone.

## 2026-08-18 — Backfill, gate, merge

Human decision (relayed by the architect): approve **with backfill first**.

Backfilled `## afx interrupt` and `## afx refresh` into both skeleton skill files, lifted
**verbatim** from the root skill files updated earlier in the PR so the adopter-facing copies cannot
drift from what shipped. Then closed the hole that hid the drift: the docs test's `SKILL_DOCS`
covered only the ROOT `.claude`/`.codex` trees, so it now asserts the skeleton twins too — both
commands present, `## afx reset` absent, deprecation line present, copies byte-identical. Confirmed
non-vacuous against `git show HEAD:<file>` before trusting it (a docs test that cannot fail is
worse than no docs test).

CI was revalidated against the **exact new head SHA** `1c0a59eda`, not a stale rollup — 7/7 success
— and the PR head was re-checked to still equal that SHA before approving the gate. `porch approve
1489 pr` needed the explicit `--a-human-explicitly-approved-this` flag.

`gh pr merge 1490 --merge` was refused: `reviewDecision=REVIEW_REQUIRED`, `main` requires 1
approving review and I authored the PR. **Did not reach for `--admin`** — that is the owner's call.
Waleed admin-merged at 00:14:52Z as merge commit `10eef2d62` (verified 2 parents: a true merge, not
a squash). Issue #1489 auto-closed via `Closes #1489`.

Verified on `origin/main` after the merge: all four skill trees carry refresh + interrupt with zero
stale `## afx reset` headings, and the only surviving `afx reset` strings outside historical
artifacts are the intentional deprecation notice and the test that asserts the heading's absence.

Protocol complete (phase `verified`). **Worktree deliberately left in place** — cleanup awaits the
owner's word.

> Note: this final entry post-dates the merge, so it lives on `builder/air-1489` only, not on
> `main`. Everything decision-relevant in it is also captured in the merged commit messages and the
> merged test.
