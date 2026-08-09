# CMAP dispositions — architect integration review follow-up (2026-08-09)

Round: the architect's three non-blocking findings on PR #1203 at head `4a7e2afe`, plus the
3-way review of the resulting delta. Prior round's dispositions are in
`1201-cmap-postpivot-dispositions.md`; this file covers only this delta.

Verdicts on the delta: **gemini APPROVE · codex REQUEST_CHANGES · claude APPROVE-with-changes**.
Every finding from both non-approving reviews was accepted. Nothing was rejected.

Scope note: a mid-round architect message fenced the PR's three open maintainer decisions (trust
pre-write, 0.33.0 version floor, write-guard parity as follow-up). None were touched.

---

## Architect finding 1 — residual false-CLEAN for an all-exempt draft

**Measure-first, per instruction. The premise holds**, so the rule was implemented rather than
documented as a residual.

Measured on real kimi 0.34.0 (`codev/spikes/pir-1201-kimi-box-growth.mjs`), interior rows =
`endRow - startRow`, the rows the classifier actually scans:

| state | interior rows |
|---|---|
| idle | 1 |
| single-line draft | 1 |
| `/` command menu | 1 |
| `@` file picker | 1 |
| post-reply steady state | 1 |
| newline + bare `>` | **2** |
| newline only | **2** |
| long soft-wrapped single line | **2** (carries text → already busy; verdict unchanged) |

The steady-state row is the load-bearing one: growth on a composer that has already carried a
turn would hold every later message forever — a liveness failure, which is worse than the
fail-safe direction the gate normally errs toward.

The review then surfaced a class the spike had not enumerated (claude Q2), so it was measured
too (`pir-1201-kimi-working-states.mjs`): mid-generation at 5s and 13s, shift+tab mode chrome,
and a draft typed while the agent is working are **all one interior row**. So the rule does not
convert "deliver while busy" into "hold until idle". (`!` bash mode classifies
`no-composer-marker` and holds — pre-existing, fail-safe, and correct: there is unsent input on
that row.)

### Deviation from the suggested implementation

The architect's sketch short-circuited on geometry **before** the cell scan. Implemented that
way it changed an existing fixture's verdict detail — `kimi-multiline-bare` went from
`user-text` to `multi-row-draft`, because that draft is also multi-row — which would have
retired what the older guardrail test was actually testing and demoted the cell scan from
ground truth to dead weight on every multi-row screen. Moved **after** the scan: `userCells > 0`
still wins and still reports `user-text`; `multi-row-draft` is reserved for the case the count
is blind to. Every pre-existing fixture verdict is unchanged. claude independently confirmed
this ordering is not just preferable but *enforced* by the existing assertion at
`render-gate.test.ts:194`.

---

## codex #1 / claude Q5+F1 — arming coupled to `regionStartPatterns` — **ACCEPTED**

Both reviewers independently flagged that arming the rule off `regionStartPatterns` overloads a
field that means "the composer has an upper boundary" with an unrelated claim ("box height
tracks draft lines").

claude supplied evidence that makes this concrete rather than stylistic, **which I verified
myself** with a geometry probe over every shipped fixture: `codex-idle.clean.txt` — a real,
captured, genuinely **empty** codex composer — already spans **two interior rows**
(`marker=18 start=18 end=20`). The rule's geometric predicate is *already true* on a screen that
must stay clean; only the arming gate stands between that capture and codex mail being held
forever. The day anyone declared a region start for codex (a header bound, a boxed redesign),
delivery would die silently.

Decoupled into an explicit profile field, `growsWithDraft?: true`, set only on `KIMI_PROFILE`.
The rule now requires **both**: `growsWithDraft` (the measured promise) and `hasRegionStart`
(what makes the arithmetic mean "interior rows" at all). codex proposed
`maxCleanInteriorRows?: number` instead; chose the boolean because it encodes the *measured
premise* rather than a tunable number, and a wrong threshold under it is caught by the app's own
idle fixture, which must classify clean. Pinned by three tests, all now built on codex's real
capture rather than a constructed screen: inert when neither field is set, inert with either one
alone, and armed only with both.

## codex #2 / claude F4 — fast-fail hint not universally accurate — **ACCEPTED**

My reworded echo asserted unconditionally that "an undelivered task is still queued on the
mailbox". False in a reachable third case: `codev_task_queued` is set only on a **successful**
`afx send`, so if afx is off PATH or Tower is down the flag is still 0, nothing is queued, and
the fresh relaunch really does retry it. The hint now branches on `[ "$codev_task_queued" = 1 ]`
and states the truth in both cases. Behavior still unchanged; this was a message-accuracy fix on
top of a message-accuracy fix.

## codex #3 / claude F5 — tradeoff comment overstates delivery — **ACCEPTED**

"true whenever the operator saw a composer to /quit from" is too strong: seeing a composer is
necessary, not sufficient — the gate also has to have polled it empty at least once. Softened,
and the quit-before-delivery race is now named alongside the trust-dialog case.

## claude F2 — `isClassifierStuck` silently omitted the new detail — **ACCEPTED**

`mailbox-delivery.ts` enumerated stuck details as a closed `||` chain, so widening
`GateVerdict['detail']` did not force a decision. claude checked the resulting behavior and it
was *right* (excluding `multi-row-draft` is correct — it is a human on a draft, and the
premise-failure reading carries no recent output, which `surfaceLiveness` requires to alarm),
but it read as an oversight. Replaced with a `Record<GateVerdict['detail'], boolean>` map, so
the next new detail is a **compile error** rather than a silent `false`, and documented why
`multi-row-draft` sits on the excluded side.

## claude F3 + codex test note — the differential used constructed screens — **ACCEPTED**

codex noted the armed/unarmed halves were "not literally the same bytes despite the comment";
claude asked for the real codex-idle geometry to be cited. Both are answered by the same change:
the test now classifies the **actual `codex-idle.clean.txt` capture** under four profile
variants — shipped, armed, bounded-only, grows-only — so the differential runs on identical real
bytes and the hazard is demonstrated rather than described.

## claude Q1 nit — non-null assertion — **ACCEPTED**

`hasRegionStart` is now a type predicate (`patterns is RegExp[]`), so the `startPatterns!`
assertion is gone and the narrowing is checked rather than conventional. (Applied before
claude's review landed; it had read the pre-edit file.)

---

## Verification

- `pnpm build` clean; `tsc --noEmit` clean.
- Full suite **4906 passed / 48 skipped / 0 failed** (+6 on the pre-round 4900: five new tests
  and one new fixture).
- Targeted suites — render-gate, harness, harness-integration, spawn-worktree, mailbox-pacing,
  kimi-session-discovery — green.
- Two new live measurements against real kimi 0.34.0, both committed as reproducible spikes.
- No live demo re-run: the rule can only alter verdicts for a kimi composer past one interior
  row, and delivery targets the idle composer, measured at one row in every state including
  mid-generation.
