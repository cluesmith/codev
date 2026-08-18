# PIR Plan: Relay VS Code approval gates through the spawning architect

## Understanding

Today every VS Code approval surface — the sidebar ✓, `Cmd+K G`, and the gate-pending
toast's fast path — funnels through `runPorchApprove` (`apps/vscode/src/commands/approve.ts:148`),
which shells out to `porch approve <id> <gate> --a-human-explicitly-approved-this` with `cwd`
set to the main workspace path. Two problems follow:

1. **The spawning architect never learns the gate was approved.** Its model of the builder goes
   stale, and its review at the *next* gate starts from confusion. This is the reported friction.
2. **Porch runs against the main checkout, not the builder's worktree** (related to #1235).

The fix is the *small* version chosen by the owner over #1194 (closed, not planned): replace the
direct CLI call with a **relay** to the builder's spawning architect. The human still decides by
clicking; the architect receives the decision and runs `porch approve` itself. This mirrors how
humans already work with codev — they tell the architect to approve, and the architect runs the
command.

```
today:     sidebar ✓  ──> porch approve            (extension shells out; nobody is told)
proposed:  sidebar ✓  ──> architect ──> porch approve   (architect executes, and is in the loop)
```

The builder is **not** in this chain; it is woken by porch exactly as it is today. No builder-side
change.

**Explicit scope fence (per architect kickoff).** This reuses `client.sendMessage(target, msg,
{ workspace })` → Tower `/api/send` (mailbox-first, Spec 1313) and the `spawnedByArchitect` field
the extension already reads. It introduces **no** typed gate-event frame, **no** system sender type,
**no** new bus, and **no** new Tower surface. If the work grows past that, I stop and check with the
architect rather than proceeding.

## Proposed Change

### 1. Routing: where the relay is targeted

The relay targets the builder's spawning architect via the explicit addressing form
`architect:<name>` — the same form `add-architect.ts` already uses (`ADD_ARCHITECT_RECIPIENT =
'architect:main'`). The inputs are already on the overview payload the command reads:

- `builder.spawnedByArchitect` (`packages/types/src/api.ts:201`) — the owner's name, or `null`.
- `overview.architects` (`api.ts:305`) — the workspace's **live** architects (Tower skips dead
  registrations), main-first.

**We must NOT inherit `builder-grouping.ts:122`'s `b.spawnedByArchitect || 'main'` fallback.** That
is #1406. A misrouted status line is noise; a misrouted *approval* sends a human's gate decision to
an architect that did not spawn the builder. The null / offline / CLI-only cases are decided
explicitly below.

I will extract the decision into a pure, unit-testable function so the branching is provable without
a running Tower:

```
decideApprovalRelay(owner: string | null, liveArchitectNames: string[]): Decision
```

returning a discriminated union:

| `owner` | live architects | Decision | UI outcome |
|---|---|---|---|
| set **and** live | — | `relay` → `architect:<owner>` | normal path: send the relay |
| set but **not** live | any | `refuse-offline` | modal error, names the offline architect; **no approval** |
| `null` | non-empty | `refuse-unknown-owner` | modal error, won't guess (avoids #1406); **no approval** |
| `null` | empty (CLI-only) | `direct-fallback` | **announced** info, then direct `porch approve` |

**This routing table — specifically the two refuse cases and the CLI-only fallback — is a
route-to-main decision (item 2 below).** My recommendation is above; I have delineated it so the
main architect can rule on it without reconstructing it.

Rationale for each non-happy branch:

- **`refuse-offline`**: the architect that *made the deciding relationship* is gone. Rerouting to a
  different live architect would be the exact #1406 misroute. Refusing (and naming the offline
  architect so the human can `afx workspace start` it or approve from a shell) is safer than
  guessing. No silent direct fallback here, because an architect *does* exist for this workspace and
  invisibility is precisely what this issue closes.
- **`refuse-unknown-owner`**: architects exist but this builder has no recorded owner (a
  data-integrity edge — a discovered worktree with no `state.db` row, or a legacy row). We cannot
  safely pick one of several architects. Refuse rather than misroute.
- **`direct-fallback`** (CLI-only, zero architects): there is genuinely no architect and never was,
  so a direct `porch approve` reintroduces no invisibility — there is no one to be invisible *to*.
  This keeps CLI-only workspaces working. **It must be announced in the UI** ("No architect
  registered in this workspace — approving directly."), never a silent backstop. The main architect
  has stated they will reject a *silent* fallback; this one is announced. The alternative is to
  refuse entirely and tell the human to run `porch approve` in a terminal — I recommend the
  announced fallback but flag the choice for main.

### 2. The relay message

Per acceptance criteria, the message names the gate, the builder, the artifact, and the fact that a
human approved by clicking, and hands the architect the exact command so it can act without asking
the human to confirm again:

```
[Gate approval — human clicked Approve in VS Code]

The human approved the "<gateLabel>" gate for builder <id> (issue #<issueId> — <title>)
by clicking Approve in VS Code. This carries stronger provenance than free text: the
extension generated it in direct response to an authenticated human click in their own IDE.

Artifact: <gate-appropriate — plan file for plan-approval, the worktree diff for dev-approval>
Worktree: <builder.worktreePath>

Please run:
  porch approve <id> <gate> --a-human-explicitly-approved-this
```

The message is built from fields already on `OverviewBuilder` (`id`, `issueId`, `issueTitle`,
`blockedGate`, `worktreePath`). No new Tower surface.

### 3. Interpreting the send result (the `held` case is first-class)

`sendMessage` returns `{ ok, delivered?, held?, reason?, error? }` (Spec 1313 mailbox-first). The
UI outcome must reflect that **the click no longer approves — it relays**, so the wording changes
from today's "Approved …":

- `!result.ok` → `showErrorMessage` naming the error. **No approval happened.**
- `result.ok && result.held` → **pending/held** warning: `Approval sent to <architect> but held
  (<reason>) — it will reach them when their prompt is clear. The gate is NOT yet approved.` This is
  a first-class outcome, not an edge case: on a held relay the approval has not happened, and the UI
  must not imply it has.
- `result.ok && !result.held` (delivered, or an older Tower that omits the field and thus reads as
  delivered) → success: `Approval relayed to <architect> — they will run porch approve for
  <gateLabel> (#<issueRef>).` Note the wording: **relayed**, not **approved**, because the architect
  still runs the command.

In every branch the UI truthfully distinguishes "relayed / held / failed" from "approved". The
sidebar cache refresh (`cache?.refresh()`) stays, but the gate will only clear once the architect
actually runs `porch approve` — the refresh reflects Tower state, it does not fake approval.

### 4. Role-doc correction (route-to-main item 1)

This is **not** "fix one stale sentence." There are **four** documents that speak to who runs
`porch approve`, and only one is a straight defect. Mapping them precisely matters, because a
reviewer who reads `builder.md` and thinks it was already right will otherwise read this change as
contradicting a correct doc and reject it.

| Document | Who it says runs `porch approve` |
|---|---|
| `codev/roles/architect.md:33,39` | the **builder**; the architect "does not run it on the builder's behalf" |
| PIR prompts (five places, below) | **not** the builder |
| `codev/roles/builder.md:26-28` | the builder **by default**; for **PIR**, the **human** via Cmd+K G / their shell |
| **#1494 as designed** | the **architect**, carrying the human's click |

**Nothing currently says "the architect runs it." That is the change.** Two distinct edits, framed
distinctly:

**(a) `architect.md:32-45` is a straight defect fix — wrong regardless of #1494.** It instructs the
architect to relay and *not execute*, and it tells the builder to run the command. But PIR's own
prompts forbid the builder from running it in **five** places:
`codev/protocols/pir/protocol.md:42`, `codev/protocols/pir/builder-prompt.md:46`,
`codev/protocols/pir/prompts/plan.md:117`, `codev/protocols/pir/prompts/implement.md:143`,
`codev/protocols/pir/prompts/review.md:243`. So `architect.md` contradicts the PIR protocol today,
independent of this issue. Cite the pir-1070 incident **precisely** (see box below) as evidence that
this defect misbehaves in practice — the incident is the evidence, not any commit author.

> **pir-1070 incident, stated precisely.** On lane pir-1070, the human (Amr) typed the
> `plan-approval` and `dev-approval` gates himself — exactly what `builder.md`'s PIR carve-out
> prescribes. The deviation was the **`pr` gate alone**: the architect, following `architect.md:39`,
> relayed the decision and instructed the builder to run `porch approve`, inserting the builder into
> a chain it should not be in. So two of three gates followed the correct convention; on the third,
> an architect following `architect.md` deviated. This isolates the defect to the one document that
> is actually wrong. **The commit (`d022dcfaa`) does not prove who ran the command** — every agent in
> this workspace shares one git identity, so authorship cannot attest the actor (the same
> missing-`approved_by` gap #1457 exists to close). The architect's own account is the evidence.

**(b) `builder.md:26-28` for PIR is a documented-actor change, not a defect fix.** It is *accurate
today*: for PIR the human types the gate, via Cmd+K G or their shell. #1494 changes `Cmd+K G` so the
click now relays to the spawning architect, who runs the command. So for PIR this edit **changes the
documented actor from the human to the architect** — say that plainly in the correction so it does
not read as overturning a doc that was right.

Proposed corrected story for **PIR** (both role docs), naming the flag's provenance and what the
architect does on receipt:

> Under PIR the **human** decides at the gate. When they approve via the VS Code button (Cmd+K G or
> the sidebar ✓), the extension relays the click to the builder's **spawning architect**, who runs
> `porch approve … --a-human-explicitly-approved-this` against the builder's worktree and continues
> — without re-asking the human. The flag records that a human explicitly approved; its provenance
> is the human's action, not an agent's self-authority. A relay generated by the extension in direct
> response to an authenticated human click carries materially stronger provenance than free text
> typed into a pane, and that is what makes architect execution legitimate here (the same property
> #1457 exists to make recordable). On receipt of such a relay, the architect recognises it as a
> human-approved gate decision and executes the command it carries.

**Scope of the correction is PIR only.** `builder.md`'s default — the *builder* runs `porch approve`
when the architect relays — still governs SPIR / AIR / ASPIR (they have gates but no `porch approve`
text of their own). This lane corrects **PIR and the two role docs** and does **not** generalise the
wording to those protocols. Whether to unify everything on "architect runs it" or keep PIR narrow is
an **OPEN QUESTION** (below); the main architect is taking that call to the owner and will relay the
answer before the plan gate. I will not pre-empt it or quietly generalise.

**Both trees.** `codev/roles/architect.md` and `codev-skeleton/roles/architect.md` are currently
byte-identical; every edit is mirrored into both. Framework content shipped to adopters, which is
why the main architect reads it before the plan gate.

### 5. `runPorchApprove` disposition

`runPorchApprove` is **not** deleted — it is retained solely for the announced `direct-fallback`
(CLI-only) branch, and its success message is reworded so it is never used as an unannounced
backstop for the architect-present paths. Its two current call sites (`:114` toast fast path, `:136`
sidebar/Cmd+K G) are rewired to go through the new relay decision instead.

## Files to Change

- `apps/vscode/src/commands/approve.ts` — the core change:
  - `:113-117` (toast fast path) and `:135-139` (sidebar / Cmd+K G) rewired to call the relay path.
  - New pure `decideApprovalRelay(owner, liveArchitectNames)` returning the discriminated union.
  - New relay helper: build the message, call `client.sendMessage('architect:<name>', msg,
    { workspace })`, interpret `delivered` / `held` / error into distinct UI outcomes.
  - `runPorchApprove` retained only for the announced CLI-only fallback; success wording reworded.
  - The command already holds `overview` (`:69`) — reuse it for `overview.architects`; no extra
    fetch.
- `apps/vscode/src/__tests__/approve-relay.test.ts` — **new**. Unit-tests `decideApprovalRelay`
  across all four table rows, and the send-result interpreter across `ok:false`, `held`, and
  `delivered` (mocking `vscode` per the established `__tests__` pattern).
- `codev/roles/architect.md` (gate section `:32-45`) — correction + on-receipt instruction.
- `codev-skeleton/roles/architect.md` — byte-identical mirror of the same edit.

**Not changed:** builder-side anything, Tower, the SDK `sendMessage` signature, `packages/types`.
The builder is not in the approval chain.

## Risks & Alternatives Considered

- **Risk: wording that implies the click approved when it only relayed.** Mitigation: the three
  result branches (§3) each say "relayed / held / failed", never "approved", and the held case is
  surfaced as a distinct warning.
- **Risk: misrouted approval via a `|| 'main'` fallback.** Mitigation: no such fallback; null/offline
  cases refuse explicitly (§1).
- **Alternative: #1194's notification-from-inside-`porch approve`.** Rejected by the owner on
  surface-area grounds; #1194 is closed. Not re-proposed.
- **Alternative: refuse in the CLI-only case instead of announced direct fallback.** Flagged for
  main (§1); I recommend the announced fallback so CLI-only workspaces keep working, but defer the
  ruling.
- **Alternative: delete `runPorchApprove` entirely.** Rejected — the announced CLI-only path needs
  it, and that path is a legitimate, announced use, not a silent backstop.

## Test Plan

- **Unit** (`approve-relay.test.ts`): `decideApprovalRelay` returns `relay` / `refuse-offline` /
  `refuse-unknown-owner` / `direct-fallback` for each row of the routing table; the result
  interpreter maps `ok:false` → error, `held` → pending warning, `delivered`/legacy → relayed
  success. These prove the *branching*, not the end-to-end effect.
- **Manual, end-to-end (this is the dev-approval evidence — unit tests alone will be rejected):**
  In a real VS Code window connected to a live Tower with a spawning architect and a builder blocked
  at a gate:
  1. Click Approve (sidebar ✓). Observe the relay reaches the architect terminal (message names the
     gate, builder, artifact, and the human-clicked provenance, and carries the exact `porch approve`
     command).
  2. The architect runs the command; observe the builder's gate actually clears and it advances.
     Capture this — a gate approval that passes tests but does not advance a real builder is not done.
  3. Repeat via `Cmd+K G` and via the gate-pending toast fast path to confirm all three surfaces
     relay.
  4. **Held case:** exercise a relay that Tower holds (architect prompt busy) and confirm the UI
     shows the pending/held warning and does **not** report the gate approved.
- **Capture plan / honest scope split:** I will capture the builder-shell-observable parts
  (the relay message arriving, the `porch approve` running, the builder advancing) from within this
  lane. The literal VS Code button *click* originates on the human's machine; if any part cannot be
  captured from the builder shell I will say so explicitly and name what must come from the human's
  window rather than claim it was captured.
- **Full check set before PR:** `pnpm check-types` (tsc) and the vitest suite from the worktree, not
  just one job.

## Route-to-main items (delineated for the main architect, before the plan gate)

1. **Role-doc correction** (§4) — framework content in both `codev/` and `codev-skeleton/`. Two
   framed edits: (a) the straight defect fix to `architect.md:32-45`, and (b) the PIR
   documented-actor change (human → architect) in both role docs, plus the on-receipt instruction.
2. **Null / unregistered-architect routing decision** (§1 table) — specifically the two refuse cases
   and the announced CLI-only `direct-fallback` (vs. refuse-entirely) choice.

### OPEN QUESTION (main architect is taking this to the owner before the plan gate)

**Narrow vs. uniform for the other protocols.** This lane corrects **PIR only**. SPIR / AIR / ASPIR
have gates but no `porch approve` text of their own, and `builder.md`'s default (the *builder* runs
it when the architect relays) still governs them. Should the correction stay PIR-narrow, or unify
all protocols on "architect runs it"? Unifying reaches past #1494's `area/vscode` surface into every
protocol — the kind of expansion the owner chose this design to avoid — so I keep it narrow and
**do not** resolve it here. Awaiting the owner's ruling relayed through the main architect.
