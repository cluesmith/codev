# PIR Plan: Re-plan PR #1203 (Kimi harness) against converged main

**Issue**: cluesmith/codev#1620
**PR under repair**: cluesmith/codev#1203 — "Support Kimi Code CLI as a builder (PIR #1201)", author @mohidmakhdoomi
**Branch**: `builder/pir-1201` (Mohid's fork, `maintainerCanModify=true`). Merge-only — **never** rebase or squash; his commits and authorship stay intact and this lane adds commits on top.
**Companion artifact**: `codev/plans/1201-support-kimi-code-cli-as-a-bui.md` is rewritten in this same phase (issue item 4) and is part of what the `plan-approval` gate approves.

---

## Understanding

PR #1203 was reported green on 2026-08-09 and then sat un-re-reviewed for 26 days. In that window `main` advanced **1,606 commits** past the merge base (`4983ea83`), and three of the PR's four core seams were rebuilt underneath it. GitHub reports the PR `CONFLICTING`. The 2026-09-04 3-way integration review found the *design* sound and the *branch* un-mergeable; the owner's decision is that maintainers execute the re-plan on Mohid's branch.

### What actually diverged (verified file-by-file, not inferred from the conflict list)

`git merge-base origin/main pr1203` = `4983ea83`. 17 paths changed on both sides. Sorted by how much real thinking each needs:

**Trivial (a comment rename `afx reset` → `afx refresh`, nothing else):**
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — 1 line
- `packages/codev/src/agent-farm/utils/harness.ts` — 3 lines
- `packages/codev/src/commands/doctor.ts` — 2 lines

**Semantic re-derivation required — the write edge, `packages/codev/src/agent-farm/servers/message-write.ts`:**
Main replaced `writeMessagePaced(session, msg, noEnter) → Promise<boolean>` with `submitMessagePaced<A>(session, msg, noEnter, precheck, clock?) → Promise<PacedSubmitResult<A>>` (#1365 / PR #1492). It now takes the per-terminal `submitToSession` lock, runs the caller's precheck **inside** the lock, and reports a 5-way result (`written`/`dropped`/`preempted`/`contended`/`aborted`). The PR's `MessagePacing` override rode the old function's tail call to `writeMessageToSession`; that call is still there (`message-write.ts`, inside `trySubmitToSession`), so the override re-homes cleanly — but the port signature, the binding in `mailbox-wiring.ts`, and every test that stubbed `writeMessage` all moved.

**Semantic re-derivation required — gate verdict details, `packages/sdk/src/hold-verdict.ts` (#1482 / PR #1604):**
Main extracted `formatVerdict` + `isUnverifiableVerdict` into the SDK as the *single* definition of "will this hold clear on its own?", and `mailbox-delivery.ts`'s `isClassifierStuck` now delegates to it (its JSDoc explicitly forbids a second copy). The PR, written before that landed, re-forked the predicate as a local `CLASSIFIER_STUCK_DETAILS` record. That fork must be deleted. Kimi's two new details (`no-region-start`, `multi-row-draft`) must be added to `MailboxGateDetail` (`db/types.ts:115`), to the `schema.ts:270` column comment, and to `isUnverifiableVerdict`.

**Semantic re-derivation required — marker anchoring, `packages/codev/src/agent-farm/servers/render-gate.ts` (#1474 / PR #1491):**
Main rewrote `findMarkerRow` from `(lines, markerPattern)` to `(lines, profile, buf, top, cursorRow, cell)` and added two `GateProfile` anchor fields — `markerRequiresCursorRow` and `markerFgPalette` — because agy's `> ` also matches its slash-menu cursor and its per-turn transcript echo. It also hoisted `top` / `cell` / `cursorRow` **above** the marker call and fixed `cursorRow` to be viewport-relative (`baseY + cursorY - top`). The PR adds `regionStartPatterns`, `growsWithDraft`, `markerSpanEnd`, `findRegionStart`, and a per-row marker exemption — and computes `top`/`cell`/`cursorRow` in the old place. Textually that is one conflict hunk; semantically the two changes are orthogonal and compose, with one trap called out under *Risks* below.

**Semantic re-derivation required — `mailbox-wiring.ts` / `mailbox-delivery.ts` / `tower-routes.ts`:**
Main added echo verification (#1573: `bufferLines`, `watchEchoOnScreen`, `normalizeForEcho`, `echoNeedle`) and the `delivered-unverified` commit-then-report policy (#1584). The PR's `resolvePacingForSession` binding and its `--interrupt`-path pacing both still have homes; the surrounding code moved.

**No divergence at all:** `kimi-session-discovery.ts` (new file), the gate fixtures, and the doc files conflict only on adjacent-line churn.

### Two claims in the issue that do not survive checking

1. **"Drop `launchLoopTail` changes already on main."** Main still defines `launchLoopTail` module-locally in `spawn-worktree.ts:803`, byte-identical to the PR's relocated copy (diffed). The PR does not *change* the tail — it *moves* it into `utils/harness.ts` and exports it, because `KIMI_HARNESS.buildBuilderLaunchScript` needs it and `spawn-worktree.ts` already imports from `harness.ts` (so the move is the acyclic direction). **Plan: keep the relocation**, since dropping it would break the Kimi provider script. Flagged here rather than silently ignored.
2. **"kimi ≥ 0.33.0 … the branch was measured at 0.34.0 and it ships weekly."** Latest on npm today is **`@moonshot-ai/kimi-code@0.41.0`** — seven minors past the measured version. And `kimi` is **not installed on this machine** and there is no `~/.kimi-code` and no Moonshot credential in the environment. Items 3 and 5 are therefore **blocked on an authenticated Kimi CLI** (see *Blocked scope*).

---

## Proposed Change

Seven work items. Items 1–4 and 7 are unblocked and will be delivered in full; items 5–6 need a Kimi install (below).

### 1. Merge `origin/main` into `builder/pir-1201`

`git merge origin/main` on the branch, one merge commit, no rebase, no squash, no force-push. Conflicts resolved as *re-derivations*, not as textual picks — each of the five semantic files gets its own commit on top of the merge so the diff is reviewable seam by seam.

### 2. Re-derive the delivery path against converged main

**2a. Write edge (`message-write.ts`).** Keep the PR's `MessagePacing` interface and its `writeMessageToSession(..., pacing?)` threading verbatim — that function survived. Add `pacing?: MessagePacing` as the last parameter of `submitMessagePaced` and pass it through to the `writeMessageToSession` call inside `trySubmitToSession`'s callback. The Enter only moves *later*, and `trySubmitToSession` sleeps to the returned `doneMs`, so a slower Enter is awaited, never raced — the completion-chaining contract in the JSDoc still holds and gets a sentence saying so.

**2b. Delivery port + binding.** `DeliveryPorts.writeMessage` keeps main's 4-arg shape (`session, msg, noEnter, precheck`); pacing is resolved by the *binding*, not the port, because it is a property of the target session and no unit fake should have to know about it:
```ts
writeMessage: (session, msg, noEnter, precheck) =>
  submitMessagePaced(session, msg, noEnter, precheck, undefined, resolvePacingForSession(session)),
```
`resolvePacingForSession` and `resolveHarnessForSession` move over from the PR unchanged — they already read the harness out of the generated `.builder-start.sh`, are total (every failure degrades to the defaults), and cover cron delivery for free because `cron-delivery.ts` writes through the same `DeliveryPorts` seam.

**2c. `--interrupt` path (`tower-routes.ts`).** Re-derive onto main's shape (the `submitToSession(result.terminalId, …)` block, now ~line 2193): `writeMessageToSession(session, formattedMessage, noEnter, 100, resolvePacingForSession(session))`. Keep the PR's comment on the `escape` branch explaining why a bare ESC is deliberately *not* paced.

**2d. Gate details — delete the fork, delegate.** Remove `CLASSIFIER_STUCK_DETAILS` from `mailbox-delivery.ts` entirely; `isClassifierStuck` stays as main wrote it, a one-line delegation to `isUnverifiableVerdict`. Add both new details to `MailboxGateDetail`, to the `schema.ts` column comment, and to `isUnverifiableVerdict`:
- `no-region-start` → **unverifiable (escalates)**. A boxed composer with no box top on screen is a torn frame or a drifted profile; it never clears on its own. Uncontroversial.
- `multi-row-draft` → **unverifiable (escalates)**, per the issue's explicit instruction that a stuck Kimi hold "must escalate, never render as *a human at the line*". **This reverses the PR's choice**, and the reversal is defensible on its own terms: every other detail is a *cell count*, and `multi-row-draft` is the one verdict the classifier reaches when it *could not count* and inferred from box geometry instead. "The classifier could not verify this" is the more truthful rendering of that, and a streak of it is exactly the drift signal `recordStreak` exists to surface. **Cost, stated plainly:** a human genuinely sitting on a multi-line Kimi draft for `LIVENESS_STREAK_THRESHOLD` consecutive backstop ticks now contributes to a liveness streak. `surfaceLiveness` only alarms on *recent output*, which suppresses most of that — and, by the same token, partially suppresses the drift alarm too. That residual is why the issue files a `codev doctor` premise probe as a follow-up. **This is a decision the gate can flip**; the alternative (PR's original) is a one-line change.
- Replace the PR's compile-time exhaustiveness trick with a **test** in the codev package that enumerates `GateVerdict['detail']` and asserts every value is classified by `isUnverifiableVerdict`. That preserves what the fork was actually buying (the union cannot grow silently) without a second copy of the rule in a second package.

**2e. Marker anchoring (`render-gate.ts`).** Take main's `findMarkerRow` and its hoisted `top`/`cell`/`cursorRow` as the base; layer the PR's `regionStartPatterns` / `findRegionStart` / `markerSpanEnd` / per-row marker exemption / `growsWithDraft` on top. They are orthogonal: the anchors decide *which row is the marker*, the region start decides *where the scan begins*. Two specifics:
- **Do not give `KIMI_PROFILE` a `markerFgPalette`.** Main's implementation reads `line.getCell(0, cell)` — a hardcoded column 0, correct for agy (`^>`) and wrong for Kimi (`│ >`, column 3). Rather than leave that trap next to the first profile whose marker is not at column 0, generalize the anchor to read the cell at the marker match's **start** column (a `markerSpanStart` sibling of `markerSpanEnd`). Behaviour for agy/claude/codex is unchanged (their matches start at 0); the assertion is pinned by a test.
- **`markerRequiresCursorRow` for Kimi is a measurement question, not a design one.** `regionStartPatterns` already fixes the last-match hazard the PR documented, so the anchor is not required. It will be adopted only if the item-5 captures show spurious `│ >` rows on a live screen. Recorded here so the decision is visible either way.

**2f. Drop the PR's `render-gate.test.ts` / `spawn-worktree.test.ts` / `harness.test.ts` stubs that model the old write edge**, and re-express those assertions against `submitMessagePaced`'s result union.

### 3. Workspace-trust pre-write — the security change (#1328 class)

`ensureKimiWorkspaceTrust` (`utils/kimi-session-discovery.ts:456`) currently writes a trust record for any worktree, unconditionally, whenever a Kimi builder spawns. Kimi's folder trust gates exactly one thing — whether **project-level MCP servers** load from the folder — so writing it blind is a silent grant of "load whatever MCP servers this checkout ships" on the user's behalf. Two independent refusals, both defaulting to *do nothing*:

**3a. Refuse when the worktree carries project-level MCP config.** Scan `<worktree>/.mcp.json` and `<worktree>/.kimi-code/mcp.json`. If either exists, do not write; log which file caused the refusal and what the consequence is (the dialog will appear; the render gate will hold the task message with `no-composer-marker`, which is in the escalation class, so it surfaces rather than hanging silently). This is the one case where the trust decision is genuinely load-bearing, so it is the one case a human must make.

**3b. Refuse unless explicitly opted in.** Default **false**. Recommended key — `.codev/config.json`:
```json
{ "harnessOptions": { "kimi": { "autoTrustWorkspace": true } } }
```
> **Why not `harness.kimi.autoTrustWorkspace`, which is what the issue names as an example.** `harness.*` is already the *custom harness definition* namespace: `lib/config.ts:337-341` runs `validateCustomHarnessConfig` over **every** entry at load time, and that validator hard-requires `roleArgs` and `roleScriptFragment`. `harness.kimi: { autoTrustWorkspace: true }` would throw at config load and break unrelated commands (`afx status`, everything). And because `resolveHarness` gives built-ins priority, a `harness.kimi` entry is *already* dead config — overloading it would make a security opt-in live in a namespace where a neighbouring key is silently ignored. `harnessOptions` is a new, separately-typed, separately-validated namespace with none of that. **The issue wrote "e.g.", so this is a gate decision, not a deviation** — say the word and it becomes `harness.kimi.autoTrustWorkspace` with a carve-out in the validator.

**3c. Shape of the change.** `ensureKimiWorkspaceTrust` returns a decision rather than a bare boolean, so callers can log *why* and tests can assert each refusal distinctly:
```ts
export type KimiTrustDecision =
  | { wrote: true }
  | { wrote: false; reason: 'already-trusted' | 'not-opted-in' | 'project-mcp-config' | 'write-failed'; detail?: string };
```
`HarnessProvider.prepareWorkspace` widens to `prepareWorkspace?(worktreePath: string, opts: { autoTrustWorkspace: boolean }): void`. Both call sites resolve the flag from config: `startBuilderSession` already holds `config`; `buildWorktreeLaunchScript` holds `workspaceRoot`. Fail-soft is preserved throughout — a refusal is never a spawn failure.

**3d. Documented consequence, because it is not small.** A repository that ships a root `.mcp.json` will hit 3a on **every** Kimi builder worktree, so unattended Kimi spawning does not work there until a human trusts the folder once. That is the correct posture and it goes in the docs, not in a footnote.

**3e. Docs + tests.** `codev/resources/commands/agent-farm.md:1116-1146` and its `codev-skeleton/` mirror (both trees, per the dual-tree rule) get the opt-in, the default, and 3d. Tests cover: opted-out → no write; opted-in + `.mcp.json` → no write, reason `project-mcp-config`; opted-in + `.kimi-code/mcp.json` → same; opted-in + clean worktree → writes; existing record → `already-trusted`; unwritable home → `write-failed`, no throw.

### 4. Rewrite `codev/plans/1201-…md` to the shipped architecture

The approved 1201 plan still describes the **retired** seed-session design — `kimi -p` bootstrap, `.builder-seed.txt`, captured session id, `kimi -S <id>` loop, a sentinel-gated store-verified `BEGIN` PTY kick, and `message-pacing.ts`. None of that is in the branch; the 2026-08-09 pivot replaced it. Rewritten to what the code does: **mailbox task delivery** (the script calls `afx send <builderId>` on each fresh launch; no PTY write, so Spec 1313 holds), **`--agent-file` role injection** composed around `${base_prompt}`, **guarded `kimi -c` resume** (store probe on both stdout *and* exit status, superseded-id comparison for #1267 sticky-fresh), the **trust record** as amended by item 3, the **render-gate Kimi profile**, per-harness **Enter pacing**, and the **0.33.0 version floor**. This file is committed in the plan phase and approved together with this one.

### 5. Re-measure under verified delivery *(needs Kimi — see Blocked scope)*

Install the current `@moonshot-ai/kimi-code` (0.41.0 today; floor stays 0.33.0, never lowered), authenticate, then:
- Re-run the three existing measurement spikes — `pir-1201-kimi-gate-measure.mjs`, `pir-1201-kimi-box-growth.mjs`, `pir-1201-kimi-working-states.mjs` — and refresh the eight `__tests__/fixtures/gate/kimi-*.txt` captures. The `growsWithDraft` premise (box grows **only** for a multi-line draft; idle / single-line / `/` menu / `@` picker / post-reply steady state all hold at one interior row) is re-verified on the current engine or the rule does not ship.
- **New:** drive a real Kimi session through the *production* paced write and echo verification — `submitMessagePaced` + `watchEchoOnScreen` — and record what Kimi's composer and transcript do to the `### [ARCHITECT INSTRUCTION | <iso>] ###` header. Claude eats the `###` as a markdown H3 and `normalizeForEcho` absorbs it; Kimi is unmeasured. Record whether the needle confirms, and at which sample.
- If Kimi cannot be verified: **no code change is needed for safety** — #1584 already commits the delivery first and reports `delivered-unverified` + `markEscalatedDelivered` + `onUnverifiedDelivery`, so a negative can never loop. What ships instead is the *documented measurement* plus a doc line telling operators that Kimi deliveries are expected to read unverified, so the flag is not mistaken for a fault.
- Evidence (raw captures, transcripts, the driver's output) into `codev/evidence/1620-kimi-measurement/`.

### 6. Live demo re-run *(needs Kimi — see Blocked scope)*

`codev/spikes/pir-1201-kimi-builder-demo.mjs`, all 7 recorded scenarios, against the current CLI: (1) gate classifies the live composer, (2) role honored via `--agent-file` in the TUI, (3) multi-line delivery submits at the pinned Enter delay, (4a) crash restart consults the store probe and chooses resume, (4b) role survives `kimi -c`, (5) store probe fails closed on an empty store, (6) trust pre-record is idempotent. Scenario 6 is rewritten for the new `KimiTrustDecision` return and **two scenarios are added**: 6b — opted-out spawn writes no record; 6c — a worktree carrying `.mcp.json` writes no record and logs the refusal. Run under the `dev-approval` gate with the output attached.

### 7. Close the loop on the PR

- CMAP (gemini + codex + claude, parallel, background) after the implementation commits and again after the tests, per the repo's consultation rule.
- `codev/reviews/1620-…md` records every KEY_ISSUE from the 2026-09-04 3-way review as **addressed** or **explicitly dispositioned**. *I do not have the raw lane output* — the issue body's scope items 1–6 are its distillation, and I will work from those unless the architect hands me the transcript. Asked at the gate.
- Update `codev/resources/arch.md`'s Kimi subsection to the shipped design (it still describes the seed bootstrap) and route new lessons by tier.
- A courteous comment on PR #1203 summarising exactly what changed and why, crediting Mohid's original work, plus a rewritten PR description.
- Follow-up issues filed, each referencing #1203: `PreToolUse` write-guard parity for Kimi builders (#1018 class); a `codev doctor` premise probe for the box-growth assumption; Kimi echo-verification tolerance (#1578).

---

## Blocked scope

**Items 5 and 6 require an installed, authenticated Kimi CLI.** `kimi` is not on this machine, `~/.kimi-code` does not exist, and no Moonshot credential is in the environment. Installing is trivial (`npm i -g @moonshot-ai/kimi-code`); **authenticating is not something I can do** — it needs a Moonshot account or API key.

Everything else (items 1–4, 7, and every unit test) is delivered regardless. If no Kimi access appears, items 5–6 do not ship, the acceptance criterion "dev-approval evidence attached" cannot be met, and the honest outcome is a PR that is mergeable and re-planned but whose live re-verification is deferred — **which is the architect's call to make, not mine.** Asked explicitly at the gate.

---

## Files to Change

| Path | Change |
|---|---|
| `packages/codev/src/agent-farm/servers/message-write.ts` | `MessagePacing`; `pacing?` on `writeMessageToSession` (PR, kept) and on `submitMessagePaced` (new, re-derived) |
| `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` | `resolveHarnessForSession` / `resolvePacingForSession`; pacing threaded into the `writeMessage` binding |
| `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` | delete `CLASSIFIER_STUCK_DETAILS`; keep main's delegating `isClassifierStuck` |
| `packages/sdk/src/hold-verdict.ts` | `isUnverifiableVerdict` gains `no-region-start`, `multi-row-draft` |
| `packages/codev/src/agent-farm/db/types.ts:115` · `db/schema.ts:270` | `MailboxGateDetail` union + column comment gain both details |
| `packages/codev/src/agent-farm/servers/render-gate.ts` | `regionStartPatterns`, `growsWithDraft`, `markerSpanEnd`/`markerSpanStart`, `findRegionStart`, per-row marker exemption, `multi-row-draft` — layered on main's anchored `findMarkerRow`; `markerFgPalette` generalized off column 0 |
| `packages/codev/src/agent-farm/servers/gate-profiles.ts` | `KIMI_PROFILE` + registry entry |
| `packages/codev/src/agent-farm/servers/tower-routes.ts` | pacing on the `--interrupt` write; `escape` left unpaced with the reason |
| `packages/codev/src/agent-farm/utils/kimi-session-discovery.ts:456` | `ensureKimiWorkspaceTrust` → `KimiTrustDecision`; MCP-config refusal; opt-in gate |
| `packages/codev/src/agent-farm/utils/harness.ts` | `KIMI_HARNESS`; `launchLoopTail` relocated + exported; `prepareWorkspace` signature widened |
| `packages/codev/src/agent-farm/commands/spawn-worktree.ts` | provider-owned launch branch; resolve + pass `autoTrustWorkspace` |
| `packages/codev/src/agent-farm/types.ts` · `src/lib/config.ts` | `harnessOptions` block, typed + validated at load |
| `packages/codev/src/commands/doctor.ts` | Kimi presence / 0.33.0 floor / store + trust drift probes (PR, re-derived) |
| `codev/resources/commands/agent-farm.md` + `codev-skeleton/` mirror | trust opt-in, default, and the `.mcp.json` consequence |
| `codev/resources/arch.md` | Kimi subsection rewritten off the seed design |
| `codev/plans/1201-support-kimi-code-cli-as-a-bui.md` | rewritten to the shipped architecture (this phase) |
| `codev/spikes/pir-1201-kimi-builder-demo.mjs` | scenario 6 updated; 6b / 6c added |
| `__tests__/fixtures/gate/kimi-*.txt` | re-captured on the current CLI (item 5) |
| tests: `harness.test.ts`, `render-gate.test.ts`, `spawn-worktree.test.ts`, `mailbox-pacing.test.ts`, `kimi-session-discovery.test.ts`, `config.test.ts`, + new `hold-verdict` exhaustiveness test | |

---

## Risks & Alternatives Considered

- **Risk — a 1,606-commit merge hides a semantic break behind a clean textual resolution.** Mitigation: the five semantic files each get their own post-merge commit with the reasoning in the message, and CMAP runs on the delta with the render-gate edit flagged for hardest scrutiny (the same instruction the 2026-08-09 round used).
- **Risk — `markerFgPalette`'s hardcoded `getCell(0)`.** Latent today (only agy uses it, marker at column 0), a live bug the moment anyone gives Kimi a palette anchor. Generalizing it now costs one helper and one test; leaving it is a trap laid directly under the first non-column-0 profile.
- **Risk — `multi-row-draft` escalation false-alarms on a real human draft.** Accepted with the cost stated in 2d, and flagged as gate-reversible in one line.
- **Risk — the 0.34.0 → 0.41.0 drift repeats the exact failure this lane exists to fix.** Nothing prevents another seven-minor gap. Mitigation is not a code change: the doctor drift probes (store layout + trust-record naming) already fail loudly on a scheme change, and the follow-up premise probe covers the box-growth assumption.
- **Alternative rejected — cherry-pick Mohid's work onto a fresh maintainer branch.** Cleaner diff, but it drops his authorship and abandons PR #1203, which the owner decision explicitly forbids.
- **Alternative rejected — `harness.kimi.autoTrustWorkspace`.** Reasons under 3b.
- **Alternative rejected — make trust pre-write default-on with an opt-*out*.** Preserves unattended spawning out of the box, and is exactly the "silently grant a capability the user never chose" shape #1328 is named for. Default-off is the only direction where the failure mode is an inconvenience rather than a security event.

---

## Test Plan

**Unit (vitest):**
- Pacing survives the lock: `submitMessagePaced` with a Kimi `MessagePacing` schedules Enter at 1000 ms, still resolves only after the Enter, and reports `written`; `contended` and `aborted` are unaffected by pacing.
- `resolvePacingForSession` is total: unreadable worktree, unknown harness, retired harness, custom harness → `undefined`, never a throw.
- `isUnverifiableVerdict` exhaustiveness: every `GateVerdict['detail']` value is classified; `no-region-start` and `multi-row-draft` escalate; `user-text` and `empty` do not.
- Render gate against the Kimi fixtures: idle → `clean`; single-line draft → `user-text`; newline-then-`>` draft → `multi-row-draft`; box top off-screen → `no-region-start`; trust dialog → `no-composer-marker`; `/` menu and `@` picker → busy. Plus the guardrail pinning `markerSpanEnd` for **every** shipped profile (that number is what "no-op for claude/codex/agy" rests on) and the new `markerSpanStart` palette-anchor test.
- Trust: the six cases in 3e.
- Config: `harnessOptions` parses, defaults false, rejects a non-boolean, and a legacy config with no block behaves as opted-out.

**Build + suites:** `pnpm build` clean; full `pnpm test` green including the `codev-core`/`codev-sdk` boundary tests (the `hold-verdict.ts` edit touches the SDK, so the isolation tests are load-bearing here).

**Manual, at `dev-approval` (the reviewer drives the running worktree):**
1. `pnpm -w run local-install`, then from the main workspace root `afx spawn --task "<small task>" --builder-cmd kimi` — with `harnessOptions.kimi.autoTrustWorkspace` **unset**: the trust dialog appears, the log names the refusal, the task message is *held* (not lost), and `afx inbox` shows it.
2. Same spawn with the opt-in set and a clean worktree: trust is pre-recorded, the composer renders, the task delivers.
3. Same spawn with the opt-in set and a `.mcp.json` in the repo root: **no** record is written, the log names `project-mcp-config`, the dialog appears.
4. `afx send <builder-id>` with a >3-line message → arrives as one submitted message (the 1000 ms Enter), and the log line says `delivered` or `delivered-unverified` — matching what item 5 measured.
5. `codev doctor` with kimi installed → presence, 0.33.0 floor, store and trust drift probes.
6. `node codev/spikes/pir-1201-kimi-builder-demo.mjs` → 9/9 (the 7 original scenarios plus 6b/6c).

**Cross-platform:** macOS only. Kimi's store and trust paths are `$HOME`-relative and the code already routes them through `KIMI_CODE_HOME`, so the tests are platform-independent; the live demo is not re-run on Linux/Windows and that is stated rather than implied.
