# PIR #859 — markdown preview review comments

## Plan phase (2026-05-31)

Investigated the issue. **Core finding: the issue's stated mechanism is infeasible.**

The issue proposes injecting a script via `contributes.markdown.previewScripts` that
`postMessage`s back to the extension host. VS Code's built-in markdown preview does
**not** support preview→host messaging for contributed scripts:

- The built-in preview already calls `acquireVsCodeApi()` once (only one call allowed
  per webview), and does not expose the handle. A contributed script's second call throws.
- The host-side `onDidReceiveMessage` accepts only a fixed allowlist (`didClick`,
  `openLink`, `revealLine`, `cacheImageSizes`, …) with no passthrough — custom message
  types are dropped.
- `command:` URIs are blocked in the built-in preview (no `enableCommandUris`, no API to set it).
- The proposed first-class messaging API was filed and **closed out-of-scope**
  (microsoft/vscode#174080); related #122961 (as-designed), #84886 (out-of-scope).

So the `previewScripts` + `previewStyles` + `markdownItPlugins` approach in the issue body
cannot deliver "click + in the preview → host opens an InputBox".

**Recommended path (in plan):** Option A — a custom Codev webview that renders the eligible
markdown itself (via `markdown-it` + a small `data-line` source-map plugin), so we own the
single `acquireVsCodeApi()` and get real `postMessage` back to the host. Framed as an
optional CustomTextEditor ("Reopen With → Codev Review Preview"). The `writeReviewMarkerAt`
refactor from `plan-review.ts` is still valid and shared between editor + preview paths.

**Caveats flagged for architect at plan gate:** this is the extension's first webview, adds
`markdown-it`, and the affordance lives on a *separate* Codev preview (not the built-in
`Cmd+K V`). Materially larger than the issue advertised ("three contribution points"). Also
offered cheaper alternatives (defer/close; editor-side bridge) for the architect to choose.

Notified architect of the premise break. Plan committed, sitting at plan-approval gate.

## HOLD at plan-approval (2026-05-30, architect instruction)

Architect put #859 on hold at the plan-approval gate. Reframe in progress: the Codev
preview will be extracted as a **reusable cross-surface package** (consumable from vscode +
dashboard + future mobile) rather than a vscode-only webview. A new issue is being filed to
track the package. Once it ships, #859 will be re-planned against that foundation.

My investigation is preserved and will inform the package work: infeasibility finding
(no preview->host messaging on the built-in preview), markdown-it + data-line source-map
choice, CustomTextEditor pattern.

Action: NOT proceeding, NOT touching the plan, NOT re-planning. Sitting at the gate awaiting
the architect's signal to re-plan.

## Rebased on main + requirements check vs artifact-canvas (2026-05-31)

Rebased builder/pir-859 onto origin/main (886 commits; spir-945 / PR #1027 landed
`@cluesmith/codev-artifact-canvas@3.1.9`). Branch rebased LOCALLY only — not force-pushed
(awaiting explicit ok before rewriting the pushed branch history).

Package contract (verified by reading src):
- React lib (peer react ^18||^19). Owns: sanitized markdown render (markdown-it html:false +
  DOMPurify), 0-based `data-line` on block START tokens (token.map[0]), hover/keyboard `+`
  overlay, minimal marker display, adapter-driven data flow.
- `<ArtifactCanvas uri fileAdapter markerAdapter themeAdapter onAddComment onError? refreshKey?>`.
  Emits `onAddComment(line)` INTENT only — never calls MarkerAdapter.add itself (spec D6).
- 3 host adapters (impl in host): FileAdapter{read,watch}, MarkerAdapter{list,add},
  ThemeAdapter{resolve,onChange} (D4 Model A — off v1 render path; CSS-var theming).
- Not npm-published; consumed `workspace:*`, bundled by each host.

What #859 (vscode host) must build — reshaped from the original plan:
1. React in a vscode webview (extension has ZERO webviews today). Second esbuild bundle
   (browser/JSX, react+react-dom+package bundled, package CSS) → mount <ArtifactCanvas>.
2. CustomTextEditor ("Codev Review Preview") binds the doc; "Reopen With" + title button; path-gated
   to codev/(plans|specs|reviews)/*.md.
3. Webview<->host bridge: adapters run in webview but TextDocument/WorkspaceEdit/InputBox run in the
   extension host. Pattern: host reads doc + parses markers, pushes content+markers to webview;
   webview FileAdapter.read returns injected content, watch driven by host postMessage (or refreshKey);
   onAddComment(line) -> postMessage host -> showInputBox -> MarkerAdapter.add (host) -> doc change ->
   host re-reads + re-pushes. This message protocol IS the core of #859.
4. Reuse the still-valid `writeReviewMarkerAt` extraction from plan-review.ts for the host add();
   author = overviewCache.currentUser ?? 'architect'. CSP/nonce. Theme: bind .codev-artifact-canvas
   --codev-canvas-* to --vscode-*.

KEY DECISION to resolve in re-plan: line round-trip. Package emits 0-based block START line
(data-line = token.map[0]) and renders a marker on the block whose data-line === marker.line. The
editor convention writes the marker on the line AFTER the anchor; REVIEW HTML comments are invisible
under html:false (no data-line). So host MarkerAdapter.add/list must agree on a serialization where
list() recovers a line equal to the target block's START data-line, else markers mis-anchor on
multi-line blocks. One on-disk convention must serve BOTH the editor Comments-API path and the canvas
list()/add() path.

BONUS scope note: the package already does minimal marker display, so existing REVIEW markers will
surface in the canvas for free — the issue's "v1 authoring only, no thread rendering" non-goal is
partially delivered by the package.

Next: awaiting architect go-ahead to rewrite the plan file (re-plan) against this foundation.

## Re-plan against artifact-canvas (2026-06-13)

Rewrote codev/plans/859-...md. Scope locked by architect: VSCode-only; marker codec in
@cluesmith/codev-core (both vscode + dashboard depend on core → web host inherits it);
existing on-disk marker convention PRESERVED.

Design: vscode host = CustomTextEditor "Codev Review Preview" mounting React <ArtifactCanvas>
in our own webview (2nd esbuild browser bundle), adapters bridged webview<->extension host.
New core module `@cluesmith/codev-core/review-markers` = single home for serialize/parse/
stripMarkersForRender(blank-replace, the #1036 vscode fix)/insertMarker + a markdown-it
block-start resolver. plan-review.ts editor path refactored to share the codec, no behavior
change.

Convention: chose B (keep "marker on line after anchor") over A (flip) BECAUSE A would
re-anchor existing markers one block off + force editor-path changes. B keeps existing
annotations untouched AND correctly anchored. Cost: core block-start resolver must stay in
parity with the canvas data-line rule -> parity contract test.

Existing annotations: NOT removed/rewritten. Blank-replace is in-memory read-path only;
add() only inserts; disk file unchanged. Confirmed to architect.

Open for plan-approval gate: parity-test approach for core/canvas block-map duplication; and
whether this PR closes the vscode side of #1036.

Branch still rebased LOCALLY (not force-pushed). Plan file rewritten but NOT yet committed —
awaiting architect ok to commit + force-push.

## Rebase #2 + plan re-verify (2026-06-13, +121 commits)

Rebased onto origin/main again (121 new commits). Re-verified the implementation plan; core
design (CustomTextEditor + React webview + core codec + Convention B) holds. Deltas folded in:
- #920 added the extension's FIRST webview (Search Backlog editor-tab). My "first webview" claim
  was stale -> now "first React/BUNDLED webview"; follow #920's CSP/nonce/template precedent
  (webviews/backlog-search-panel.ts, backlog-search.template.ts, getNonce). #920 inlines a plain
  script; React canvas still needs a real esbuild bundle (esbuild still single-entry src/extension.ts).
- #956 lint rule bans bare vscode.commands.registerCommand -> register open cmd via reg(...) in
  extension.ts; registerCustomEditorProvider is window.* (not banned); leave plan-review.ts's two
  eslint-disabled command regs alone.
- plan-review.ts unchanged where I refactor (marker fmt line 159, ELIGIBLE_PATH_REGEX line 34,
  insert Position(line+1) line 162). artifact-canvas still 3.1.9 (contract unchanged).
- #1036 + #1029 still OPEN -> codec-in-core + blank-replace + coordination notes all still stand.

Plan edited (not yet committed). Branch rebased locally; push will need --force-with-lease.
Awaiting architect ok to commit + force-push.

## Implement phase complete (2026-06-13)

Built the vscode host on artifact-canvas. Three commits: core codec / editor refactor / vscode host.

DELIVERED:
- packages/core/src/review-markers.ts (+ test): shared codec — serializeReviewMarker,
  parseReviewMarkers, stripMarkersForRender (blank-replace = #1036 vscode fix), markerInsertionLine,
  ELIGIBLE_PATH_REGEX/isEligibleReviewPath. Pure, NO new deps.
- plan-review.ts: editor path now uses the codec for format + gating (no behavior change; still
  inserts at line+1).
- review-preview.ts: CustomTextEditorProvider 'codev.reviewPreview' (CSP/nonce/asWebviewUri per #920),
  host<->webview bridge (push update / addComment -> showInputBox -> WorkspaceEdit).
- webview/main.ts: React entry mounting <ArtifactCanvas>, refreshKey-driven (host = source of truth).
- esbuild.js: 2nd browser/IIFE bundle (react+react-dom+canvas, css emitted) -> dist/webview/.
- extension.ts: registerCustomEditorProvider + reg('codev.openReviewCanvas') (opens Beside via openWith).
- package.json: customEditors (priority:option, **/*.md), command + editor/title + commandPalette
  (gated to codev/(plans|specs|reviews)), deps react/react-dom/artifact-canvas. tsconfig excludes the
  webview dir from host typecheck (#920-style; esbuild builds it).

DEVIATION FROM APPROVED PLAN (important): plan specified a markdown-it block-start resolver in core
+ a parity test (Convention B "resolve marker -> block start"). DROPPED as unnecessary. The
artifact-canvas package's OWN tested convention (its stub adapters) and the EXISTING editor convention
are identical and trivial: marker on the line after the anchor; marker.line = fileLine - 1. So no
tokenizer is needed. This means core has NO markdown-it dep, no parity test, no two-instance drift.
Tradeoff (same as the package's own v1 contract): a marker authored mid-multi-line-block maps to that
line; on render a blank-replaced marker between two paragraph lines visually splits the paragraph.
Accepted v1 limitation; richer anchoring is #863/#1036. Existing annotations are untouched (in-memory
strip only) and anchor correctly when authored on a block-start line (the common case).

CHECKS: core tests 31 pass (incl. new review-markers). vscode: check-types ✓ lint ✓ esbuild(2 bundles) ✓
unit tests 395 pass. Fixed a self-inflicted duplicate command-title (caught by contributes-commands test).

Pushing; porch done -> dev-approval gate.

## dev-approval gate feedback round (2026-06-14)

Architect reviewed the running worktree. Changes made (gate still pending):
- RENAME: "Codev Review Preview"/"Open Review Canvas" -> "Codev Markdown Preview" /
  "Open Markdown Preview" (user-facing + internal: viewType codev.markdownPreview, command
  codev.openMarkdownPreview, class MarkdownPreviewProvider, file preview-provider.ts, bundle
  markdown-preview.{js,css}). "Review" collided with the reviews/ artifact type; also unified the
  Preview-vs-Canvas inconsistency.
- ICON: title-bar button now uses icons/codev.svg (Codev brand) instead of $(comment-discussion),
  matching the activity-bar + existing view/title menu pattern.
- INPUT decision: keep vscode showInputBox for v1. It's VSCode-only, but the package contract is
  "host provides input" (onAddComment intent-only, D6), so the dashboard supplies its own input -
  showInputBox doesn't constrain it. For CONSISTENT cross-surface input the box must live in the
  PACKAGE (a host-level inline box wouldn't be shared with the dashboard). Noted that direction on
  #863 (comment 4699870100); #859 ships with showInputBox.
- Sidebar question: View Plan/Spec/Review currently open the plain TEXT editor (showTextDocument,
  preview:false); the custom editor is priority:option so the sidebar does NOT route through it.
  Offered to wire sidebar View commands -> markdown preview; awaiting architect decision (not done).

Created untracked scratch fixture codev/plans/_markdown-preview-demo.md for manual testing of the
working case + the multi-line-paragraph split limitation (delete when done).

Build/tests still green (core 31, vscode 395, compile). Still at dev-approval.
