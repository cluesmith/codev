# Review: VSCode Contextual Bottom Panel (mode resolver + Attention fallback)

> **Post-dev-approval simplification (final state).** After building the four phases, the owner's live dev-approval reshaped the panel to be **purely contextual**: pills, summary ⇄ detail navigation, drill-in, and transient selection were **removed** (cross-builder browsing is the sidebar's job); the resolver became `(SurfaceContext) → { kind, context }`; Attention is now a **fallback view**, not a selectable mode. Separately, the `#921` **Codev Dev panel view was removed** (it created a redundant second "Codev" section — the status-bar chip stays, display-only). This is a net simplification; the compliance/consultation sections below cover the four-phase build, and this banner + issue #1049 describe the shipped end state.

## Summary

Built a single contextual `Codev` bottom-panel tab (the extension's first `WebviewViewProvider`) that follows the active editor/terminal — Document Review, Code Review, Builder Inspector, or the Attention fallback — with a pure mode resolver and a webview surface, **purely contextual with no selectable navigation** (see banner). Per-mode content rendering stays with the participating features (#1037, #859/#945, files-not-yet-reviewed). Built over four phases, then simplified at dev-approval.

## Spec Compliance

Reflects the **shipped, purely-contextual** design (issue #1049 v3). The frozen spec's pill / summary-detail / navigation criteria were **superseded by owner direction at dev-approval** (see Deviations) and are marked as such here rather than checked off.

- [x] One contextual `Codev` panel tab — the **sole** view in `codevPanel` (scaffold placeholder repurposed); the `#921` Codev Dev **panel view is removed** (status-bar chip retained, retargeted to reveal the dev terminal)
- [x] Purely contextual — no pinning/locking/persisted state; introduces no `workspaceState`/`globalState`/configuration key (asserted by `contextual-panel-no-persistence.test.ts`)
- [x] `ModeResolver` is a pure, synchronous, VSCode-free function `(SurfaceContext) → { kind, context }`; enforced by a source-scan purity test
- [x] Predicate precedence explicit, total, fixed (`builder-terminal → builder-diff → artifact → attention`); overlap tested
- [x] Context derived from the active *tab* (not `activeTextEditor` alone) — custom editor (`codev.markdownPreview`) → Document Review, multi-file diff → Code Review; trigger set = tab-group + active-editor + selection + terminal-focus + diff-registry; terminal exit **and** re-entry handled
- [x] The shown builder is derived from the active surface (`getActiveBuilderId()` / diff-inject registry `builderId`), never chosen, never persisted
- [x] Attention is the **fallback view** when no artifact/diff/terminal is active — not a selectable mode
- [x] Header is a one-line context label; **no pills / no switcher / no manual navigation / no cross-builder lists** (the sidebar owns cross-builder browsing)
- [x] O(1) resolution, no I/O on the switch path (automated); ~50 ms perceived latency is a dev-approval feel check
- [x] Per-mode render target + placeholder body; no mode content (owned by participating issues)
- [x] Webview hardened: nonce CSP, `localResourceRoots`; header text React-escaped (no-innerHTML source-scan)
- [x] Unit tests cover resolver branches, precedence overlap, malformed-input degradation, provider event wiring (incl. terminal exit/re-entry, multi-diff, background-churn), no-persistence
- [x] Dev-approval walkthrough — **done**; it drove the purely-contextual simplification (see Deviations)
- ~~Mode pills / per-mode navigability / transient pill navigation / summary ⇄ detail / drill-in / six summary+detail render targets~~ — **SUPERSEDED** by owner direction at dev-approval (removed; the panel is purely contextual)

## Deviations from Plan

- **Purely-contextual simplification — a frozen-spec deviation by owner direction at dev-approval (documented, not silently shipped).** The approved (frozen) spec specified mode **pills**, **transient navigation**, **summary ⇄ detail**, and **drill-in**. At the live dev review the owner directed that the panel be purely contextual with nothing selectable: those layers were **removed** (cross-builder browsing is the sidebar's job) and Attention became a fallback view, not a selectable mode. This is recorded here and in the spec/plan/review banners + issue #1049 (the current requirements) so the divergence from the frozen spec is explicit. It supersedes the Phase-4 pill/navigation/A2-zoom-out work below (kept as build history).
- **Codev Dev panel view removed (#921), by owner direction.** It created a redundant second "Codev" section beside the contextual view; the always-visible status-bar chip stays (retargeted to reveal the running dev PTY's terminal tab).
- **Phase 2 — visibility cache relocated to Phase 3.** The descriptor cache + `onDidChangeVisibility` re-post was inseparable from descriptor *posting* (Phase 3); implementing it in Phase 2 would have been dead, untested scaffolding. Formally relocated in the plan (not dropped) with its own Phase 3 deliverable + test.
- **DI-when-needed.** The provider took `extensionUri` in Phase 2, `TerminalManager` in Phase 3, and the two stores in Phase 4 — each injected in the phase whose code uses it (injecting unused deps trips `noUnusedLocals`). Recorded in the plan.
- **A2 navigation-scoping / active-pill zoom-out (Phase 4) — SUPERSEDED and WITHDRAWN.** During Phase 4, cmap and the architect drove an active-pill zoom-out and moving A2 navigation-scoping to the provider. The purely-contextual simplification then removed the entire navigation/summary layer, so these are moot — the architect explicitly withdrew the zoom-out / A2-navigation requirements. Recorded as history; not carried as unmet.
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
- Non-blocking, now **MOOT**: a Phase-4 zoom-out-on-stationary-surface concern — removed with the whole navigation layer at dev-approval.

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

## Known Limitations (focus tracking)

VS Code exposes no "which surface has focus" read and does not fire an event for every focus move, so the last-focused-surface proxy has bounded residuals. All self-heal on the next editor/terminal interaction; none can mis-render *builder* content as another builder's, and none block the skeleton.

- **Terminal moved into the editor area** (`TabInputTerminal`): activating such a tab now classifies as **terminal** focus (not editor), so a focused builder terminal is no longer demoted to Attention by the tab event. (PR-cmap iter3, Codex — fixed + regression test.)
- **Re-entering an already-active custom editor from a builder terminal** (Codex, iter3): when neither the active tab nor the active *text* editor changes (e.g. terminal → an already-open `codev.markdownPreview`), VS Code fires no event, so the panel can stay on Builder Inspector until the next editor interaction. This is the same inherent event-gap as the terminal re-entry case and is an **accepted residual** (Gemini + Claude APPROVE; Claude reviewed this path and judged it acceptable). Closing it fully would require focus polling, which the design deliberately avoids.
- **Closing the last editor while a builder terminal is the active terminal** flips to Builder Inspector without actual terminal focus (documented in `terminalFocusLikely`); self-heals on the next editor interaction.

## Flaky Tests

No flaky tests encountered. (An initial worktree run showed 18 test files failing to *load* because the workspace deps `codev-types` / `codev-sdk` / `artifact-canvas` had no built `dist/`; building them resolved it — an environment setup step, not a flaky test.)

## Follow-up Items

- Participating features render the real mode content into the exposed targets: #1037 (Code Review queue), #859/#945 (Document Review markers), files-not-yet-reviewed (Code Review checklist), #807 (Reader View candidate).
- #1549 extracts the local webview primitives (pill/header/list/row) into a generalized artifact-canvas — from this proven code, not speculation.
- Placeholder-retirement cleanup shipped in Phase 2 (the `#813/#814/#815` rescope is tracked on those issues).
