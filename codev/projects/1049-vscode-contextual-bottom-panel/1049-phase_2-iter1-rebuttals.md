# Rebuttal — Phase 2 (Panel surface + placeholder retirement), iteration 1

Verdicts: **Gemini APPROVE**, **Claude APPROVE**, **Codex REQUEST_CHANGES**. The substance from Codex and Claude converges on one point (the visibility-cache deliverable) plus DI and a missing template test. Addressed below.

## Visibility cache + re-post (Codex, Claude) — relocated to Phase 3, not dropped

Both flagged that the plan assigned the descriptor cache + `onDidChangeVisibility` re-post to Phase 2, and I deferred it. Claude called it "vacuous now"; Codex called it required. Both are right that a *silent* deferral is wrong.

The mechanism is inseparable from descriptor *posting*, which Phase 3 introduces: in Phase 2 the shell is entirely client-side (no host→webview message), so there is **no descriptor to cache** — implementing it now would be dead, untested scaffolding (a `lastDescriptor` field that is never set or read, which also trips `noUnusedLocals`, exactly why I dropped the unused `view` field). So instead of a silent deferral I have **formally relocated it in the plan**: removed from Phase 2's deliverables, added to Phase 3 as an explicit deliverable + acceptance criterion + test (mocked `WebviewView` + `onDidChangeVisibility`), and recorded *why* in Phase 2's file list. It ships in Phase 3, tested, not dropped. Also captured the real coupling Claude flagged: with `retainContextWhenHidden: true` the view is **not** re-resolved on re-show, so `onDidChangeVisibility` (not a resolve re-fire) is the correct re-post trigger.

## DI omitted (Codex) — DI-when-needed, documented

The provider injects only `extensionUri` in Phase 2 because that is all its code uses; `OverviewCache` / `ReviewQueueStore` / `TerminalManager` are used in Phases 3–4. Injecting them now, unused, would be dead constructor params tripping `noUnusedLocals`. Updated the plan to state DI-when-needed explicitly: `TerminalManager` is added in Phase 3, the two stores in Phase 4, each in the phase whose code consumes it.

## No test for `panel-template.ts` (Claude) — added

Added `contextual-panel-template.test.ts` (5 cases): the nonce is bound into both the CSP and the `<script>` tag, `default-src 'none'` with no inline/wildcard scripts, styles/images/fonts scoped to `cspSource`, exact script/style URIs, single `#root`, and a distinct nonce per render. This is the security-relevant surface Phase 3 will extend with header-text escaping.

## Manual EDH render check (Claude) — deferred to dev-approval (honest limitation)

The plan's Phase-2 manual test (open the Extension Development Host, confirm the `Codev` tab renders) cannot be evidenced from this headless builder environment. The automated surface is covered (manifest invariants assert `codev.contextualPanel` with `type: webview`; the bundle builds and emits; the template test pins the HTML). The actual on-screen render — the "does the first webview view paint" check — is exactly what the spec routes to **dev-approval**; I am flagging it as still-to-verify there rather than claiming it green.

## Result

`vitest run`: full suite green including the new template suite; `check-types` clean (both tsconfigs); `eslint` clean. Two APPROVEs stand; Codex's REQUEST_CHANGES points (visibility cache, DI) are resolved by formal relocation + documentation rather than dead scaffolding.
