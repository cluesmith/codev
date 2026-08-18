# PIR Review: Relay VS Code approval gates through the spawning architect

Fixes #1494

## Summary

The VS Code Approve button (sidebar ✓, `Cmd+K G`, and the gate-pending toast) no longer shells out
to `porch approve` directly. It now relays the human's decision to the builder's spawning architect,
who passes it to the builder, and the builder runs `porch approve` in its own worktree. This keeps
the architect in the loop (its model of the builder no longer goes stale between gates) and runs
porch against the builder's worktree rather than the main checkout. To make a relayed approval
distinguishable from a peer-architect instruction, relays carry a `VSCODE_USER_SENDER` `from`, and
Tower renders them under a dedicated `[USER via VS Code]` header.

## Design journey (why the commit history pivots)

The commits document a real change of direction, which is why they are not squashed:

1. **Architect-runs-it (uniform ruling).** The first implementation had the *architect* run
   `porch approve` for every gate, with a uniform role-doc rewrite across both trees.
2. **Owner re-ruled builder-runs-it at the dev-approval review.** Amr chose the smaller-blast-radius
   shape: the architect only *relays*, and the **builder** runs `porch approve`, matching how
   SPIR/AIR already work via `roles/builder.md`'s default. The architect role doc was reverted to
   original (it already said "relay the decision; the builder runs the command"), and PIR was aligned
   to that default by removing its five "never run `porch approve` yourself" prohibitions and
   dropping the PIR carve-out from `roles/builder.md`.

## Files Changed

Net diff vs the merge-base (`ee1fffd`), excluding porch state / plan / thread bookkeeping:

- `apps/vscode/src/commands/approve.ts` (+214) relay routing + message + result handling
- `apps/vscode/src/__tests__/approve-relay.test.ts` (+121 / -0) new unit tests (pure core)
- `packages/types/src/messaging.ts` (+12 / -0) new `VSCODE_USER_SENDER` wire constant
- `packages/types/src/index.ts` (+2) export it
- `packages/codev/src/agent-farm/utils/message-format.ts` (+23) `formatUserViaVsCodeMessage`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+7) route the new header in `formatMessageForTarget`
- `packages/codev/src/agent-farm/__tests__/message-format.test.ts` (+41 / -0) formatter test
- `codev/protocols/pir/{builder-prompt,protocol,prompts/plan,prompts/implement,prompts/review}.md` plus `codev-skeleton/` twins: PIR aligned to builder-runs-it
- `codev/roles/builder.md` plus `codev-skeleton/roles/builder.md`: dropped the PIR carve-out so PIR inherits the default

`roles/architect.md` is intentionally **unchanged** (its original wording already describes
builder-runs-it).

## Commits

- `c46888d1f` Add [USER via VS Code] header so architect can tell a relay from an instruction
- `1acbeba2e` Fix relay message: imperative instruction, not passive fact
- `7173f3de2` Rework to builder-runs-it: short relay message + PIR matches SPIR
- `92a4ee58f` / `a60bcb2bb` Relay VS Code approvals through the spawning architect + role docs (the
  earlier architect-runs-it approach, superseded by `7173f3de2`)
- Plan-phase commits (`2bec9856f` through `30e0946dd`): draft, route-to-main rulings, two rebases

## Test Results

- `pnpm check-types` (vscode, both tsconfigs): ✓, `pnpm lint`: ✓, `node esbuild.js`: ✓
- vscode `pnpm test:unit`: ✓ **874 passed** (16 new relay-core tests)
- codev-core `message-format.test.ts`: ✓ 4 passed; message-routing tests (inbox/cron/pacing) ✓ 36
- porch `dev-approval` re-ran the gate's build + tests: ✓
- **Manual, end to end (dev-approval gate):** Amr verified in a real VS Code window that clicking
  Approve relays to the spawning architect, the architect passes it to the builder, and the builder
  advances. The relay renders under the `[USER via VS Code]` header rather than masquerading as an
  `[ARCHITECT INSTRUCTION]`.

## Architecture Updates

**COLD** (`codev/resources/arch.md`, Agent Farm Internals, Message Delivery): added a note on the
`VSCODE_USER_SENDER` attribution and the `[USER via VS Code]` header as a third message-format class
alongside architect-instruction and builder-message, plus the VS Code approval relay flow.

**No HOT change** (`arch-critical.md`): the hot tier is capped and always-injected; this flow is a
specific VS Code + PIR interaction, not a top-level invariant every contributor must consult before
deciding, so it stays COLD per the displacement discipline.

## Lessons Learned Updates

**COLD** (`codev/resources/lessons-learned.md`, Protocol Orchestration): one entry capturing two
durable rules, both found only by real end-to-end runs:

1. A relay that should *trigger* an action must read as an **imperative instruction**, not a
   past-tense fact. "Human approved X" was read by the architect as *already done*, so it never
   relayed and the builder stalled. "Approve X, please pass it to the builder" is a call to act.
2. Message **provenance belongs in structured attribution** (the `from` field and the rendered
   header), not in-band body text, or it leaks to downstream recipients and can be misread.

The existing HOT lesson "tests pass is not it works, verify the real user path end to end" was
strongly reinforced here (the passive-message stall and the header byte-drop both surfaced only in
Amr's live VS Code run, never in unit tests), so it needs no new entry.

### Decision record: structural-authorization tradeoff (kept for future readers)

This lane knowingly does **not** extend BUGFIX's canon (`bugfix/protocol.md:38`: "the merge trigger
is porch state rather than free text typed into the builder's pane; a builder cannot infer
authorization from ambiguous prose") to PIR. Under builder-runs-it the builder records porch state
from the architect's relayed message, which is inferring authorization from prose. The owner accepted
this tradeoff explicitly, with the argument in front of him, on surface-area grounds (no cross-protocol
role-doc churn; porch runs in the builder's worktree). Two instances motivated the discussion and are
recorded so the gap stays revisitable:

- **pir-1070:** the structural guarantee was *bypassed*. Porch `pr`-gate state was produced from a
  relayed sentence, so the record became a copy of the prose it exists to be checked against. No
  unauthorized merge occurred; the guarantee was simply not in force.
- **pir-1494 (this lane):** the guarantee was *not* bypassed (a human genuinely decided and an
  architect genuinely carried it), and the record still could not demonstrate it, because porch
  stores `approved_at` but never `approved_by` (#1457). Correct conduct, unprovable afterward.

Together they show the gap is not a discipline problem: one instance had a defect in the chain, one
had none, and neither was settleable from the artifact. Process note also recorded: an attestation is
for the *record*, not for the *risk*, so plan and dev gates deserve the same provenance treatment as
the pr gate.

### This lane's three gates ran under three chains

Because this lane changed the convention mid-flight: **plan-approval** was run by the architect
(uniform ruling), **dev-approval** by the builder (builder-runs-it ruling this lane shipped), and the
**pr** gate is still ahead. A reader of `status.yaml` seeing two different actors on two gates needs
that explanation; it is the convention changing, not sloppiness.

## Things to Look At During PR Review

- **The four routing branches** in `decideApprovalRelay` (relay / refuse-offline /
  refuse-unknown-owner / no-live-architect). The last one keys off *liveness*, not registration
  (`overview.architects` is live-only), and announces only what liveness supports, never "no
  architect registered". No `|| 'main'` fallback anywhere (that would be the #1406 misroute).
- **The `held` case is first-class**: a held relay is not an approval, and the UI says
  "sent / held / failed", never "approved".
- **PIR prompt sweep**: five prohibitions reframed to "run `porch approve` only when the architect
  relays", and `protocol.md`'s self-merge rationale reworked. Mirrored byte-identically into
  `codev-skeleton/`.
- **Not in scope, filed separately (#1521):** an intermittent Tower mailbox-delivery race can drop
  the leading bytes of a delivered header (`ER via VS Code`). It is a delivery-layer race, not this
  lane's code (the formatter string is test-pinned and the write path is untouched).

## How to Test Locally

- **View diff**: VS Code sidebar, right-click builder `pir-1494`, **Review Diff**.
- **Run it**: load `apps/vscode` in an Extension Development Host, connect to a Tower with a spawning
  architect and a blocked builder, click Approve (sidebar ✓ / `Cmd+K G` / gate toast), and confirm
  the architect receives a `[USER via VS Code]` instruction to pass on, and no gate reads approved
  until the builder runs `porch approve`.
- **Unit**: `pnpm --filter codev-vscode test:unit approve-relay` and, in `packages/codev`,
  `pnpm vitest run src/agent-farm/__tests__/message-format.test.ts`.
