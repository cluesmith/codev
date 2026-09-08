### Iteration 1 Reviews
- gemini: APPROVE — Phase 3 correctly implements O(1) tab-based surface derivation, last-focus tracking for terminal exit, and visibility-cached mode switching with solid test coverage.
- codex: REQUEST_CHANGES — Phase 3’s adapter works broadly, but surface identity and focus tracking do not meet the contextual-transition contract.
- claude: REQUEST_CHANGES — Solid, well-reasoned Phase 3 (pure derivation, correct `modified`-side diff keying, working terminal-exit demotion, all checks green) but the plan-mandated diff/registry-trigger test is absent despite its mock being staged, and `onDidChangeTabs` claims editor focus on non-activation events.

### Builder Response to Iteration 1
# Rebuttal — Phase 3 (Context adapter + contextual switching), iteration 1

Verdicts: **Gemini APPROVE**, **Codex REQUEST_CHANGES**, **Claude REQUEST_CHANGES**. The two REQUEST_CHANGES found real bugs (some forward-looking into Phase 4); all adopted.

## Codex

1. **`surfaceIdentity` derived from the descriptor, not the surface** — two different ordinary files both resolve to identical Attention, so a file→file switch is invisible and Phase 4 could not clear transient nav. **Fixed:** added a pure `surfaceKey(inputs)` that identifies the *raw* active surface (focused terminal builder / active-tab resource / multi-diff file), stable across cursor moves. The provider now re-posts on a **transition id = `surfaceKey | descriptor`** — the surface key catches file-A→file-B (same Attention), the descriptor part catches the diff-registry populating on the same tab. Tests for both.

2. **Diff tabs never emitted an `artifact` predicate** — reviewing a spec *in a diff* wrongly disabled Document Review, and the independent-predicate overlap was unreachable from the adapter. **Fixed:** `deriveArtifact` now also matches the diff's `modified` side (and the multi-diff's focused sub-file). A spec-in-a-diff now yields **both** `builderDiff` and `artifact` — the resolver picks Code Review (precedence) while Document Review stays navigable. Tested (artifact-diff → both; non-artifact diff → only builderDiff).

3. **`noteEditorFocused()` on every `onDidChangeTabs`** demoted a focused builder terminal on background churn (dirty/pin/label). **Fixed:** the tab handler now notes editor focus only on a genuine **active-tab activation** (compares the active-tab resource to the last seen; seeded on `resolveWebviewView` so the first churn event is not mistaken for an activation). Selection events still handle the click-into-already-active-editor exit. Tested: background churn keeps Builder Inspector; a real tab switch demotes.

## Claude

1. **Missing the diff/registry-trigger tests** (the mock captured `listeners['registry']` / `diffBuilders` but never fired them). **Fixed:** added provider tests that (a) resolve a builder diff from the `modified` side via the registry, and (b) start with an empty registry (→ Attention) then fire `onDidChangeDiffInjectRegistry` after populating it (→ Code Review). The real `getDiffInjectEntry` wiring and the registry trigger are now exercised.

2. **`onDidChangeTabs` claims editor focus on non-activation events** — same as Codex #3; fixed as above.

3. **No header-escaping assertion** — React makes it safe, but untested. **Fixed:** added a source-scan test asserting the webview (`main.ts`, `components.ts`) uses no `innerHTML` / `dangerouslySetInnerHTML` / `insertAdjacentHTML`, enforcing that descriptor text stays React-escaped data.

4. **Per-view disposables accumulate across re-resolves** — **Fixed:** per-view listeners now live in a separate array disposed at the start of each `resolveWebviewView` (and on `dispose()`), so a re-resolve does not leak.

## Result

71 files / 870 tests pass; `check-types` (both tsconfigs), `eslint`, and the esbuild bundles are clean. Gemini's APPROVE stands; the two REQUEST_CHANGES sets are fully resolved, with tests for each fix.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
