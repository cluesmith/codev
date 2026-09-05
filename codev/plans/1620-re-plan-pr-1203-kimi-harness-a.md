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
2. **"kimi ≥ 0.33.0 … the branch was measured at 0.34.0 and it ships weekly."** Latest on npm today is **`@moonshot-ai/kimi-code@0.41.0`** — seven minors past the measured version. And `kimi` is **not installed on this machine** and there is no `~/.kimi-code` and no Moonshot credential in the environment. The 2026-09-05 human decision is that this lane does **not** re-measure: no authenticated Kimi here, no credentials to supply, so items 5 and 6 go to @mohidmakhdoomi (see *What this lane does not do*).

---

## Proposed Change

Seven work items. **Items 1–4 and 7 are this lane's deliverable and ship in full.** Items 5–6 need an authenticated Kimi, which is not available here, and are handed to @mohidmakhdoomi (below).

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

**2g. Task queueing races builder registration — a real defect, found chasing claude's §7.**
The generated Kimi script queues the task with `afx send <builderId> "$(cat .builder-prompt.txt)"`,
run with cwd inside the worktree. Two problems, both verified against main:

- **The race.** `spawn.ts` calls `upsertBuilder` **after** `startBuilderSession` returns (`spawn.ts:482`
  then `:488`), but the script's first act is that `afx send`. `detectCurrentBuilderId()` resolves the
  *sender* from cwd and **throws** `BuilderIdResolutionError` when no builder row exists yet
  (`commands/send.ts:167` — "Refusing to send with an unverified identity"), which `fatal()`s the CLI.
  The script's `if afx send …; then` then fails, prints its warning, and **does not retry within that
  launch** — so the builder starts with a role and no mission, and the only trace is one line in the
  PTY. Today this is saved solely by node's startup latency exceeding one local HTTP round-trip.
  **Fix: give `codev_queue_task` a bounded retry** (~30 s, a few seconds apart) before it warns.
  Script-local, no change to the shared spawn path. Reordering `upsertBuilder` ahead of
  `startBuilderSession` is the tempting root fix and is **rejected**: the row carries `terminalId`,
  which only exists after the session starts, so it would mean two upserts on the path every harness
  shares — real blast radius to fix a Kimi-only symptom.
- **The attribution.** Sender resolves to the builder's *own* id, so the task arrives framed
  `### [BUILDER <id> MESSAGE → <id> | …] ###` — a builder's opening mission presented as a peer
  message from itself. There is no self-send guard anywhere in `handleSend`. `.builder-prompt.txt` is
  already a fully-framed spawn prompt, so **plan: pass `--raw`** and let it arrive as itself. Echo
  verification still works — `watchEchoOnScreen` compares against a pre-write *count*, so a stable
  first line is fine. This is verified end-to-end at the dev-approval gate rather than asserted; if
  `--raw` reads badly, the fallback is a small explicit-attribution flag on `afx send`.

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

### 5–6. Live re-measurement and the demo re-run — **handed to @mohidmakhdoomi**

Human decision, 2026-09-05: there is no authenticated Kimi available on this side and no
credentials to supply, so **this lane does not run items 5 and 6.** They go to Mohid, who has an
authenticated Kimi and ran the original 7/7 demo; the architect has asked him on PR #1203 to
review our commits and run both on his side. His evidence attaches to PR #1203.

What that changes for *our* work — stated here because it is not free:

- **`KIMI_PROFILE` ships on 0.34.0-era measurement**, not on a fresh capture. The eight
  `fixtures/gate/kimi-*.txt` captures stay as Mohid recorded them, and the `growsWithDraft`
  premise — the load-bearing "the box grows a row only when the draft gains a line" claim — is
  **re-verified by him, not by us.** Where the code asserts a measured fact, the comment says
  which version measured it.
- **`markerRequiresCursorRow` is not adopted for Kimi.** The plan previously made it conditional
  on new captures; with no captures, the honest answer is "not adopted, and here is the question
  someone must answer" — it goes on Mohid's checklist rather than being guessed at.
- **Kimi's echo behaviour under #1573/#1584 stays unmeasured by us.** No code change is needed for
  safety: #1584 already commits the delivery first and reports `delivered-unverified` +
  `markEscalatedDelivered` + `onUnverifiedDelivery`, so an unconfirmed Kimi delivery can never
  loop. What is missing is the *number*, and Mohid supplies it.
- **The burden shifts onto proving no regression for the measured harnesses.** We are editing
  `render-gate.ts`, `message-write.ts` and `hold-verdict.ts` — code that carries claude, codex and
  agy delivery for every user — without being able to exercise the one harness the change is *for*.
  So "claude/codex/agy behave identically" stops being a footnote and becomes the primary thing our
  own dev-approval gate proves (see Test Plan).


### 7. Close the loop on the PR

- CMAP (gemini + codex + claude, parallel, background) after the implementation commits and again after the tests, per the repo's consultation rule.
- `codev/reviews/1620-…md` records every KEY_ISSUE from the 2026-09-04 3-way review as **addressed** or **explicitly dispositioned**. *I do not have the raw lane output* — the issue body's scope items 1–6 are its distillation, and I will work from those unless the architect hands me the transcript. Asked at the gate.
- Update `codev/resources/arch.md`'s Kimi subsection to the shipped design (it still describes the seed bootstrap) and route new lessons by tier.
- A courteous comment on PR #1203 summarising exactly what changed and why, crediting Mohid's original work, plus a rewritten PR description.
- Follow-up issues filed **before merge, not open-ended**, each referencing #1203: `PreToolUse`
  write-guard parity for Kimi builders (#1018 class); a `codev doctor` premise probe for the
  box-growth assumption; Kimi echo-verification tolerance (#1578).
- **The write-guard gap is bounded by both lanes that raised it.** codex accepts it as follow-up
  *"if maintainers explicitly accept that limitation"* — so the review doc records that acceptance
  explicitly, in the maintainer's words, rather than implying it. claude is stricter: if it is
  follow-up, it *"should gate documenting kimi as supported, not be open-ended"* — so the
  `agent-farm.md` paragraph (both trees) states the gap **where Kimi is documented as supported**,
  with the follow-up issue number, and the stale *"kimi has no documented hook seam"* claim is
  corrected (kimi has documented blocking `PreToolUse` hooks since 0.32.0, which is what makes the
  follow-up achievable rather than impossible).
- **Echo-verification cost recorded, not discovered later.** claude's §6 computes it: `enterDelayMs`
  1000 plus two 600 ms verify windows makes a Kimi `afx send` cost ~2.2 s worst case, and every
  message may report `delivered-unverified`. @mohidmakhdoomi measures whether it actually does (item 7
  checklist step 4); either way the number goes in the review doc as an accepted cost, so nobody
  reads the flag as a fault.

---
- **A handoff checklist for @mohidmakhdoomi, posted as a PR comment the moment the implementation
  commits are pushed** — specific enough that his round is one pass, not a negotiation:

  ```bash
  gh pr checkout 1203 && git pull          # our merge + commits are on your branch
  pnpm install && pnpm build && pnpm test  # expect green before touching kimi
  npm i -g @moonshot-ai/kimi-code          # 0.41.0 today; floor stays 0.33.0
  kimi --version                           # record it — it goes in the evidence
  ```

  1. **Re-capture the eight gate fixtures** on your Kimi version, into
     `packages/codev/src/agent-farm/__tests__/fixtures/gate/`: `kimi-idle.clean.txt`,
     `kimi-draft.busy.txt`, `kimi-multiline.busy.txt`, `kimi-multiline-bare.busy.txt`,
     `kimi-newline-bare.busy.txt`, `kimi-menu.busy.txt`, `kimi-picker.busy.txt`,
     `kimi-trust.busy.txt` — plus the version stamp in that directory's `README.md`.
     Driver: `node codev/spikes/pir-1201-kimi-gate-measure.mjs`.
  2. **Re-verify the `growsWithDraft` premise** — `node codev/spikes/pir-1201-kimi-box-growth.mjs`
     and `node codev/spikes/pir-1201-kimi-working-states.mjs`. The load-bearing row is the
     **post-reply steady state**: if a composer that has already carried a turn grows past one
     interior row, the rule holds every later message forever and **must not ship** as-is. Idle,
     single-line draft, `/` menu, `@` picker, mid-generation, shift+tab chrome and a
     draft-while-working must all sit at exactly one interior row.
  3. **Answer the one question we could not**: on a live screen, does anything *other* than the
     composer match `/^\s*│\s*>/`? If yes, `KIMI_PROFILE` should take
     `markerRequiresCursorRow: true` (the #1474 anchor) and we will add it. If no, say so and we
     record that the region bound alone is sufficient.
  4. **Measure verified delivery (#1573/#1584)** — the genuinely new one, and the reason this is
     not just a demo re-run. Drive a real Kimi through the *production* paced write and echo
     verification (`submitMessagePaced` → `watchEchoOnScreen`) and record what Kimi's composer and
     transcript do to the `### [ARCHITECT INSTRUCTION | <iso>] ###` header. claude eats the `###`
     as a markdown H3 and `normalizeForEcho` absorbs that; Kimi is unmeasured. Report: does the
     needle confirm, on which sample, and what is the wall-clock cost per `afx send` (we predict
     ~2.2 s worst case — 1000 ms Enter + two 600 ms windows). **A negative is a fine outcome**, not
     a failure: #1584 commits first and reports `delivered-unverified`, so it can never loop. We
     just need to know, so the docs can say it rather than operators discovering it.
  5. **Run the demo driver** — `node codev/spikes/pir-1201-kimi-builder-demo.mjs`. Now **9**
     scenarios: the original 7, plus **6b** (an opted-out spawn writes no trust record) and **6c**
     (a worktree carrying `.mcp.json` writes no record and logs `project-mcp-config`). Scenario 6
     changed shape — `ensureKimiWorkspaceTrust` returns a `KimiTrustDecision`, not a boolean.
  6. **Exercise the spawn-race retry** (item 2g): spawn a Kimi builder and confirm the task
     actually arrives. If you can, start it with Tower under load so `codev_queue_task`'s first
     attempt loses the race — the retry should win and the task should still land.
  7. **Evidence** → `codev/evidence/1620-kimi-measurement/`, committed to the branch: the Kimi
     version, raw captures, the demo driver's full output, and the verified-delivery numbers.
     A PR comment with the headline results is enough for us to finish the review doc.

  Anything that fails, tell us and we fix it on this side — you should not have to touch the
  TypeScript.

## KEY_ISSUES disposition (2026-09-04 3-way review)

Raw lane output received from the architect after the plan was drafted. Every KEY_ISSUE from all
three lanes, and where this plan answers it. This table is the skeleton of the review doc.

| Lane | KEY_ISSUE | Where answered |
|---|---|---|
| gemini | *(none — APPROVE)* | Its two integration notes (0.33.0 floor is correct; write-guard as follow-up is appropriate) are honoured in the 1201 plan's floor section and in item 7. |
| codex | Trust pre-write silently enables repo-controlled MCP servers; refuse on project MCP config, preferably behind an explicit opt-in | **Item 3** — both refusals, opt-in defaulting to off |
| codex | The approved plan no longer describes the implementation | **Item 4** — `codev/plans/1201-…md` rewritten this phase, re-approved at this gate |
| codex | Write-guard limitation acceptable as follow-up *only if maintainers explicitly accept it* | **Item 7** — acceptance recorded in the maintainer's own words in the review doc |
| claude | Branch `CONFLICTING`, 1,603 behind; `writeMessagePaced`, `findMarkerRow`, `launchLoopTail` all moved | **Items 1, 2a, 2e** (and the correction: `launchLoopTail` did *not* move on main — the PR relocates it, and that relocation is kept, which claude's own integration notes also recommend) |
| claude | New `GateVerdict` details bypass #1482: absent from `MailboxGateDetail` / `isUnverifiableVerdict`, predicate re-forked locally | **Item 2d** — fork deleted, both details added in all three places, plus an exhaustiveness test |
| claude | `multi-row-draft` holds on geometry but is excluded from the stuck set; no doctor probe covers the box-growth premise | **Item 2d** — we take the *escalate* branch of claude's own "either escalate or add a doctor probe"; the probe is filed as a follow-up. Note this supersedes the `multi-row-draft → false` parenthetical in claude's §2, which its §3 then argues against. |
| claude | Trust pre-write should refuse when the worktree carries project-level MCP config | **Item 3a** |
| claude | No `PreToolUse` write guard while kimi is documented as supported | **Item 7** — follow-up filed before merge and referenced from the docs *where kimi is documented as supported*, per claude's own bound |
| claude | Kimi echo behaviour unmeasured against #1573/#1584; the 7/7 demo predates that path | **Item 7 checklist step 4** — @mohidmakhdoomi measures it; the ~2.2 s predicted cost and his result both go in the review doc |
| claude | §7 *(not a KEY_ISSUE, but it found a real one)* — confirm what a builder self-send attributes to | **Item 2g** — chasing it surfaced an unguarded race that can drop a Kimi builder's task entirely |

---

## What this lane does not do

**Items 5 and 6 are not ours.** Human decision, 2026-09-05: no authenticated Kimi here and no
credentials to supply, so live re-measurement and the demo re-run are handed to
@mohidmakhdoomi, whose evidence attaches to PR #1203.

Consequences, recorded so that nobody has to reconstruct them later:

- **We do not claim the feature was live-verified.** The review doc says so in plain words: this
  lane merged, re-derived, secured and re-planned the work, and did **not** run Kimi. It also names
  the drift — the branch was measured on **0.34.0**; latest is **0.41.0**, seven minors on, which is
  the same failure mode this lane exists to repair, recurring.
- **Our `dev-approval` gate is scoped to what is verifiable without Kimi**: config parsing, `afx
  status` and the rest of the CLI unaffected, the generated launch scripts for every *existing*
  harness byte-identical, and the full suite green. See Test Plan.
- **The Kimi-side acceptance bar moves to Mohid's round.** If his results contradict a measured
  claim in the code — the `growsWithDraft` premise above all — the fix comes back to this lane
  before merge. That is a real possibility, not a formality.

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
| `__tests__/fixtures/gate/kimi-*.txt` | **unchanged by this lane** — 0.34.0 captures; re-captured by @mohidmakhdoomi (item 7 checklist step 1) |
| tests: `harness.test.ts`, `render-gate.test.ts`, `spawn-worktree.test.ts`, `mailbox-pacing.test.ts`, `kimi-session-discovery.test.ts`, `config.test.ts`, + new `hold-verdict` exhaustiveness test | |

---

## Risks & Alternatives Considered

- **Risk — a 1,606-commit merge hides a semantic break behind a clean textual resolution.** Mitigation: the five semantic files each get their own post-merge commit with the reasoning in the message, and CMAP runs on the delta with the render-gate edit flagged for hardest scrutiny (the same instruction the 2026-08-09 round used).
- **Risk — `markerFgPalette`'s hardcoded `getCell(0)`.** Latent today (only agy uses it, marker at column 0), a live bug the moment anyone gives Kimi a palette anchor. Generalizing it now costs one helper and one test; leaving it is a trap laid directly under the first non-column-0 profile.
- **Risk — `multi-row-draft` escalation false-alarms on a real human draft.** Accepted with the cost stated in 2d, and flagged as gate-reversible in one line.
- **Risk — the 0.34.0 → 0.41.0 drift repeats the exact failure this lane exists to fix.** Nothing prevents another seven-minor gap. Mitigation is not a code change: the doctor drift probes (store layout + trust-record naming) already fail loudly on a scheme change, and the follow-up premise probe covers the box-growth assumption.
- **Risk — we ship a Kimi feature none of us ran.** The measured claims in the code (the
  `growsWithDraft` box-growth premise above all) rest on 0.34.0 captures; latest is 0.41.0. This is
  the *same* staleness that made PR #1203 un-mergeable, and no code change removes it. Mitigation is
  procedural and partial, and worth naming as such: Mohid re-verifies before merge (item 7
  checklist), the doctor drift probes fail loudly if the store or trust schemes move, and the
  box-growth premise gets its own doctor probe as a filed follow-up. If Mohid's round contradicts a
  measured claim, the fix returns to this lane rather than shipping.
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

**Manual, at `dev-approval` — deliberately all non-Kimi.** With no Kimi on this side, the thing
our gate can actually prove is that a change *for* Kimi did not move anything *else*. That is the
larger risk anyway: `render-gate.ts`, `message-write.ts` and `hold-verdict.ts` carry claude, codex
and agy delivery for every user.

1. **The measured harnesses are untouched.** Generate a builder launch script for claude, codex
   and opencode before and after the change and diff them — **byte-identical**, or the change is
   wrong. (`markerSpanEnd` is a no-op only because every existing marker matches at column 0 with a
   1–2 cell span; the guardrail test pins that number per profile, and this is its manual mirror.)
2. **Live delivery to a claude builder still works end-to-end** — `afx spawn`, then `afx send`
   with a multi-line body: it arrives as one submitted message and the log says `delivered`, not
   `delivered-unverified`. This is the regression that would matter most and the one a green suite
   is least likely to catch (the #1573 echo path is timing-dependent).
3. **A held row still renders correctly.** Put a claude builder's composer in a draft state, send
   to it, and check `afx inbox`: the hold reads `busy:user-text`, *not* an unverifiable verdict.
   Proves the `isUnverifiableVerdict` edit did not widen the escalation class for existing details.
4. **Config**: with no `harnessOptions` block, `afx status`, `afx spawn --help` and `codev doctor`
   behave exactly as before; with a malformed one, the failure is loud and names the key.
5. **`codev doctor` with kimi absent** (the state of this machine) degrades cleanly — reports kimi
   not installed, does not throw, and does not fail the run.
6. Full `pnpm build` + `pnpm test` green, including the `codev-core` / `codev-sdk` boundary tests.

**Kimi-side verification is @mohidmakhdoomi's round**, per the checklist in item 7 — the nine demo
scenarios, the fixture re-capture, the `growsWithDraft` re-verification, and the verified-delivery
measurement. This lane does not sign off on those and the review doc says so.

**Cross-platform:** macOS only. Kimi's store and trust paths are `$HOME`-relative and the code already routes them through `KIMI_CODE_HOME`, so the tests are platform-independent; the live demo is not re-run on Linux/Windows and that is stated rather than implied.
