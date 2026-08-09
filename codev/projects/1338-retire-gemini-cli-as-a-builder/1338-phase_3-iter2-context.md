### Iteration 1 Reviews
- gemini: APPROVE — The implementation of codev doctor's retirement guidance and builder-side flagging aligns perfectly with the phase 3 plan.
- codex: REQUEST_CHANGES — Doctor correctly flags built-in Gemini selections, but incorrectly warns when an explicit custom `gemini` harness—the documented escape hatch—is configured.
- claude: REQUEST_CHANGES — Phase 3 meets every planned deliverable and is green, but doctor false-flags the spec's sanctioned custom-`gemini` escape hatch, and the new negative test passes vacuously due to a missing `chalk.gray` mock.

### Builder Response to Iteration 1
# Phase 3 (1338) — Rebuttals, iteration 1

Reviews: **Gemini APPROVE**, **Codex REQUEST_CHANGES (HIGH)**, **Claude REQUEST_CHANGES (HIGH)**.
Disposition: **every point accepted.** Both reviewers converged on one real correctness bug — doctor
false-flagged the spec's sanctioned custom-`gemini` **escape hatch** — plus Claude found the new
negative test was **vacuous** (missing `chalk.gray` mock). Both are fixed and re-verified against
source; the minor recommendation-wording and array-form nits are addressed too. No point rejected.
Gemini's approval stands. Each claim was re-verified against the actual files before revising.

Fix commit: `<fix-commit>` (production + tests). Files: `packages/codev/src/commands/doctor.ts`,
`packages/codev/src/__tests__/doctor.test.ts`.

---

## Codex (REQUEST_CHANGES, HIGH) — both points accepted

### C1 — Doctor false-flags the custom-`gemini` escape hatch (correctness)
**Accepted (real bug).** Verified: the previous `resolvedShellHarness(role)` returned only a harness
*name* and the caller ran `getRetirement(name)` on it unconditionally — so an explicit
`builderHarness: "gemini"` / `architectHarness: "gemini"` was reported as retired **even when a valid
custom `harness.gemini` definition exists**. That contradicts the resolver precedence
(`resolveHarness`, harness.ts: explicit → built-in → **custom** → retired) and the spec's sanctioned
escape hatch — the retirement message *itself* tells users to "configure a custom harness in
`.codev/config.json`", yet following that advice would leave doctor's warning stuck on.

**Change.** `resolveShell(role)` now returns `{ name, retirement }` and encodes the resolver's own
precedence, so doctor can never drift from spawn behavior:
- **Explicit `shell.<role>Harness`**: suppress retirement iff `config.harness` has an own-property of
  that name (`Object.prototype.hasOwnProperty.call(customHarnesses, explicit)` — prototype-safe, same
  guard style as `isRetiredHarness`). A custom `gemini` def ⇒ not flagged (escape hatch honored).
- **Auto-detected `shell.<role>` command**: retirement **always** applies for a detected retired name
  — auto-detection resolves the built-in namespace only and never consults custom harnesses, exactly
  as `resolveHarness` does (a bare `gemini …` command throws retired even when a custom `gemini`
  exists). So `builder: "gemini --yolo"` stays flagged.

This is the precise built-in-vs-custom, explicit-vs-detected distinction Codex asked for, and it keeps
doctor a faithful mirror of the resolver rather than a second, divergent policy.

### C2 — Add builder + architect tests for explicit custom `gemini`
**Accepted. Added** to `doctor.test.ts` (`shell-harness retirement flagging (#1338)`):
- `does NOT flag an explicit custom gemini BUILDER harness (escape hatch)` — `builderHarness: "gemini"`
  + `harness: { gemini: {...} }` ⇒ no `builder shell (harness retired)`, retirement text absent.
- `does NOT flag an explicit custom gemini ARCHITECT harness (escape hatch)` — the architect twin.
- `STILL flags an auto-detected gemini command even when a custom gemini harness exists` — the crucial
  distinction: `builder: "gemini --yolo"` + `harness: { gemini: {...} }` ⇒ **still** flagged (proves
  doctor matches the resolver's auto-detect-is-always-retired rule, so it can't green-light a config
  that fails closed at spawn). Fixture custom defs are the minimal valid shape (`roleArgs`,
  `roleScriptFragment`) so `loadConfig`'s `validateCustomHarnessConfig` accepts them.

---

## Claude (REQUEST_CHANGES, HIGH) — all points accepted

### 1 — Escape-hatch false positive
Same finding as Codex C1 (Claude independently traced it through `getBuilderHarness` →
`resolveHarness` and the `harness.test.ts` escape-hatch case). Fixed as above.

### 2 — The new negative test was vacuous (missing `chalk.gray` mock)
**Accepted (real test-quality bug).** Verified: the chalk mock defined `bold/green/yellow/red/blue/dim`
but not **`gray`**. The codex-architect "supported" branch calls `chalk.gray` (doctor.ts, two lines
after the `✓ supported` line); with `gray` undefined that throws `TypeError` into the shell-section
`catch {}`, aborting **before** the builder branch runs. So `does NOT flag a supported-harness config
(claude builder + codex architect)` asserted nothing about the path it guards — a future regression
that false-flagged a `claude` builder would have gone uncaught.

**Change.** Added `gray: createChainableColor()` to the mock, and **strengthened the guard beyond
Claude's suggestion.** Asserting the `✓ supported` line alone is insufficient — that line prints
*before* the `chalk.gray` call, so it passes with or without the mock. Instead the test asserts a line
printed **after** both `chalk.gray` calls (`Select the architect harness via .codev/config.json …`):
its presence proves the section ran to completion and the builder branch was actually reached, making
the two "not flagged" assertions non-vacuous. **Empirically confirmed**: with `gray` removed the test
fails at exactly that post-gray assertion (`expected false to be true`); restored, all green.

### 3 — Recommendation misdirects on the explicit-harness path
**Accepted.** For `builderHarness: "gemini"` (test 3's own fixture) the old advice "Set shell.builder
to a supported harness…" is ineffective — an explicit `shell.builderHarness` beats the `shell.builder`
command, so changing only the command wouldn't clear it. Both role recommendations (and the inline
console guidance) now name **both** selectors: "Set `shell.builder` / `shell.builderHarness` …" and
"Set `shell.architect` / `shell.architectHarness` …". The two existing assertions were updated to the
new wording.

### 4 — Nits
- **(a) No array-form test** — **added** `flags an array-form gemini builder command (parity with the
  resolver)`: `builder: ["gemini", "--yolo"]` ⇒ flagged (exercises the array-join branch of
  `resolveShell`, matching the resolver's array handling).
- **(b) Duplicate full retirement paragraph when both roles are gemini** — **acknowledged, no change.**
  Each role's warning is independently actionable and self-contained; deduping the second paragraph
  would couple the two branches for a purely cosmetic gain on a rare misconfiguration. Recorded for the
  Review doc as a deliberate, low-value trade-off.

---

## Gemini (APPROVE)
No changes requested. Gemini confirmed the Phase 3 deliverables (redefined architect branch, new
builder-side flagging, structured issue/recommendation fields) align with the plan. The escape-hatch
correctness gap it did not surface is now closed per Codex/Claude.

---

## Verification after fixes
- `pnpm --filter @cluesmith/codev build` → exit 0 (tsc + vite clean).
- `doctor.test.ts` → **25 passed** (21 prior + 4 new #1338 cases; the 4 existing #1338 cases updated
  for the escape hatch and both-selector recommendation wording).
- Non-vacuity of the supported-config guard proved by controlled removal of the `gray` mock (test fails
  on the post-gray assertion, then passes on restore).
- Full unit suite (excl. e2e) re-run green — the change is isolated to `doctor.ts` (no non-test
  importer) and its test file, so no other suite is affected.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
