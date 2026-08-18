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

**Two coupled changes, one PR (owner's packaging call).** #1494 is two halves that must ship
together: the VS Code button (relay instead of direct invocation) and the framework convention that
the button implements (the architect runs `porch approve`, carrying the human's decision, for every
protocol and every gate — §4). Shipping them separately opens a window where the button relays to an
architect while the role docs still say the builder runs the command — the exact two-texts-disagree
condition this lane exists to close. So the doc sweep stays **inside** #1494, and the issue is
relabelled `area/cross-cutting`; a larger review is the accepted cost of not shipping a contradiction
window.

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
an architect that did not spawn the builder. The null / offline / no-live-architect cases are decided
explicitly below.

**The input `overview.architects` reports LIVENESS, not registration** (`api.ts:295-305`: only
architects with a live session are listed; `[]` when the workspace has *no architects* **or none are
live**). This distinction is load-bearing for the last branch and is why the earlier CLI-only framing
was defective — see the investigation note after the table.

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
| `null` | **empty (no *live* architect)** | `no-live-architect` | **announced** info stating only what is known, then direct `porch approve` |

Rationale for each non-happy branch:

- **`refuse-offline`**: the architect that *made the deciding relationship* is gone. Rerouting to a
  different live architect would be the exact #1406 misroute. Refusing (and naming the offline
  architect so the human can `afx workspace start` it or approve from a shell) is safer than
  guessing. No silent direct fallback here, because an architect *does* exist for this workspace and
  invisibility is precisely what this issue closes. **(Approved by main.)**
- **`refuse-unknown-owner`**: architects exist but this builder has no recorded owner (a
  data-integrity edge — a discovered worktree with no `state.db` row, or a legacy row). We cannot
  safely pick one of several architects. Refuse rather than misroute. **(Approved by main.)**
- **`no-live-architect`** (owner null, and no architect is *live* right now): a direct `porch approve`
  keeps the workspace usable when there is no one to relay to. **The announcement states only what is
  known from liveness** — "No live architect in this workspace; no architect will be notified of this
  approval." — never "No architect registered", because the signal cannot support that claim (below).
  This is a route-to-main decision (item 2); resolved to option (b) after the investigation below.

> **Investigation — why not "CLI-only", and why option (b) (main's ruling, resolved 2026-08-18).**
> The earlier design justified a direct fallback by *registration* ("no architect and never was, so
> nothing to be invisible to"). That is unsound: `overview.architects` is **liveness**, so `[] `
> cannot distinguish a genuinely CLI-only workspace from one whose architects are all currently
> down. Direct-approving in the second case is exactly the invisibility this issue closes, hidden in
> the branch meant to be safe.
> Main's ruling was: prefer a *registration* signal (option a) if Tower can already report it
> separately from liveness; otherwise fall back to option (b), announcing only what liveness knows.
> **I checked (a) against the server and it is not cheaply reachable:** both client-reachable
> endpoints — `/api/overview` and `/api/state` — build their architect list from the **same**
> `liveArchitects` helper (`tower-routes.ts:1087`, `:1163`, `:2776`), which skips dead sessions. The
> persisted registration table exists server-side (`state.ts getArchitects` at `state.ts:511`, noted
> at `tower-routes.ts:1080-1081`) but is exposed over **no** client endpoint. Surfacing it is **new wire
> data — the main architect's surface, which I may not add unilaterally.** So per the ruling I take
> **option (b)**: the branch is named `no-live-architect` (not `direct-fallback`/CLI-only), and the
> announcement is liveness-truthful.
> **Residual, stated for the gate:** under (b), if a workspace *does* have registered architects that
> are all currently down, this branch still direct-approves after announcing "no live architect will
> be notified." The human is told exactly that before it happens, so the approval is not invisible to
> *them*; the down architect learns of it on return. That residual is the accepted cost of not adding
> wire data in this lane, and option (a) remains the clean follow-up if the owner later wants it. (An
> incidental finding: the `DashboardState.architects` **type comment** at `api.ts:80-86` says "Full
> collection of registered architects", but the server fills it via `liveArchitects` too — the
> comment is stale. Noted, not fixed here; out of scope.)

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

### 4. Role-doc correction + convention sweep (route-to-main item 1)

**Owner's ruling (relayed 2026-08-18): UNIFORM.** The rule, stated in both role docs directly
rather than deferred to protocol prompts:

> The **architect** runs `porch approve`, carrying the human's decision, for every protocol and
> every gate. **The builder never runs it.** (The human may always run it in their own shell —
> that is their own authority; the constraint is on *agents*: the builder never, the architect only
> as the carrier of the human's decision.)

#### The rationale is already canon — anchor on it, do not re-invent

The argument for this rule was written well before #1494, as the section heading of
`codev/protocols/bugfix/protocol.md:38-42` (verbatim):

> **## The gate exists to make merge authorization structural**
> BUGFIX has one human gate, `pr`. Its purpose is that the merge trigger is **porch state** —
> approved or not — rather than free text typed into the builder's pane. That closes the
> self-merge bug class: a builder cannot infer authorization from ambiguous prose.

That is the thesis: **porch gate state must be authorization that is independent of prose.** The
role-doc correction cites this passage as its anchor and aligns the other protocols to it, rather
than inventing fresh per-protocol wording. It answers "why not just let the builder run it" crisply:
because then authorization arrives as prose in the builder's pane instead of as porch state.

**BUGFIX is the protocol that got this right; the others drifted.** `bugfix/prompts/pr.md:64`
already reads "Wait for the **architect** to approve it (`porch approve <project-id> pr`)" — it
already satisfies the uniform rule and is the anchor for the whole change. **It must not be
rewritten** beyond any genuinely required minimal wording alignment; a sweep that rewrites
already-correct text is how correct text becomes wrong.

#### The pir-1070 evidence, stated exactly (checked against the artifact)

The incident is evidence that the drift misbehaves, but it must be framed precisely — an
overstatement is the seam a reviewer uses to discard the whole argument:

> **No unauthorized merge occurred.** On pir-1070 the human (Amr) genuinely decided and said
> "merge it" in the architect's channel, and the merge that happened is exactly the merge he wanted.
> Amr typed the `plan-approval` and `dev-approval` gates himself; only the `pr` gate deviated. What
> failed was **the structural guarantee, not the decision**: the architect relayed a sentence and
> the builder transcribed that sentence into `pr`-gate state. So the gate record stopped being
> *independent* evidence of authorization and became a copy of the very prose it exists to be
> checked against. That is the **precondition** for the self-merge class, not an instance of it —
> and worse than an instance, because it is silent: the mechanism did not fail visibly, it degraded
> into a transcription step while the resulting gate record still looks exactly like one a human
> typed. Nothing in the artifact distinguishes them (the same reason the commit author,
> `d022dcfaa`, proves nothing — one shared git identity; #1457 from a third direction). **The
> guarantee this passage exists to provide was not in force.** Uniform restores it.

So the lane's justification is not "two documents disagree, tidy them up." It is: one protocol
identified this failure mode and designed the guarantee; the convention drifted; the drift left the
guarantee inoperative on a real gate while the record continued to look valid. Uniform is
**restoring an existing design**, not imposing a new one.

#### The two edits

**(a) `architect.md:32-45` is a straight defect fix — wrong regardless of #1494.** It tells the
architect to relay and *not execute*, and it tells the builder to run the command. That contradicts
PIR's own prompts, which forbid the builder from running it in five places
(`codev/protocols/pir/protocol.md:42`, `builder-prompt.md:46`, `prompts/plan.md:117`,
`prompts/implement.md:143`, `prompts/review.md:243`), and it is the document the pir-1070 architect
was following. Replace the passage with the uniform rule above, anchored on the structural-
authorization thesis, and add **what the architect does on receipt** of a VS Code gate-relay
message: recognise it as a human-approved gate decision (materially stronger provenance than pane
prose — extension-generated in direct response to an authenticated human click) and run the
`porch approve … --a-human-explicitly-approved-this` command it carries against the builder's
worktree, without re-asking the human.

**(b) `builder.md:26-28` is a rewrite, not a patch.** Its structure is "you run it **by default**,
*unless* your protocol routes it to the human." Under uniform there is no default and no carve-out:
the builder never runs it. Patching only the exception clause would leave the default sentence
asserting something now false, so the whole passage is rewritten to: the builder never runs
`porch approve`; the architect runs it, carrying the human's decision.

#### Per-protocol verification (plan deliverable — gates enumerated from `protocol.json`, not prose)

Enumerating gates by grepping prose is unreliable (authors name gates in their own words). The table
below is built from the authoritative `"gate"` fields in each protocol's `protocol.json` phases
(identical across `codev/` and `codev-skeleton/`). The uniform rule lives in the two role docs and
therefore governs every protocol at once; the job here is to confirm no protocol *prompt* contradicts
it, and to leave correct text (BUGFIX) untouched — **not** to normalise every mention into identical
phrasing.

| Protocol | Human gate(s) from `protocol.json` | Prompt state today | Action |
|---|---|---|---|
| **bugfix** | `pr` | `pr.md:64` "**architect** approves" ✓ | **Do not touch** — the anchor |
| **pir** | `plan-approval`, `dev-approval`, `pr` | builder-prohibition half ✓; but `builder-prompt.md:46` also asserts "the human runs `porch approve`" | **One-sentence fix** to `builder-prompt.md:46` (both trees); see below. Other four builder-prohibition sites untouched |
| **spir** | `spec-approval`, `plan-approval`, `pr`, `verify-approval` | "architect approves verify-approval" ✓ | Covered by role docs; no prompt edit |
| **aspir** | `pr`, `verify-approval` (no spec/plan gate — autonomous) | "architect approves verify-approval" ✓ | Covered by role docs; no prompt edit |
| **air** | `pr` | no actor misassignment | Covered by role docs; no prompt edit |
| **experiment** | `experiment-complete` (terminal) | no `porch approve` prose | Covered by role docs; no prompt edit |
| **maintain** | `maintain-complete` (terminal) | no `porch approve` prose | Covered by role docs; no prompt edit |
| **research** | `scope-approval`, `research-complete` | no `porch approve` prose | Covered by role docs; no prompt edit |
| **spike** | **(none)** | — | **No text** — no gate; must not add (would imply a gate exists) |
| release (codev-only) | none (no `protocol.json`; doc-driven procedure) | — | Out of scope |

**The one PIR builder-prompt fix (`builder-prompt.md:46`, both trees).** The line reads:

> **The gate stays pending until the human runs `porch approve` — never call it yourself.**

The *prohibition* half ("never call it yourself") is correct and stays. The problem is the actor
claim in the first half: post-#1494 the primary path is that the human clicks and the **architect**
runs the command. The sentence is not false (the human can still run it in their own shell), but it
presents the no-longer-primary path as the *only* one — and this is precisely the file whose reading
produced a real refusal (`pir-1347` refused a gate by reasoning about who legitimately runs the
command; a builder reading "the gate stays pending until the human runs it" can conclude an
architect-approved gate is illegitimate, reproducing that incident from the other direction). That is
a behavioural risk, not tidiness. Proposed minimal rewrite:

> **The gate stays pending until the human approves and that approval is carried out — never call
> `porch approve` yourself.**

**Do not touch** `plan.md:117`, `implement.md:143`, `review.md:243`, `protocol.md:42` — those are
actor-neutral builder prohibitions and remain correct. This stays a one-sentence fix, not a sweep.

**Conclusion:** the sweep's file edits are the **two role docs** plus **one sentence in
`pir/builder-prompt.md`** — each mirrored across both trees. Everything else already aligns (BUGFIX,
the anchor — untouched), is an actor-neutral prohibition (the other four PIR sites), or is governed
by the now-universal role-doc rule; `spike` has no gate and stays silent. This is deliberate
discipline: the rule belongs in the role docs, and rewriting correct protocol text to "match
phrasing" is the failure mode the anchor warning names.

**Both trees.** `roles/architect.md`, `roles/builder.md`, and `protocols/pir/builder-prompt.md` are
byte-identical across `codev/` and `codev-skeleton/` today; every edit is mirrored into both, and
after the sweep I grep **both** trees for `porch approve` actor language before claiming completeness.

### 5. `runPorchApprove` disposition

`runPorchApprove` is **not** deleted — it is retained solely for the announced `no-live-architect`
branch, and its success message is reworded so it is never used as an unannounced backstop for the
architect-present paths. Its two current call sites (`:114` toast fast path, `:136` sidebar/Cmd+K G)
are rewired to go through the new relay decision instead.

## Files to Change

- `apps/vscode/src/commands/approve.ts` — the core change:
  - `:113-117` (toast fast path) and `:135-139` (sidebar / Cmd+K G) rewired to call the relay path.
  - New pure `decideApprovalRelay(owner, liveArchitectNames)` returning the discriminated union.
  - New relay helper: build the message, call `client.sendMessage('architect:<name>', msg,
    { workspace })`, interpret `delivered` / `held` / error into distinct UI outcomes.
  - `runPorchApprove` retained only for the announced `no-live-architect` fallback; wording reworded
    to state only what liveness knows ("No live architect … no architect will be notified").
  - The command already holds `overview` (`:69`) — reuse it for `overview.architects`; no extra
    fetch.
- `apps/vscode/src/__tests__/approve-relay.test.ts` — **new**. Unit-tests `decideApprovalRelay`
  across all four table rows, and the send-result interpreter across `ok:false`, `held`, and
  `delivered` (mocking `vscode` per the established `__tests__` pattern).
- `codev/roles/architect.md` (gate section `:32-45`) — replace with the uniform rule (anchored on
  the bugfix structural-authorization thesis) + on-receipt instruction for the VS Code relay.
- `codev-skeleton/roles/architect.md` — byte-identical mirror of the same edit.
- `codev/roles/builder.md` (`:26-28`) — **rewrite** (not patch): the builder never runs
  `porch approve`; the architect runs it carrying the human's decision.
- `codev-skeleton/roles/builder.md` — byte-identical mirror of the same rewrite.
- `codev/protocols/pir/builder-prompt.md` (`:46`) — **one-sentence** precision fix (§4): drop the
  "the human runs `porch approve`" actor claim, keep the "never call it yourself" prohibition.
- `codev-skeleton/protocols/pir/builder-prompt.md` — byte-identical mirror of the same sentence.

**All other protocol prompts: none edited.** Per the §4 verification table, BUGFIX is already correct
(the anchor — must not be touched), the other four PIR sites are actor-neutral prohibitions, and every
other protocol is governed by the now-universal role-doc rule; `spike` has no gate and stays silent.
After the edits I grep **both** trees for `porch approve` actor language to confirm no contradiction
remains.

**Not changed:** builder-side *code*, Tower, the SDK `sendMessage` signature, `packages/types`, and
any protocol `protocol.json` or any prompt file other than the single `pir/builder-prompt.md`
sentence. The builder is not in the approval chain.

## Risks & Alternatives Considered

- **Risk: wording that implies the click approved when it only relayed.** Mitigation: the three
  result branches (§3) each say "relayed / held / failed", never "approved", and the held case is
  surfaced as a distinct warning.
- **Risk: misrouted approval via a `|| 'main'` fallback.** Mitigation: no such fallback; null/offline
  cases refuse explicitly (§1).
- **Alternative: #1194's notification-from-inside-`porch approve`.** Rejected by the owner on
  surface-area grounds; #1194 is closed. Not re-proposed.
- **Alternative: a registration signal (option a) instead of the liveness-only `no-live-architect`
  branch.** Preferred by main *if* cheaply reachable; it is not (both client endpoints are
  live-filtered; exposing the persisted table is new wire data = main's surface), so resolved to
  option (b). Clean follow-up if the owner later wants it (§1 investigation note).
- **Alternative: delete `runPorchApprove` entirely.** Rejected — the announced `no-live-architect`
  path needs it, and that path is a legitimate, announced use, not a silent backstop.

## Test Plan

- **Unit** (`approve-relay.test.ts`): `decideApprovalRelay` returns `relay` / `refuse-offline` /
  `refuse-unknown-owner` / `no-live-architect` for each row of the routing table; the result
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

## Route-to-main rulings (resolved before the plan gate)

Both items were routed to the main architect and are now **ruled**. Recorded here for the gate.

1. **Role-doc wording + convention sweep** (§4) — **APPROVED.** The uniform-rule rewrite of
   `architect.md` (defect fix + on-receipt instruction) and `builder.md` (rewrite-not-patch),
   anchored on the bugfix structural-authorization thesis, mirrored into `codev-skeleton/`. The
   agents-vs-human carve-out ("the human may always run it in their own shell") is kept as an
   approved improvement. **One file added on ruling:** `pir/builder-prompt.md:46` (both trees) — a
   one-sentence precision fix (that file's reading produced the `pir-1347` refusal from the other
   direction). BUGFIX stays untouched as the anchor; no other prompt is edited.
2. **Routing table** (§1) — `relay` / `refuse-offline` / `refuse-unknown-owner` **APPROVED** (incl.
   refuse-not-reroute when the owner is offline, and the pure-function shape). The fourth branch was
   ruled **defective** (keyed off liveness, not registration); resolved to **option (b)** — renamed
   `no-live-architect`, announcement states only what liveness knows — after I confirmed a
   registration signal (option a) needs new wire data I may not add unilaterally (§1 investigation
   note). Residual for the all-architects-down case is stated there for the gate.
