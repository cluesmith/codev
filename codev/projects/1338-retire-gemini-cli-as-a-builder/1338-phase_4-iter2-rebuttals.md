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
