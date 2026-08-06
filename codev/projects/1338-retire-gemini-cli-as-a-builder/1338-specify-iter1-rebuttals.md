# Spec 1338 — Rebuttals, Specify iteration 1

Reviews: **Gemini APPROVE**, **Codex REQUEST_CHANGES**, **Claude REQUEST_CHANGES**.
Disposition: all substantive points **accepted and incorporated**. No point rejected. Details below.

---

## Claude (REQUEST_CHANGES) — verified against source, high confidence

### C1 (blocking) — `resolveHarness` is role-agnostic; architect outcome undefined
**Accepted.** Correct and important: `resolveHarness(harnessName, customHarnesses, command)`
(harness.ts:358) takes no role parameter and is shared by `getArchitectHarness` (config.ts:261) and
`getBuilderHarness` (config.ts:280). A sentinel inside it retires gemini for **both** roles.
**Decision — accept role-agnostic retirement** (Claude's recommended option): the upstream CLI is
unavailable for the same tiers regardless of role, and gemini-as-architect is *already* unsupported
(doctor warns today), so failing closed for both roles is the correct, minimal implementation —
preferable to threading a role parameter through a shared signature.
**Changes**: new Clarifying Question 4; Desired State now covers architect + builder; a dedicated
Success Criterion for the architect path (`getArchitectHarness` / `--architect-cmd gemini`); Test
Scenario 4; README criterion now covers **both** the architect and builder lines of the config
example (README:456-457). Flagged to the architect at the gate as a slight broadening of mechanism
beyond "builder-only."

### C2 — Doctor's architect branch needs a defined end state, not a reworded string
**Accepted.** The branch's premise ("supported for builders") fully inverts post-retirement.
**Changes**: Desired State now defines the new end state — the `gemini` branch presents the
retirement for both roles **and** doctor additionally flags a `gemini` *builder* config. Test
Scenario 7 and the doctor Success Criterion now assert on the **structured `issue:`/`recommendation:`
fields** (doctor.ts:826) rather than console text, per your stability suggestion.

### C3 — Problem Statement's "silently falls back to Claude" is imprecise
**Accepted** — this was factually loose. Tightened to the **two** distinct failure modes, matching
the code exactly:
- remove detector case **and** registry entry → `detected` is undefined → `return CLAUDE_HARNESS`
  (harness.ts:392) = silent Claude fallback;
- remove **only** the registry entry → `detected === 'gemini'` → `return BUILTIN_HARNESSES['gemini']`
  (harness.ts:387) = `undefined` → TypeError.
**Changes**: Problem Statement rewritten with both modes; Approach 1 now explicitly guards *before*
both :387 and :392; Security Considerations + Non-Functional Test 3 assert the retired paths return
neither `CLAUDE_HARNESS` nor `undefined`.

### C4 — `afx reset` is underweighted as "Nice-to-Know"; record as decided
**Accepted.** `harnessFromLaunchScript` (reset/context.ts:414) derives its recognizable set from
`Object.keys(BUILTIN_HARNESSES)`; dropping gemini → pre-existing gemini builder → `null` → reset
declines. **Changes**: moved out of Open Questions into **Assumptions** as a decided/accepted outcome
(a retired harness can't context-reset anyway — only Claude declares `supportsContextReset` — and
reset already refuses unrecognized harnesses loudly). Gemini's review independently agreed this is
acceptable.

### C5 — Minor (coverage baseline; decide the doctor open question)
**Accepted both.** "No reduction in coverage" reframed to **replacement** (each removed gemini test
→ a retirement-behavior test); the "Important" doctor open question is now **decided (yes)** and is a
Success Criterion, so the plan inherits no unresolved criterion.

---

## Codex (REQUEST_CHANGES) — high confidence

### X1 — "CLI no longer exists / gone" is inaccurate; frame as a Codev product retirement
**Accepted.** Google ended **consumer-account** (free/Pro/Ultra) access on 2026-06-18;
Standard/Enterprise subscriptions and API-key auth reportedly remain. **Changes**: Problem Statement
+ Clarifying Question 2 reframe this as a **Codev product retirement** of the built-in option (not a
claim the binary is gone everywhere); the retained-access path is served via a **custom harness**
(Assumptions). The retirement *message* says the built-in option is retired, not "the CLI no longer
exists."

### X2 — Resolve the `codev doctor` open question in the spec, not the plan
**Accepted.** Now decided in-spec: doctor **must** flag a `gemini` builder configuration with the
retirement explanation, and its architect branch is redefined (no longer "supported for builders").
Promoted from Open Question to Success Criterion + Test Scenario 7.

### X3 — "Every path" is broader than the tests specified
**Accepted.** **Changes**: Test Scenarios now cover the real config integration paths —
`getBuilderHarness`, the `--builder-cmd gemini` CLI override, and the **array-form** builder command
(`builder: ["gemini", "--yolo"]`) — plus the architect twin (`getArchitectHarness` /
`--architect-cmd gemini`), not only direct `resolveHarness` calls. Matching Success Criteria added.

### X4 — Clarify the repo-wide documentation criterion (exempt historical + consult refs)
**Accepted.** **Changes**: the documentation criterion (Non-Functional Test 1 + the final Success
Criterion) is now scoped to **current, user-facing harness-selection docs** only, and **explicitly
exempts** historical artifacts (`codev/specs`, `plans`, `reviews`, `projects`, `docs/releases/*`) and
every `consult -m gemini` / `agy` reference — removing the conflict with the consult-lane non-goal.

---

## Gemini (APPROVE)
No changes required. Confirmed Approach 1 as the correct fit, the footgun analysis as accurate, and
that `afx reset` leave-as-is is acceptable (folded into the C4 decision) and doctor should flag
builder-side gemini (folded into X2/C5). Its confirmations reinforce the decisions above.

---

## Net effect
No design reversal — the recommended **Approach 1 (retirement sentinel in the shared resolver)**
stands and is strengthened: precise two-mode footgun analysis, explicit role-agnostic scope, a
defined doctor end state with builder-side flagging, broader integration-path test coverage, accurate
"Codev product retirement" framing, and a scoped documentation criterion. Ready for re-verification.
