# aspir-1307 — `/arch-save`: packaged save→clear→re-init for architects

## 2026-07-31 — Specify phase, iteration 1

Spawned strict-mode ASPIR on issue #1307. No spec existed on disk, so `porch next`
put me straight into Specify with a blank sheet.

### What I read before writing

- **Issue #1307 + both comments.** The second comment is a *correction* that changes
  the design and is easy to miss: monitors are **session-bound, not context-bound** —
  a watcher armed pre-clear SURVIVES `/clear` and fires stale alerts into the fresh
  context. So the state block's monitor list is a **kill-list AND a re-arm list**, in
  that order. The original "monitors die at the clear" framing in the issue body is
  superseded.
- **`.claude/skills/arch-init/SKILL.md`** — the save discipline (§"Saving your state")
  is the prose this issue asks to package. Its human-keystroke rule is the invariant
  that must survive packaging.
- **`packages/codev/src/agent-farm/commands/reset/`** (Spec 1273, PR #1305) — the
  machinery to reuse: `receipt.ts` (nonce-in-file freshness gate, R2), `index.ts`
  (ordering state machine + step log, R1/R3/R4), `reset.ts` (port bindings).
- **`servers/message-write.ts`** — confirmed `escape: true` discards the body, so
  `/clear` must go over `raw: true`. Already handled in reset's port split.
- **`commands/whoami.ts`** — architect identity comes from `CODEV_ARCHITECT_NAME`,
  builders from worktree cwd. This is how self-invocation is detected.
- **`servers/tower-cron.ts`** — precedent that Tower already runs deferred work.

### The crux I had to design around

`afx reset` works because the invoker is a *different* terminal from the target. For
`/arch-save` the architect is often the invoker AND the target, and that breaks two
things at once:

1. The quiescence gate (R4) can never pass — the CLI's own output is the noise it is
   waiting to stop.
2. The CLI process dies with the clear, so it cannot deliver the re-orientation.

The issue's own design note calls the answer: Tower survives the clear, so **Tower
owns the post-arm sequence**. The CLI arms an in-memory Tower job and exits so the
architect's turn can end. External (owner-run) invocation arms the same job and just
tails it. One state machine, two front doors.

### Decisions baked into the spec

- Dedicated `afx arch-save`, not `afx reset <architect> --state` — reset resolves
  targets via `findBuilderById`, architects are not builders, and arch-critical says
  add a dedicated concept rather than bolting a flag onto a shared one. Machinery is
  factored out and shared, not duplicated.
- Re-orientation payload is **exactly `/arch-init <name>`**, delivered raw. Every
  resume instruction lives in the state file, because that is what `/arch-init` reads.
  Appending a checklist to the injected line would corrupt the slash-command argument.
- Nonce round-trip kept from #1273 (arm → nonce → architect writes → Tower verifies),
  so both invocation modes share one freshness proof.
- `--boundary` is required and is where the relocated human decision is recorded.
- New: a required `## Monitors` section in the state file, so "none armed" has to be
  written consciously rather than omitted silently.
- New: the CLI snapshots the *previous* state file at arm time. These files are
  gitignored (`.gitignore:15`), so a bad save is otherwise unrecoverable.

### Known dependency, flagged not blocking

The #1273 live e2e ("does `/clear` actually take effect over the raw channel") has not
run. Spec records it as a Critical open question with an explicit mitigation: every
gate aborts *without* clearing, and a no-op `/clear` degrades to "architect keeps its
context and also gets `/arch-init` re-injected" — which loses nothing. Proceeding
rather than blocking; called out for the architect at the PR gate.

Next: write `codev/specs/1307-arch-save-packaged-save-clear-.md`, then `porch done`.
