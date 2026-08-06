### Iteration 1 Reviews
- gemini: APPROVE — README and CHANGELOG updates accurately reflect the retirement of the Gemini CLI harness as specified in Phase 4.
- codex: REQUEST_CHANGES — The retirement messaging is present, but the documented migration path is incomplete and partly misleading.
- claude: REQUEST_CHANGES — All four Phase 4 doc deliverables are correct and the scoped grep passes, but the README's custom-harness escape-hatch instruction omits the required explicit `builderHarness`/`architectHarness` key, so a user who follows it still gets rejected.

### Builder Response to Iteration 1
# Phase 4 (1338) — Rebuttals, iteration 1

Reviews: **Gemini APPROVE**, **Codex REQUEST_CHANGES (HIGH)**, **Claude REQUEST_CHANGES (HIGH)**.
Disposition: **every point accepted.** Codex and Claude converged on one real correctness bug — the
README/CHANGELOG documented the custom-`gemini` **escape hatch** in a form that does not work — plus
Codex flagged an `opencode`-as-architect inaccuracy. Both are fixed in README + CHANGELOG (this phase's
scope). Minors addressed; one cross-phase consistency note is accepted and deferred to the Review phase
(see below). No point rejected. Each claim was re-verified against the resolver before revising.

Fix commit: `<fix-commit>` (README.md, CHANGELOG.md — docs only).

---

## Blocking — both accepted, both fixed in README + CHANGELOG

### B1 — The documented escape hatch, followed literally, is rejected (Codex C1 + Claude, HIGH)
**Accepted (real bug).** My phase_4 draft said "define a **custom harness** named `gemini` … (keep
`--yolo` for autonomous mode)" — implying a `harness.gemini` definition plus `shell.builder: "gemini
--yolo"` is enough. It is not. This is exactly the resolver behavior retired in Phase 1 and mirrored by
Phase 3's doctor:
- `resolveHarness` consults custom harnesses **only on the explicit-`harnessName` path** (built-in →
  custom → retired), so an explicit `gemini` backed by a custom def resolves (escape hatch).
- The **auto-detect** path intercepts a detected `gemini` **before** any custom lookup, so a bare
  `gemini …` command is retired **even when a custom `gemini` exists** (asserted at
  `harness.test.ts` — `resolveHarness(undefined, {gemini}, 'gemini --yolo')` throws).

So the escape hatch **requires** the explicit `shell.builderHarness` / `shell.architectHarness:
"gemini"` selector. **Fix:** both README and CHANGELOG now state the explicit selector is required and
explain why (auto-detection resolves the built-in namespace only). The README carries a working config
snippet (`shell.builder` + `shell.builderHarness` + a `harness.gemini` definition using the documented
`roleArgs` / `roleScriptFragment` fields, matching `harness.test.ts`'s escape-hatch fixture).

### B2 — `opencode` is builder-only, not an architect migration target (Codex C2, HIGH)
**Accepted.** The README itself states OpenCode "is only supported as a **builder** shell, not as an
architect shell," and the built-in OpenCode provider rejects architect use. My migration guidance
listed `opencode` generically for both roles. **Fix:** README and CHANGELOG migration guidance is now
role-specific — `claude` or `codex` for either role; `opencode` for **builders only** (OpenCode is not
a supported architect shell). The README's worked example uses `codex` for both roles (valid).

---

## Minor (Claude) — addressed

- **README `:392` single-item parenthetical** ("Other shells (Codex) are also supported") — reworded to
  "Codex is also supported via the harness system." **Fixed.**
- **Autonomous-flags table now lists only Claude Code** (Claude: adding `codex`/`opencode` rows is a
  nice follow-up, "arguably outside this phase's scope"). Left as-is — the config prose immediately below
  documents `codex`/`opencode` selection; adding rows is out of the "retire gemini" scope. Noted for a
  possible docs follow-up.

---

## Cross-phase consistency (Claude, explicitly non-blocking) — accepted, deferred to Review

Claude noted the **same** escape-hatch omission exists in two Phase 1/3 artifacts and was explicit: *"I'm
not asking you to re-open them."* Codex did not raise them. Both are genuine and **accepted**:
- Runtime retirement message — `RETIRED_HARNESSES.gemini` (`harness.ts`): "configure it as a custom
  harness … under the 'harness' section" omits the required explicit selector.
- Doctor recommendation (`doctor.ts`): the "or configure a custom harness" tail omits it too.

**Disposition: apply in the Review phase, not here.** Phase 4's plan scope is explicitly *README +
CHANGELOG*, and the porch phase prompt restricts edits to this phase's files; `harness.ts` / `doctor.ts`
are approved Phase 1/3 code. Aligning all three user touchpoints (README ✓ now, runtime message, doctor
rec) to name the explicit `builderHarness` / `architectHarness` selector is a one-line change each and
will land in the Review phase (reviewed at the PR consult), tracked in the review doc's follow-ups.
Neither reviewer blocks on it, so it does not gate Phase 4.

---

## Governance docs (already planned)
`codev/resources/arch.md` (`:291`, `:309-317`) and `lessons-learned.md` (`:80`) still carry the stale
"gemini is a supported/builder-only harness" framing. Per the spec + plan these are updated in the
**Review** phase via the `update-arch-docs` skill (hot/cold routing) — not a Phase 4 gap. Both reviewers
noted this is correctly deferred.

## Doc-consistency check (re-affirmed)
The corrected README escape-hatch snippet contains `"builder": "gemini --yolo"` + `"builderHarness":
"gemini"`. This is the **reviewer-requested** custom-harness example (retained-access escape hatch,
explicit selector required) — it does **not** present `gemini` as a supported *built-in* shell, which is
what the criterion forbids; the surrounding prose frames it as retired-built-in + custom-harness-only.
The scoped grep (both `codev/` and `codev-skeleton/`) otherwise shows only exempt refs (consult lane /
`agy`, historical artifacts, Review-phase governance docs).

## Gemini (APPROVE)
No changes requested; Gemini confirmed README + CHANGELOG accurately reflect the retirement.

## Verification after fixes
- Docs-only change (README.md, CHANGELOG.md); no source or test touched. Build + full unit suite
  unaffected (green at 4145/0 from the phase_4 iter1 checks); re-confirmed via porch check.


### Iteration 2 Reviews
- gemini: APPROVE — Phase 4 user-facing docs (README and CHANGELOG) accurately reflect the retirement of the Gemini CLI harness and successfully incorporate the explicit custom-harness selector logic requested in the previous iteration.
- codex: REQUEST_CHANGES — Retirement and migration guidance is improved, but the README’s custom Gemini harness example is not executable as documented.
- claude: REQUEST_CHANGES — Both iteration-1 blockers are genuinely fixed and the scoped grep is clean, but the README's custom-harness escape-hatch snippet documents `--system ${ROLE_FILE}` instead of the `GEMINI_SYSTEM_MD` env injection the retired built-in actually used, so a copy-paste user still gets a broken launch.

### Builder Response to Iteration 2
# Phase 4 (1338) — Rebuttals, iteration 2

Reviews: **Gemini APPROVE**, **Codex REQUEST_CHANGES (HIGH)**, **Claude REQUEST_CHANGES (HIGH)**.
Disposition: **every point accepted.** Codex and Claude converged (both HIGH) on one real correctness
bug that iteration 1 introduced while fixing the *selector* problem: the README's custom-`gemini`
escape-hatch snippet injects the role via `--system`, but the Gemini CLI reads its system prompt from
the **`GEMINI_SYSTEM_MD` environment variable** — so a copy-paste user still gets a launch line the CLI
rejects (same user-visible outcome iter1 blocked on, different cause). Fixed in README, and the
same-named `harness.test.ts` escape-hatch assertion is realigned to the corrected shape. No point
rejected. Each claim was re-verified against the retired built-in in git history before revising.

Fix commit: `<fix-commit>` (README.md — docs; harness.test.ts — realign the escape-hatch fixture).

---

## Blocking — accepted, fixed (Codex C1 + Claude, both HIGH — converged)

### B1 — README escape-hatch snippet uses `--system`; Gemini injects via `GEMINI_SYSTEM_MD`
**Accepted (real bug).** `README.md:472` documented:
```json
"gemini": { "roleArgs": ["--system", "${ROLE_FILE}"], "roleScriptFragment": "--system '${ROLE_FILE}'" }
```
`--system` is not a Gemini CLI flag and was never Codev's mechanism for `gemini`. The retired built-in
`GEMINI_HARNESS` — deleted in Phase 1, still at `git show e222b9ef^:packages/codev/src/agent-farm/utils/
harness.ts:177-186` — injected the role via the **`GEMINI_SYSTEM_MD` env var** with empty args and an
empty script fragment:
```ts
buildRoleInjection:       (_c, filePath) => ({ args: [],     env: { GEMINI_SYSTEM_MD: filePath } }),
buildScriptRoleInjection: (_c, filePath) => ({ fragment: '', env: { GEMINI_SYSTEM_MD: filePath } }),
```
A retained-access user copy-pasting the old snippet gets `gemini --yolo --system '<role>' …`; the config
validates and resolves (so Codev accepts it), then the CLI rejects the unknown flag — the escape hatch is
structurally right (explicit selector, from iter1) but functionally still broken.

**Fix (README.md):** the snippet now reproduces the retired provider verbatim —
```json
"gemini": {
  "roleArgs": [],
  "roleEnv": { "GEMINI_SYSTEM_MD": "${ROLE_FILE}" },
  "roleScriptFragment": "",
  "roleScriptEnv": { "GEMINI_SYSTEM_MD": "${ROLE_FILE}" }
}
```
I confirmed this plumbs through end-to-end: `validateCustomHarnessConfig` accepts empty `roleArgs` /
`roleScriptFragment`; `buildCustomHarnessProvider` expands `${ROLE_FILE}` inside `roleEnv` / `roleScriptEnv`
(`harness.ts:311-330`); and `spawn-worktree.ts:923-927` emits `export GEMINI_SYSTEM_MD='<role file>'` into
the launch script — byte-equivalent to what the built-in produced. Added one sentence of prose explaining
*why* the injection is env-based (empty `roleArgs`), so the shape is not mysterious to a reader.

---

## Non-blocking (both reviewers marked optional) — addressed

### N1 — `harness.test.ts:319-328` escape-hatch fixture used the same `--system` shape (Codex + Claude)
**Accepted and fixed** (both called it optional; done because this test is *literally named* the
"retained-access escape hatch" test and encoded the exact bug the README had — an asserted-but-wrong
shape would invite the docs to drift back). Realigned to the `GEMINI_SYSTEM_MD` env injection so the
**asserted** escape hatch is now identical to the **documented** one and to the retired built-in. The test
now asserts both surfaces: `buildRoleInjection` → `{ args: [], env: { GEMINI_SYSTEM_MD } }` and
`buildScriptRoleInjection` → `{ fragment: '', env: { GEMINI_SYSTEM_MD } }`. This does **not** reduce
generic template-expansion coverage — the arbitrary-`--system` `${ROLE_FILE}`/`${ROLE_CONTENT}` expansion
paths remain covered by the dedicated `buildCustomHarnessProvider` describe (`harness.test.ts:122-149`,
`harness-integration.test.ts:150-165`), which are generic mechanism tests, not gemini-specific.

### N2 — escape-hatch example still shows `--yolo` after the flags table dropped that row (Claude)
**Kept, by design.** `--yolo` is the user's *own* retained Gemini CLI invocation (`shell.builder`), not a
Codev-presented autonomous-mode row. A retained-access user who wants autonomous behavior still passes it;
the flags table dropped the row because Codev no longer *presents* gemini as a built-in, which is a
distinct claim. Slightly incongruous, as Claude noted, but correct — removing it would make the worked
example less faithful to a real retained-access setup.

### N3 — cross-phase selector omission in runtime message + doctor rec (Claude — explicitly deferred)
Claude reaffirmed the iter1 deferral: `RETIRED_HARNESSES.gemini` (`harness.ts:233-236`) and doctor's
builder-recommendation tail (`doctor.ts:874`) still say "configure a custom harness" without naming the
explicit `builderHarness` / `architectHarness` selector. **Both reviewers endorsed landing all three
touchpoints together in the Review phase** (out of Phase 4's README/CHANGELOG scope; both are approved
Phase 1/3 code). Unchanged here; tracked for Review.

---

## Governance docs (already planned)
`codev/resources/arch.md` (`:291`, `:309-317`) and `lessons-learned.md` (`:80`) still carry the stale
"gemini is a supported/builder-only harness" framing → updated in the **Review** phase via the
`update-arch-docs` skill (hot/cold routing). Not a Phase 4 gap.

## Doc-consistency check (re-affirmed)
The corrected snippet still contains `"builder": "gemini --yolo"` + `"builderHarness": "gemini"` — the
reviewer-requested retained-access custom-harness example (explicit selector required), framed as
retired-built-in + custom-only. It does **not** present `gemini` as a supported *built-in* shell. Scoped
grep across README/CHANGELOG/`docs/`/`codev-skeleton/` shows the only `--system` gemini instance was
README:472 (now fixed); `docs/releases/*` already reference `GEMINI_SYSTEM_MD` correctly (exempt
historical artifacts).

## Gemini (APPROVE)
No changes requested; Gemini confirmed the README + CHANGELOG accurately reflect the retirement and the
explicit-selector logic.

## Verification after fixes
- `pnpm --filter @cluesmith/codev build` → exit 0 (tsc clean; the realigned fixture type-checks —
  `roleEnv` / `roleScriptEnv` are valid `CustomHarnessConfig` fields).
- `harness.test.ts` → **59/59 passed**, including the realigned escape-hatch assertion.
- Docs change (README) carries no runtime risk; the single source edit is test-only.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
