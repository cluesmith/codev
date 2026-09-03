# PIR Review: Stop telling operators to interrupt a human who is just typing

Fixes #1482

## Summary

`afx send` holds a message when the render gate cannot prove the recipient's composer is
empty, and until now every hold looked identical: a bare `busy`. That flattened two opposite
situations into one word. **A `user-text` hold means a human is typing — the hold is correct
and clears itself. A `no-region-end` hold means the classifier could not verify anything — the
hold never clears.** The owner starvation notice offered the same remedy for both, and that
remedy was `afx interrupt`: for the first case, *advice to interrupt a person mid-draft.*

This PR makes the two distinguishable, and then fixes the defect that manufactures the second
one. The gate's `GateVerdict.detail` now survives onto the held row (migration v18) and reaches
every operator surface as a `reason:detail` sub-code, so the notice can branch. Underneath,
`PtySession.resize()` no longer moves Tower's dimensions — and re-wraps the gate's
classification mirror — before confirming the resize reached the process, which is how a
dropped shellper write silently desynchronised the mirror from the real TUI and produced
permanent false-busy holds in the first place.

The premise is measured, not asserted. On a committed 139x63 fixture, columns 139 and 143
classify CLEAN while 135 and 131 classify `busy:no-region-end`. **A four-column disagreement is
enough to strand mail forever**, and that measurement is now a test.

## Files Changed

- `codev/plans/1482-f1-tower-vs-pty-dimension-dive.md` (+287 / -0)
- `codev/projects/1482-f1-tower-vs-pty-dimension-dive/1482-dev-approval-evidence.md` (+319 / -0)
- `codev/projects/1482-f1-tower-vs-pty-dimension-dive/status.yaml` (+22 / -0)
- `codev/resources/arch.md` (+3 / -1)
- `codev/resources/lessons-learned.md` (+12 / -0)
- `codev/reviews/1482-f1-tower-vs-pty-dimension-dive.md` (+241 / -0)
- `codev/state/pir-1482_thread.md` (+177 / -0)
- `packages/codev/src/agent-farm/__tests__/hold-verdict.test.ts` (+81 / -0)
- `packages/codev/src/agent-farm/__tests__/render-gate.test.ts` (+78 / -0)
- `packages/codev/src/agent-farm/__tests__/send-architect-identity.test.ts` (+5 / -3)
- `packages/codev/src/agent-farm/__tests__/send-delivery.test.ts` (+140 / -1)
- `packages/codev/src/agent-farm/__tests__/send-hold-warning.test.ts` (+126 / -0)
- `packages/codev/src/agent-farm/__tests__/spec-1313-migration.test.ts` (+125 / -2)
- `packages/codev/src/agent-farm/commands/inbox.ts` (+47 / -4)
- `packages/codev/src/agent-farm/commands/send.ts` (+21 / -4)
- `packages/codev/src/agent-farm/db/index.ts` (+1 / -0)
- `packages/codev/src/agent-farm/db/mailbox.ts` (+36 / -13)
- `packages/codev/src/agent-farm/db/migrations.ts` (+28 / -1)
- `packages/codev/src/agent-farm/db/schema.ts` (+1 / -0)
- `packages/codev/src/agent-farm/db/types.ts` (+23 / -0)
- `packages/codev/src/agent-farm/servers/cron-delivery.ts` (+9 / -2)
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` (+47 / -5)
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` (+48 / -5)
- `packages/codev/src/agent-farm/servers/tower-cron.ts` (+3 / -2)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+33 / -4)
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` (+10 / -1)
- `packages/codev/src/agent-farm/utils/hold-verdict.ts` (+51 / -0)
- `packages/codev/src/terminal/__tests__/pty-session-resize.test.ts` (+191 / -0)
- `packages/codev/src/terminal/pty-manager.ts` (+34 / -4)
- `packages/codev/src/terminal/pty-session.ts` (+119 / -12)
- `packages/codev/src/terminal/shellper-client.ts` (+55 / -0)
- `packages/codev/src/terminal/shellper-main.ts` (+20 / -3)
- `packages/sdk/src/tower-client.ts` (+11 / -0)
- `packages/types/src/api.ts` (+9 / -0)
- `packages/types/src/sse.ts` (+9 / -0)

## Commits

- `647f0325e` [PIR #1482] Plan draft
- `60d6374f7` [PIR #1482][Phase: gate-detail] feat: persist the render gate's verdict detail on the held row
- `3ef84a726` [PIR #1482][Phase: resize-truth] fix: commit terminal dimensions only when the resize reached the process
- `91a3dbf21` [PIR #1482][Phase: dims-reconciliation] fix: adopt the shellper's reported PTY geometry on attach
- `9e9762ed7` [PIR #1482][Phase: tests] test: pin resize truth, attach reconciliation, and the gate's dimension sensitivity
- `908dfaaad` [PIR #1482] revert: drop the dashboard popover render change (not browser-verifiable here)
- `d44ed9448` [PIR #1482] test: cover utils/hold-verdict, and record the dev-approval evidence
- `ce9121a56` [PIR #1482] chore: move the dev-approval evidence to the project directory

(Plus porch's own `chore(porch):` state-transition commits.)

## Test Results

- `pnpm build`: ✓ pass (run by porch's gate checks)
- `pnpm test`: ✓ pass — **278 test files passed / 3 skipped; 5495 tests passed / 48 skipped**,
  exit 0, on the final tree. ~40 tests are new.
- **Manual verification at the `dev-approval` gate**: five of six live-behaviour items were
  induced from this worktree's build and captured verbatim in
  `codev/projects/1482-f1-tower-vs-pty-dimension-dive/1482-dev-approval-evidence.md` — the
  `afx inbox` compound REASON cell, the `afx inbox show` Detail line, both owner-notice branches
  with their streak counts, the dropped-resize WARN with dimensions that did **not** move, and
  the attach-reconciliation WARN naming both geometries. The human approved on that evidence.
  Everything ran under `NODE_ENV=test` + `AF_TEST_DB` against an isolated database; the user's
  live `~/.agent-farm/global.db` was never opened.

### New tests, by area

| Area | Count | File |
|---|---|---|
| Migration v18 (upgrade, convergence, idempotency) | 7 | `spec-1313-migration.test.ts` |
| Detail persistence + changed-only guard | 5 | `send-delivery.test.ts` |
| Resize truth + attach reconciliation | 7 | `pty-session-resize.test.ts` |
| Gate dimension sensitivity (characterization) | 3 | `render-gate.test.ts` |
| `formatVerdict` / `isUnverifiableVerdict` | 9 | `hold-verdict.test.ts` |
| Send CLI warn-line branch | 6 | `send-hold-warning.test.ts` |

The last two suites were **mutation-checked rather than trusted green**: forcing
`isUnverifiableVerdict` to `return false` and `formatVerdict` to drop the detail produced 8
failures; the module was then restored byte-for-byte (`git diff` empty) and both re-ran green.

## Architecture Updates

Routed **COLD only** — both hot files are exactly at their caps (10 facts / 10 lessons), and
nothing here was strong enough to justify displacing an existing entry. The hot map already
points at the right cold section ("Invariants & Constraints — … anything 'MUST remain true'"),
so the routing works as designed without growing the always-injected tier.

`codev/resources/arch.md`:

- **New invariant #10, "Terminal dimensions must be earned, not assumed"** — requested vs
  applied vs outstanding; commit only on confirmed success; 409 `RESIZE_DROPPED` vs 404 for an
  unknown id; the shellper's WELCOME geometry wins on attach; and *why* it is load-bearing (the
  gate's mirror must wrap text the way the real TUI does, with the 139/135-column measurement
  quoted).
- **Extended the Spec 1313 mailbox section's "honest response vocabulary" item** with the
  `mailbox.detail` column: what v18 adds, why it carries no CHECK constraint (SQLite cannot
  `ALTER` one in, and declaring it only in `GLOBAL_SCHEMA` would make a fresh install
  structurally differ from an upgraded one — which the convergence test forbids; the
  `MailboxGateDetail` type is the enforcement), the changed-only write, the `detail: null` rule
  for non-gate holds, and `isUnverifiableVerdict` as the single predicate splitting the two
  classes.

## Lessons Learned Updates

Routed **COLD only**, same cap reasoning. `codev/resources/lessons-learned.md`:

**§ Architecture**
- A function that returns a failure boolean is only as honest as its callers — `resize()`
  reported `false` correctly and all three callers discarded it. Grep every call site in the
  same change; an unchecked failure signal is worse than none, because it reads as handled.
- Two-state models fail at the third state. *Requested vs applied* was not enough; the missing
  bit was **OUTSTANDING, not DIFFERENT**. Before modelling state as a comparison between two
  values, ask what a third value would mean — "these disagree" and "someone is still waiting"
  are different questions.
- Commit derived state only after the thing it describes is confirmed; order matters more than
  the check itself.

**§ Process**
- An ignore rule usually states its reason next to itself — read the comment before reaching for
  `git add -f`.
- Report the boundary of a gap, not the instance you tripped over.
- Mutation-check a test written to close someone else's finding, before claiming it.

## Things to Look At During PR Review

**Two gaps were approved knowingly at the `dev-approval` gate. Flagging them here so nobody has
to discover them.**

1. **The dashboard held-mail popover still renders a bare `busy`** where `afx inbox` shows
   `busy:user-text`. The render change was written and then deliberately **reverted**
   (`908dfaaad`): this worktree cannot browser-verify UI — `.codev/config.json` is absent so
   there is no `worktree.devCommand` for `afx dev`, and Playwright is not installed — and the
   project requires a browser check before a UI change is called done. `HeldMessage.detail` and
   the `/api/inbox` projection are both in place, so it is a two-line change for whoever can run
   the dashboard. **Not an oversight; a refusal to claim a verification that was not performed.**
2. **Evidence item 3 (the `afx send` held CLI line) is covered by test, not induced live.**
   `commands/send.ts` constructs `new TowerClient()` with no port, so the CLI can only reach the
   live Tower on 4100 — and pointing gate evidence at a real Tower with real agents behind it was
   not acceptable. The branch is covered by `send-hold-warning.test.ts` (6 tests) driving the
   real `send()` against a mocked client, labelled TEST OUTPUT in the evidence file rather than
   dressed up as live. A testability observation, out of scope here: `commands/inbox.ts` takes
   `options.port` and *is* drivable against a stub; `send.ts` is not.

**Beyond what the plan specified** — both deliberate, both worth a reviewer's eye:

3. **The REST resize routes now answer 409 `RESIZE_DROPPED`** (distinguished from 404 by an
   explicit existence check). The old code answered **200 and echoed back the requested
   dimensions** — which is precisely how the divergence stayed invisible. This is an API
   behaviour change on an existing route, not just an internal fix.
4. **`CronDeliveryResult` gained `detail`.** Not in the plan. A cron send has no human waiting on
   a response, so its log line is the *only* place that hold is ever described.

**The subtle one.** Phase 3 adopts the shellper's WELCOME geometry and then re-sends the
requested geometry so a live viewer still wins. Written the obvious way — re-send when
`requested !== applied` — it fires for a session whose *constructor defaults* merely differ from
the running geometry, which is Tower's stale belief, the very thing the adoption just corrected.
The first attach test caught it adopting 139x63 and immediately reverting to 104x101. The fix is
an explicit `resizePending` flag: set when a resize is dropped, cleared when one lands, and the
only thing that authorises a re-send. **Worth re-reading that interaction specifically.**

**Migration collision surface.** This adds **v18**; `origin/main` was at **v17** when this
branched and was re-verified still at v17 (`cc83b6a32`) immediately before opening the PR. A
maintainer merging this *after* another schema PR must re-check for a v18 collision — note it
would show up in two places, `GLOBAL_CURRENT_VERSION` in `db/migrations.ts` **and** the pinned
source assertion in `send-architect-identity.test.ts` that reads it back.

**Conflict surface with two parked PRs.** Both are green and ahead of this one; whichever merges
second may need a trivial rebase, this one included.

- **PR #1486** (issue #1478) touches `commands/inbox.ts`, `commands/send.ts`, `tower-routes.ts`.
- **PR #1491** (issue #1474) touches `render-gate.ts`, `render-gate.test.ts`.

This branch was kept deliberately narrow across that overlap. `formatVerdict` /
`isUnverifiableVerdict` live in a **new** `agent-farm/utils/hold-verdict.ts` rather than in
`utils/message-format.ts` — the latter is about formatting message bodies for PTY delivery and
is one of #1486's files. New module, zero conflict surface.

**One correction to my own earlier summary, preserved rather than tidied away.** I initially
reported the dropped-resize WARN as firing from `resizeSession`. It does not: it fires on the
WebSocket control-message paths (`pty-manager.handleControlMessage`, `tower-websocket`). The
correction stays verbatim in the evidence file at lines 205-208. `resizeSession` returns `null`
on a dropped resize — and still returns `null` for an unknown id, which is exactly why the REST
layer needed its own existence check to tell 409 from 404.

**A truncation that is NOT a regression from this PR.** In evidence item 1 the sender/recipient
cell reads `architect:main -> pir-1`. That is the **pre-existing 22-character FROM→TO
truncation**, not fallout from widening the REASON column 13→20. Checked before shipping so a
reviewer does not file it against this change.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1482` → **Review Diff**
- **Run dev**: `afx dev pir-1482` (note: no `worktree.devCommand` is configured in this repo, so
  this is not available here — see gap 1 above)
- **Read what was actually exercised, without attaching to a terminal**:
  `codev/projects/1482-f1-tower-vs-pty-dimension-dive/1482-dev-approval-evidence.md`

What to verify:

- `afx send <a-busy-builder> "test"` → `afx inbox` shows `busy:user-text`; `afx inbox show <id>`
  carries a `Detail` line. Send to an agent whose composer is mid-repaint → `busy:no-region-end`,
  plus the CLI's "could not verify that composer" warning, which must **not** appear for
  `user-text`.
- Leave a message held past the owner-notice threshold → the notice names the occupied-composer
  case and its confirmation count, and does **not** suggest `afx interrupt` for a `user-text`
  hold.
- Resize a terminal in the dashboard/VSCode viewer; dims track it, no WARN. Then kill the
  shellper socket, resize again: the WARN fires, the REST route answers 409 `RESIZE_DROPPED`,
  and the session's dims do **not** move.
- Restart Tower with a live shellper at a non-default geometry: adopted dims match the
  shellper's, and a held message to that agent delivers.
- Dashboard held-mail popover: **currently still shows a bare `busy`** — that is gap 1, not a
  test failure.

## Flaky Tests

None. No test was skipped or quarantined for flakiness during this work.
