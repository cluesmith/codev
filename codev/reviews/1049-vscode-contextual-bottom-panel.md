# Review: VSCode Contextual Bottom Panel (mode resolver + Attention fallback)

> **Post-dev-approval simplification (final state).** After building the four phases, the owner's live dev-approval reshaped the panel to be **purely contextual**: pills, summary ⇄ detail navigation, drill-in, and transient selection were **removed** (cross-builder browsing is the sidebar's job); the resolver became `(SurfaceContext) → { kind, context }`; Attention is now a **fallback view**, not a selectable mode. Separately, the `#921` **Codev Dev panel view was removed** (it created a redundant second "Codev" section — the status-bar chip stays, display-only). This is a net simplification; the compliance/consultation sections below cover the four-phase build, and this banner + issue #1049 describe the shipped end state.

## Summary

Built a single contextual `Codev` bottom-panel tab (the extension's first `WebviewViewProvider`) that follows the active editor/terminal — Document Review, Code Review, Builder Inspector, or the Attention fallback — with a pure mode resolver and a webview surface, **purely contextual with no selectable navigation** (see banner). Per-mode content rendering stays with the participating features (#1037, #859/#945, files-not-yet-reviewed). Built over four phases, then simplified at dev-approval.

## Spec Compliance

- [x] One contextual `Codev` panel tab; the scaffold placeholder repurposed; `Codev Dev` untouched (Phase 2)
- [x] Purely contextual — no pinning/freezing/locking/persisted panel state; introduces no `workspaceState`/`globalState`/configuration key (Phase 2/4; asserted by `contextual-panel-no-persistence.test.ts`)
- [x] `ModeResolver` is a pure, synchronous, VSCode-free function returning `ModeDescriptor` + applicability; enforced by a source-scan purity test (Phase 1)
- [x] Predicate precedence explicit, total, fixed (`builder-terminal → builder-diff → artifact → attention`); overlap tested (Phase 1)
- [x] Context derived from the active *tab* (not `activeTextEditor` alone) — custom editor (`codev.markdownPreview`) → Document Review, multi-file diff → Code Review; trigger set = tab-group + terminal + active-editor + selection + diff-registry (Phase 3)
- [x] Builder attachment derived from the active surface (`getActiveBuilderId()` / diff-inject registry `builderId`), never persisted (Phase 3/4)
- [x] Header renders four mode pills; active distinct; inapplicable greyed; Document Review disabled without an artifact via `aria-disabled` (Phase 2/3/4)
- [x] Per-mode navigability defined; every applicable pill (incl. active) navigates; disabled is inert (Phase 4)
- [x] Mode pills are transient navigation, discarded on any real active-surface change; never persisted (Phase 4)
- [x] Attention fallback when nothing matches and no selection (Phase 1/3)
- [x] O(1) resolution, no I/O on the switch path (automated); ~50 ms perceived latency is a dev-approval feel check (Phase 1/3)
- [x] Render targets per mode/level (six: Doc Review detail; Code Review + Builder Inspector summary+detail; Attention summary); placeholder bodies + orchestration only, no mode content (Phase 2/3/4)
- [x] Minimum navigation UI: builder-id summary stub + drill-in (Phase 4)
- [x] Webview hardened: nonce CSP, `localResourceRoots`, validated message contract, header text React-escaped (source-scan) (Phase 2/3/4)
- [x] Unit tests cover resolver branches, precedence overlap, applicability, transient nav, malformed-input degradation, provider event wiring, message contract, no-persistence (all phases)
- [ ] Dev-approval walkthrough — **pending** (the contextual "feel" is verified live at the dev-approval gate, not from the PR diff; noted below)

## Deviations from Plan

- **Phase 2 — visibility cache relocated to Phase 3.** The descriptor cache + `onDidChangeVisibility` re-post was inseparable from descriptor *posting* (Phase 3); implementing it in Phase 2 would have been dead, untested scaffolding. Formally relocated in the plan (not dropped) with its own Phase 3 deliverable + test.
- **DI-when-needed.** The provider took `extensionUri` in Phase 2, `TerminalManager` in Phase 3, and the two stores in Phase 4 — each injected in the phase whose code uses it (injecting unused deps trips `noUnusedLocals`). Recorded in the plan.
- **A2 navigation-scoping moved from the pure resolver to the provider (Phase 4, architect-accepted).** cmap surfaced that the resolver's artifact fallback made the cross-builder summary unreachable in-mode (colliding with the frozen always-navigable criterion). Moved the policy to `selectionForNavigate` and added the active-pill zoom-out; the pure resolver is now just `builderId → detail, else summary`. Contextual A2 (a worktree artifact's Document Review carrying its builderId) is unchanged.
- **Changelog not on this branch.** Per the repo convention (self-documented in `docs/releases/UNRELEASED.md`), the `apps/vscode/CHANGELOG.md` + `UNRELEASED.md` entries land on the `docs/vscode-changelog` branch as the architect's post-merge workflow; the entry text is prepared in `codev/state/spir-1049_thread.md`.

## Consultation Feedback

Spec: 2 rounds (Gemini APPROVE both; Codex/Claude REQUEST_CHANGES → COMMENT). Plan: 1 round. Each implement phase: 1–3 rounds. Every phase ended with all-three APPROVE. Key concerns and dispositions:

### Specify (Rounds 1–2)
- **Precedence gap; editor-centric context fails on custom-editor/multi-diff; override lifetime undefined; webview security absent** (Codex, Claude) → **Addressed**: explicit precedence, tab-based context, no-pin transient model (architect-driven), webview hardening criteria.
- **Terminal-exit has no backing event; `activeTerminal` stays set** (Codex, Claude; architect verified against `vscode.d.ts`) → **Addressed**: reframed as a plan-gate API-feasibility question (the `onDidChangeTextEditorSelection` proxy).

### Plan (Round 1)
- **Types must be extension-local, not `codev-types`** (architect A1) → **Addressed** (stated explicit). **Worktree-artifact builderId** (A2), **#1497 terminal identity** (A3), **webview value-validation** (A4) → **Addressed**.
- **`SurfaceContext` must expose independent predicates; diff derivation can't read a write-only context key; tests must live in `src/__tests__/`; manifest needs `"type":"webview"`; both tsconfigs; visibility lifecycle; 6-vs-7 render targets** (Codex, Claude) → **Addressed** each.

### Phase 1 — Mode resolver (Rounds 1–2)
- **Code uncommitted; A2 scoping a no-op; no purity assertion** (Codex, Claude) → **Addressed**: committed before signaling (a lasting process fix), realized A2, added a source-scan purity guard. Iter-2 hardening (exhaustive `MODE_KINDS`, stronger purity scan) → **Addressed**.

### Phase 2 — Panel surface (Rounds 1–2)
- **Visibility cache + DI deferred** (Codex) → **Addressed** by formal relocation to Phase 3 (not dropped). **No template CSP test** (Claude) → **Addressed**. **Inverted lifecycle comment; disabled-button tooltip** (Codex, Claude) → **Addressed** in Phase 3.

### Phase 3 — Context adapter (Rounds 1–3)
- **Surface identity was descriptor-based (two files collapse); diff never emitted artifact; focus noted on background tab churn** (Codex, Claude) → **Addressed**: `surfaceKey` + transition id, diff+artifact overlap, activation-gated focus.
- **Missing diff/registry tests; selection handler ignored `event.textEditor`; multi-diff sub-file nav had no trigger** (Claude, Codex) → **Addressed**: added tests, gated the selection handler, subscribed `onDidChangeActiveTextEditor`. **Tab kind/viewType in the key** (Codex) → **Addressed**. **`pillsFromDescriptor` untested** (Claude) → **Addressed** (extracted `pills.ts`).

### Phase 4 — Transient navigation (Rounds 1–3)
- **Active pill not clickable (no path back to summary)** (Codex, Claude) → **Addressed**: `pillIsInteractive`. **A2 fallback made the summary unreachable** (Codex; Claude called it intended) → **Addressed** by moving A2 to the provider + zoom-out (architect-accepted). **Complete gesture family (active-summary/Document-Review no-op; zoom-out transient)** (architect) → **Addressed** with dedicated tests.
- Non-blocking (deferred to dev-approval): a zoom-out to summary on a stationary diff/terminal surface has no in-mode path back to the contextual detail — evaluate the feel.

No `CONSULT_ERROR` encountered.

## Lessons Learned

### What Went Well
- The pure-core / host-adapter split (`resolver.ts`, `surface-context.ts` vs `surface-reader.ts`, `panel-provider.ts`) made the load-bearing logic exhaustively unit-testable with no VSCode host, and source-scan purity guards keep it that way.
- Committing each phase *before* signaling (learned in Phase 1) gave every downstream cmap a real diff to review.
- Verifying reviewer claims against source before acting repeatedly paid off (the terminal-exit event gap, the multi-diff untyped tab input, `DiffInjectSessionEntry.fsPath` being the right side).

### Challenges Encountered
- VSCode's tab/focus model is fiddly: the multi-file diff (`vscode.changes`) has no typed tab input even in 1.105; `activeTerminal` stays set after focus leaves; `onDidChangeTabs` fires on background churn. Each needed a specific, tested signal rather than an obvious API.
- Distinguishing "re-render dedup" from "surface transition (for clearing/selection)" took two iterations to model cleanly (`surfaceKey` + descriptor).

### What Would Be Done Differently
- Model the surface *identity* (raw key) vs the resolved descriptor from the start — several Phase 3 rounds converged on that split.

### Methodology Improvements
- None specific; the strict porch loop + per-phase cmap caught real defects each round.

## Architecture Updates

- Routed: **cold** — `codev/resources/arch.md` (VS Code Extension) — the contextual bottom panel is the extension's first `WebviewViewProvider`; it splits a pure `ModeResolver`/`SurfaceContext` core from a `vscode`-touching reader/provider, and (with `retainContextWhenHidden`) re-posts the cached descriptor on `onDidChangeVisibility` because `resolveWebviewView` does not re-fire. Subsystem-level detail → cold, not hot.
- No **hot** (`arch-critical.md`) change: this feature introduces no new always-must-know invariant, and the hot file is at its cap.

## Lessons Learned Updates

- Routed: **cold** — `codev/resources/lessons-learned.md` (UI/UX + Testing) — (1) VSCode's multi-file diff (`vscode.changes`) has no typed tab input; classify it via `activeTextEditor` gated by the active tab's type so a normal-tab file isn't misread as a diff. (2) `window.activeTerminal` stays set after focus leaves a terminal, so a terminal-exit needs a last-focused-surface proxy (`onDidChangeTextEditorSelection`/`onDidChangeActiveTextEditor`), not `activeTerminal`. (3) Split webview logic into a pure core + a `vscode` host adapter so the core unit-tests without a host.
- No **hot** (`lessons-critical.md`) change: these are VSCode-extension-specific, not cross-cutting must-knows; the hot file is at its cap.

## Flaky Tests

No flaky tests encountered. (An initial worktree run showed 18 test files failing to *load* because the workspace deps `codev-types` / `codev-sdk` / `artifact-canvas` had no built `dist/`; building them resolved it — an environment setup step, not a flaky test.)

## Follow-up Items

- Dev-approval feel check: whether a zoom-out to summary on a stationary diff/terminal wants an explicit "back to context" affordance (Claude non-blocking).
- Participating features render the real mode content into the exposed targets: #1037 (Code Review queue), #859/#945 (Document Review markers), files-not-yet-reviewed (Code Review checklist), #807 (Reader View candidate).
- #1549 extracts the local webview primitives (pill/header/list/row) into a generalized artifact-canvas — from this proven code, not speculation.
- Placeholder-retirement cleanup shipped in Phase 2 (the `#813/#814/#815` rescope is tracked on those issues).
