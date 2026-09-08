# bugfix-1472 — VSCode mailbox escalation-toast `seen` Set is unbounded

Issue #1472 · protocol BUGFIX (strict) · branch `builder/bugfix-1472`

## Architect constraints (2026-08-17)

- We are **not** cluesmith/codev maintainers: open the PR, address review feedback,
  then **park it for the maintainer** — do not merge it myself. Report protocol-complete.
- Design note from tracking issue #1483: prefer eviction keyed on **the mailbox row leaving
  the escalated set** (the same signal that would let a legitimate re-escalation re-notify)
  over a bare LRU cap, *if that signal is available in the toast module*.

## Investigate

**Root cause** — `apps/vscode/src/notifications/mailbox-escalation-toast.ts:30`:
`const seen = new Set<string>()` lives for the whole extension-host activation. Line 58
`seen.add(payload.mailboxId)` is the only mutation in the file — grep confirms **zero**
`seen.delete` / `seen.clear` anywhere. So every escalated mailbox row the window ever
observes leaves a permanent entry. Add-only container, activation-scoped lifetime =
unbounded growth. Reproduction is static and conclusive: there is no code path that can
ever remove an entry.

**Is the de-escalation signal available?** Yes, at workspace granularity:

- `OverviewData.mailboxEscalated: boolean` (packages/types/src/api.ts) — "at least one held
  row in this workspace has crossed the escalation age". `OverviewData` carries **no
  per-row mailbox ids** (only `heldCount` + this flag), so `false` is the finest-grained
  "left the escalated set" signal a client can see. When it is false, *every* id in `seen`
  has left the escalated set → the whole set can be dropped.
- The signal reaches a notification module the same way `activateGateToasts` gets it:
  `OverviewCache.onDidChange` + `getData()` (`apps/vscode/src/views/overview-data.ts`).
  `overviewCache` is already in scope at the `activateMailboxEscalationToasts(...)` call
  site (extension.ts:1522), so this is a one-argument signature change, one call site.
- Precedent to mirror: `gate-toast.ts` keeps a `(builderId, gateName)` seen-set and prunes
  entries once they leave the blocked set — same shape of fix.

**Server-side semantics checked** (so the doc comment is accurate, not assumed):
`db/mailbox.ts` sets `escalated = 1` once, guarded by `escalated = 0`, on a still-held row;
the flag is never reset and terminal rows are pruned. So the same `mailboxId` cannot
legitimately re-escalate — eviction here is purely about memory, never about re-notifying.

**Stale-snapshot race** — `OverviewCache.refresh()` is last-write-wins by `latestSeq`, and
the escalation SSE event itself triggers a refresh whose request starts *after* the row was
flagged in the DB. So an older in-flight `mailboxEscalated: false` response cannot commit
after the escalation's own `true` response and wrongly clear `seen`.

**Fix shape** (~40 LOC + tests, well inside the BUGFIX ceiling):
1. Inject `OverviewCache`; on `onDidChange`, clear `seen` when `data.mailboxEscalated` is
   false (the preferred eviction key — the row leaving the escalated set).
2. Keep a hard cap with oldest-first eviction as a backstop, for the pathological window
   where the workspace is *continuously* escalated all day so the flag never falls false.
   Insertion-ordered `Set` makes this trivial.
3. Regression tests that fail without the fix: re-toast after de-escalation, and the cap
   bounding a continuously-escalated window.

Signal: PHASE_COMPLETE.

## Fix

Implemented as planned, commit `850242bf` (~50 LOC of source + 4 tests):

- `mailbox-escalation-toast.ts` takes `OverviewCache` and prunes `seen` whole on
  `mailboxEscalated === false`; `MAX_SEEN = 500` oldest-first cap as backstop.
- `extension.ts` — the single call site passes `overviewCache` (already in scope).

**Verified failing without the fix**, not assumed: with the eviction neutered the suite went
2 failed / 10 passed; restored, 12/12. Full vscode unit suite 72 files / 850 tests green;
`pnpm check-types` clean; `pnpm lint` has one pre-existing warning in the unrelated
`src/commands/tunnel.ts`.

Environment note for the next builder in this worktree: it starts with **no `node_modules`**.
`pnpm install` at the worktree root, then `pnpm --filter @cluesmith/codev-types build &&
pnpm --filter @cluesmith/codev-sdk build` — without the package builds, 18 vscode unit files
fail on `Cannot find package '@cluesmith/codev-sdk/...'`, which looks like a code failure and
is not one.

## PR

PR #1484 — https://github.com/cluesmith/codev/pull/1484. Per the architect's constraint we are
not maintainers here: the PR is parked for a maintainer to merge; I do not merge it.

`consult` did not auto-detect the project from this worktree (it listed every project and
exited); `--issue 1472 --project-id bugfix-1472` is required.

### CMAP (PR #1484)

gemini = APPROVE (HIGH) · codex = APPROVE (HIGH) · claude = APPROVE (HIGH). No blocking issues
from any lane. The claude lane died once on a transient API 500 and was re-run.

Non-blocking notes and what I did with them:

- *Doc slightly stronger than the server guarantees* — Tower also reports
  `mailboxEscalated: false` when it cannot read the mailbox at all. **Fixed**: the doc comment
  now says so, and why it is harmless (one escalation per row, no SSE replay).
- *Uncommitted thread file* — **fixed**, committed with the PR.
- *A null-workspace window toasts every workspace but reads Tower's fallback-workspace flag, so
  it can prune on a foreign `false`* — pre-existing quirk of `escalationMatchesWorkspace`'s
  deliberate null-matches-everything rule; this fix neither introduces nor worsens it, and it
  is unobservable given single-emission. **Left alone** — widening it into a workspace-scoping
  change is outside a BUGFIX.
- *The `while (seen.size > MAX_SEEN)` loop can only iterate once* — deliberate; **left as is**
  (the reviewer agreed).

## Protocol complete — PR parked, NOT merged

Human approved the `pr` gate (relayed by the architect 2026-08-17T23:24Z); I ran
`porch approve bugfix-1472 pr --a-human-explicitly-approved-this` and `porch done`. Porch
reports **PROTOCOL COMPLETE**, phase `verified`.

`porch next` then hands out a final "Merge the pull request" task. **Deliberately not done.**
We are not cluesmith/codev maintainers on this project; the architect's standing constraint is
that a maintainer merges. GitHub agrees independently — PR #1484 is `reviewDecision:
REVIEW_REQUIRED`, `mergeStateStatus: BLOCKED`. I also did NOT run `porch done --merged 1484`,
since nothing was merged; whoever merges should record it.

Anyone picking this up: the PR is complete and green, waiting only on maintainer review+merge.
