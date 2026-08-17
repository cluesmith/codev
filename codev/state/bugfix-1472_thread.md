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
