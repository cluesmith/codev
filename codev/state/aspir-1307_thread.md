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

## 2026-07-31 — Specify iter 1 review: REQUEST_CHANGES, and it changed the design

Claude returned `REQUEST_CHANGES` (HIGH confidence) after verifying my factual claims
against the code — all held. Codex could not run (see below). Seven issues raised; I
agreed with all seven and one of them moved the recommended architecture.

**The one that mattered — write-then-verify.** The review asked why I hadn't considered
having the architect write the state file *before* invoking the CLI, so the CLI could
validate synchronously and arm only `quiesce → clear → reorient`. I hadn't, and it wins:

- Removes receipt polling from Tower entirely — the new server-side surface drops to one
  small job.
- Makes "no clear without a verified save" **true by construction** in the self path,
  rather than a gate that could be misordered.
- Collapses the clear-after-new-work window from up to 300s to a single quiet window.

Kept the original nonce/Tower-armed shape as Approach 1b with explicit rejection reasons
rather than deleting it. The external (owner-run) path still uses the nonce receipt gate,
because there a *remote* party is being asked to comply — and that gate already exists
and works in the CLI process. Two proof-of-save paths, one shared destructive job.

**A consequence I had to chase down myself**: write-then-verify breaks the state-file
snapshot. The CLI used to run before the overwrite; now it runs after. So in the self
path the snapshot has to be the *skill's first step*, and the test has to compare
snapshot content (not just existence) or a snapshot-taken-too-late passes silently.
These files are gitignored — there is no second chance to notice. Logged as its own risk
row.

**Other six, all incorporated in place:**
1. Post-clear "stop stale monitors" was unimplementable as I wrote it — no enumeration
   mechanism, and comment 2 says `pgrep` can't see harness tasks. Restated: pre-clear
   stop is the enforceable half (that context holds the handles); post-clear is
   best-effort reconciliation + disregard-what-you-can't-account-for.
2. My `## Monitors` heading gate contradicted the v67 template I claimed to adopt
   (its monitor list lives in a `#`-comment intent stamp). Worse, I mandated a gate
   while leaving its placement an open question. Now a `MONITORS:` token the template
   carries verbatim; open question closed.
3. Clear-after-new-work hazard — absent from risks, questions and tests. Added to all
   three; mitigated structurally by write-then-verify + first-quiescence-only firing +
   bounded armed lifetime.
4. `--boundary` overclaimed as "a recorded human decision" — in the self path the agent
   types it. Now records invocation mode and states the limit plainly.
5. Quiescence-against-a-live-TUI is a *second* unrun-e2e unknown, not just `/clear`.
   Safe but total failure (feature never fires). Live run scoped to both.
6. `sendRaw` vs `sendMessage` divergence: reset wraps its reorientation in a
   `[MESSAGE FROM …]` envelope, which would stop `/arch-init` being a slash command at
   all. Recorded as a constraint the shared extraction must not collapse, plus a test
   asserting the exact channel and payload.

Also flagged: raw-typing a slash command *with an argument* may hit autocomplete and
have Enter accept a completion instead of submitting. This is the one step with no safe
degradation — a swallowed reorientation leaves a *cleared* architect with no identity —
so it's a risk row demanding live confirmation, not an assumption.

### Codex lane down — escalated, ruled on

`consult -m codex` failed: server rejects `gpt-5.6-sol` as needing a newer Codex. I
checked the global CLI (0.146.0), judged a global upgrade out of a builder's scope, and
escalated rather than working around it. Architect's ruling: correct call, but wrong
culprit — consult's codex lane runs `@openai/codex-sdk` with its own **vendored** binary
(0.142.5), a different client from the global CLI entirely. PR #1309 bumps it; needs the
owner's merge word plus a global reinstall.

Directed path: neither "proceed claude-only" nor "wait idle" — keep revising now, and
re-run codex against the **revised** spec once the reinstall lands. Strictly better than
having codex review a draft Claude already marked up. Not re-running consult until the
architect pings.
