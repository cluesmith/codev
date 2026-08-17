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
