# Builder thread: spir-1049 — vscode contextual bottom panel

## Project
Issue #1049 — vscode: contextual bottom panel that adapts to active editor (mode resolver + Attention fallback).
Protocol: SPIR (strict mode). Umbrella feature: panel skeleton + ModeResolver + mode switching only.
Actual per-mode rendering is out of scope (owned by participating-feature issues #1037, Files-not-yet-reviewed, #807, etc.).

## Log

### 2026-08-12 — Specify phase start
- porch status: PHASE=specify, no spec/plan/thread yet. Started fresh.
- No literal "Baked Decisions" heading in issue, BUT the architect has baked strong direction:
  Architecture (ModeResolver + PanelRenderer split), Mode mapping v1 (4 modes), and 5 plan-gate
  "leans". Treating these as the architect's decisions — honor them, don't relitigate.
- Launched Explore agent to map current bottom-panel architecture (existing Codev scaffold tab +
  Codev: Dev tab, webview providers, active-editor APIs, Needs Attention view, persistence, tests).
- Next: write spec to codev/specs/1049-vscode-contextual-bottom-panel.md, signal SPEC_DRAFTED.

### 2026-08-12 — Spec drafted + 3-way consultation
- Wrote spec (all template sections). Explore agent confirmed: ext at apps/vscode; panel container
  `codevPanel` holds `codev.placeholder` (repurpose target) + `codev.dev` (leave alone); NO
  WebviewViewProvider exists yet (this is the first); all 3 data sources exist (ReviewQueueStore,
  SDK review-markers, OverviewCache).
- 3-way consult (porch-driven): Gemini APPROVE; Codex + Claude REQUEST_CHANGES (both HIGH conf).
  Convergent, high-quality feedback. Verified every source claim before acting:
  * getActiveBuilderId() @ terminal-manager.ts:450 (Codex fix — resolveBuilderTerminal is inverse). ✓
  * codev-diff: is base/LEFT side; right is file: (Claude fix). ✓
  * onDidChangeDiffInjectRegistry @ diff-inject-codelens.ts:235; registry populates AFTER diff
    activates → editor-only trigger reads stale key on first open. ✓
  * activeEditorIsBuilderFile true for ANY registered builder file (even normal tab) → real
    overlap: a builder's codev/specs/*.md in a diff session matches BOTH Doc-Review + Code-Review. ✓
  * markdownPreview customEditor priority:"option" → activeTextEditor undefined when reading spec
    via Codev preview → editor-centric model falls to Attention (breaks headline dev-approval). ✓
- Revised spec: (1) explicit predicate PRECEDENCE as required criterion (order = plan-gate
  decision; recommend terminal>diff>artifact>attention); (2) TAB-BASED context (window.tabGroups),
  not activeTextEditor; trigger set incl tab-group + terminal + diff-registry events; (3) VSCode-free
  resolver signature (SurfaceContext + ModeOverride, no Memento); (4) unified override model w/
  defined lifetime (session vs pinned); (5) webview security (nonce/CSP/localResourceRoots/escape);
  (6) expanded tests (overlap, custom-editor, event wiring, msg contract, pin round-trip); (7) pin
  scope reconciled with issue's per-window out-of-scope (workspaceState = per-folder).
- Left as plan-gate decisions (not overriding architect): precedence order, active-surface
  semantics, override clearing, pin scope, sticky-input.
- Next: commit "with multi-agent review", porch next → likely spec-approval gate.

### 2026-08-13 — At spec-approval gate: architect design iteration (NO PINNING)
- Reached spec-approval gate (porch gate 1049), notified architect. During gate review the
  architect drove several design refinements via conversation:
  1. Builder ATTACHMENT is derived, not chosen: terminal→getActiveBuilderId(), diff→registry
     DiffInjectSessionEntry.builderId. No global "current builder". Verified both in source.
  2. Builder-scoped modes (Code Review, Builder Inspector) have SUMMARY⇄DETAIL shape: detail =
     one builder; summary = cross-builder list (drill-in). Losing the surface rolls back to
     summary, never blanks. Attention = the global summary/fallback.
  3. **PINNING REMOVED ENTIRELY** (architect decision, reverses issue #1049's baked pin feature).
     Panel is purely contextual. Mode pills are TRANSIENT NAVIGATION (browse other modes/builders
     without touching editor), discarded on ANY active-surface change. Nothing persisted — NO
     codev.contextualPanel.pinnedMode, no workspaceState/globalState/config key.
- Rewrote spec to no-pin contextual + transient-nav model: Desired State (summary/detail table +
  attachment + transient nav), Success Criteria (no-persistence, transient nav, level in
  ModeDescriptor), Constraints (no-pin, transient host-side selection cleared on surface change,
  no persistence surface), Solution Approaches, Open Questions (dropped pin-scope + override-
  lifetime + pin-visual; kept precedence, active-surface semantics, reset-granularity, sticky-
  input), Test Scenarios (transient-clear invariant, summary/detail), Risks (stuck-off-context,
  auto-switch-yanks-input). Swept for lingering pin/override/persist — all remaining are intentional.
- Resolver signature now: (SurfaceContext, ManualSelection|null) → ModeDescriptor{mode, level,
  context}. ManualSelection is transient, never persisted; host clears it on surface change.
- Interpretation flagged to architect: "any active-surface change resets transient nav" (incl
  tab-switching between open editors), not only new-file-open. Awaiting confirm.
- NOTE: issue #1049 body still describes pinning; architect should amend it. Spec records the
  supersession explicitly (Constraints).
- Gate still OPEN — spec revised in place (pre-approval). Need to ask architect: fresh consult on
  revised design, or approve as-is? Did NOT advance porch state.

### 2026-08-13 — Issue updated + iter2 cmap (architect-requested)
- Architect: "update the issue to match the specs" then "run cmap". Done both.
- Updated issue #1049 body surgically: removed all pinning (proposed pattern, panel header,
  architecture, ACs, plan-gate decisions, out-of-scope), added summary/detail + derived attachment
  + tab-based context, fixed marker format + trigger-set facts. Rest preserved.
- Ran cmap iter2 (manual, architect-requested — outside porch's iteration tracking; porch still at
  spec-approval gate). Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude COMMENT (all HIGH).
  Claude re-verified all codebase claims: "unusually high" accuracy. Design validated.
- Strongest finding (Codex+Claude, source-verified): my "most-recently-focused surface wins" lean
  has NO backing VSCode event for the EXIT path — returning focus from a builder terminal to an
  already-active editor fires none of tab-group/terminal/diff-registry events and activeTerminal
  stays set → Builder Inspector can't exit. Reframed as plan-gate API-feasibility question
  (candidate: onDidChangeTextEditorSelection + webview/terminal focus signal; accept some returns
  fire nothing). Added "never EXITS" risk row (had only "never triggers").
- Other iter2 fixes adopted: (a) locked precedence order in spec (terminal→diff→artifact→attention);
  (b) navigability per mode — CodeReview/BuilderInspector/Attention always navigable, DocReview
  disabled w/o artifact; (c) REMOVED sticky-input from umbrella (contradicted "immediate follow
  context"; draft preservation → participating mode); (d) dropped stale "amend issue" clause
  (already done); (e) placeholder retired + named 3 breaking manifest tests; (f) 7 render targets
  (no {document-review,summary}); (g) split ~50ms feel-check from O(1) automated assertion; (h)
  defined minimum summary/drill-in UI (builder-id stub) for umbrella scope.
- Rebuttal: 1049-specify-iter2-rebuttals.md. Gate still OPEN; porch state untouched.
- Next: report verdicts to architect; ready for spec-approval when they approve.

### 2026-08-24 — SPEC-APPROVAL GATE APPROVED (Amr, via VS Code button; architect ran porch approve w/ human attestation)
- porch done 1049 → advanced to PLAN phase. Now writing codev/plans/1049-*.md.
- 4 reminders carried from parked period (architect):
  1. Terminal→editor EXIT path has NO backing VS Code event; onDidChangeTextEditorSelection is the
     candidate proxy to design around (accept some returns fire nothing).
  2. extension.ts:555 hides codev.placeholder unconditionally — repurpose must retire that dead flip
     + stale text panel-placeholder.ts:18/20 + the :552 comment.
  3. Build local primitives (pill/header/list-row) with EXTRACTION SEAMS for #1549, but do NOT
     pre-build the shared layer (1549 extracts from proven code).
  4. **PROCESS: plan sections touching CONTRACT SURFACES route to architect BEFORE my plan gate.**
     Contract surfaces here = resolver contract (SurfaceContext/ManualSelection/ModeDescriptor types),
     the SurfaceContext-derivation + trigger set (incl the exit-proxy), and the host↔webview message
     contract. Must send these plan sections to architect for review before signaling done at the gate.
- Recon: esbuild.js has extensionConfig + webviewConfig (markdown-preview React IIFE). New panel webview
  = add entry src/contextual-panel/webview/main.ts → dist/webview/contextual-panel.js. Panel is a NEW
  registerWebviewViewProvider (first in the extension). React substrate (markdown-preview lineage) so
  Document Review can later host <ArtifactCanvas>.

### 2026-08-24 — PLAN drafted (commit 91f1958d9)
- 4 phases: (1) resolver+types [CONTRACT], (2) panel surface + placeholder retirement, (3) context
  adapter + contextual switching [CONTRACT: SurfaceContext/triggers/exit-proxy], (4) transient nav +
  summary stubs [CONTRACT: message contract]. React substrate (esbuild IIFE, markdown-preview lineage).
- Signaled PLAN_DRAFTED → porch done → cmap task. Launched gemini/codex/claude plan consult (iter1) bg.
- Per reminder #4: routed the 3 CONTRACT SURFACE sections to architect via afx send --file for pre-gate
  review. HOLDING the plan gate until architect responds; will fold their notes + cmap into rebuttal.
- afx send note: `--file` AUGMENTS a message, needs a message string too (not a replacement).
- Next: read cmap verdicts + architect contract feedback → revise → rebuttal → plan gate.

### Plan iter1 feedback to fold (architect + Codex REQUEST_CHANGES + Gemini APPROVE; Claude cmap PENDING)
ARCHITECT contract review (4 notes + 1 minor):
- A1 [BLOCKING] Type placement: SurfaceContext/ManualSelection/ModeDescriptor/messages are EXTENSION-
  INTERNAL → apps/vscode local module, NOT codev-types. My plan already puts them in apps/vscode/src/
  contextual-panel/types.ts (compliant) — STATE IT EXPLICITLY in plan.
- A2 Artifact regex also matches .builders/<id>/codev/... (COMMON case): worktree artifact = surface
  'artifact' + builderId from .builders/<id>/ segment; DECIDE+document whether derivable builderId
  enables builder-scoped modes. => decision: yes, enables Code Review/Builder Inspector applicability
  scoped to that builder.
- A3 Terminal identity (#1497): getActiveBuilderId() must key off verified terminal->builder map, never
  a label. Already does (terminal-manager.ts:450: entry.terminal===active && map key builder-<id>) — CITE it.
- A4 Webview input validation: validate mode∈ModeKind AND builderId∈known-builders before acting;
  invalid→ignore. Phase 4 + test.
- A5 [minor] Record 1-line rationale for "never emits {document-review,summary}" (Doc Review has no summary).
CODEX (REQUEST_CHANGES, all HIGH — several real bugs):
- C1 Terminal-exit proxy incomplete: getActiveBuilderId() still non-null after editor refocus → need
  explicit LAST-FOCUSED-SURFACE state (editor vs terminal); report terminal only when last-focused=terminal.
- C2 Clearing "on every trigger" WRONG: cursor moves / bg tab / registry refresh would wipe transient nav.
  Compare STABLE SURFACE IDENTITY (kind+path+builderId); clear only on actual transition.
- C3 SurfaceContext.surface is a pre-resolved single discriminator → resolver can't do precedence/overlap
  tests. Change contract: SurfaceContext carries INDEPENDENT predicate signals; resolver applies precedence.
  (CONTRACT CHANGE — re-flag to architect before gate.)
- C4 Diff derivation underspecified: context keys can't be read back (setContext is write-only); use
  TabInputTextDiff / vscode.changes input + diff-inject registry provider.get(fsPath)->builderId.
- C5 Tests under src/contextual-panel/__tests__ WON'T RUN (vitest include = src/__tests__/**). Move to
  src/__tests__/contextual-panel-*.test.ts.
- C6 tsconfig sync: update tsconfig.json (exclude contextual-panel/webview) + tsconfig.webview.json
  (include it) for DOM type-check. (Gemini also.)
- C7 Manifest view needs "type":"webview".
- C8 Spec says "seven" render targets but it's SIX (1+2+2+1). Spec frozen → enumerate 6 in plan, flag typo.
- C9 Changelog not assigned to a phase → assign to Phase 4 deliverable.
GEMINI (APPROVE): G1 tsconfig sync (=C6). G2 DI: PanelProvider needs OverviewCache, ReviewQueueStore,
  TerminalManager, extensionUri injected at registration.
CLAUDE (REQUEST_CHANGES, source-verified): confirms C5/C6/C7 + precedence-violation; NEW: diff side =
  input.modified.fsPath (original is codev-diff: → misses builderId); WEBVIEW VISIBILITY lifecycle
  (resolveWebviewView re-fires, can't post to hidden webview → cache+re-post on resolve+onDidChangeVisibility);
  panel-placeholder.test.ts DELETE not modify (keep contributes-panel sidebar/PANEL_REVEALED_KEY asserts);
  minor: security escape test explicit, enumerate targets, pick view id.

### Plan revised (all folded) — verified vitest include / tsconfig / fsPath-side / createElement against source
- All 5 architect + 9 Codex + Claude + 2 Gemini items adopted. Decisions locked: view id = NEW
  codev.contextualPanel (remove placeholder); primitives use React.createElement (no JSX); tests →
  src/__tests__/contextual-panel-*.test.ts; SurfaceContext = INDEPENDENT PREDICATES (artifact/builderDiff/
  builderTerminal) so resolver does precedence; worktree artifact carries builderId + enables builder-scoped
  applicability; render targets = SIX (spec typo "seven" flagged, spec frozen).
- Rebuttal: 1049-plan-iter1-rebuttals.md.
- CONTRACT CHANGES vs what architect reviewed: SurfaceContext shape (predicates not single discriminator),
  diff derivation (TabInputTextDiff.modified + registry, not context key), worktree-artifact applicability,
  message value-validation. MUST re-flag delta to architect before gate (their standing rule).
- Next: commit "plan with multi-agent review"; re-flag contract delta to architect; then plan gate.

## Plan-phase notes (do NOT apply to spec — captured for when we reach PLAN)

### Placeholder dead-code cleanup (architect note 2026-08-14, verified against source)
The repurpose of `codev.placeholder` into the contextual panel must ALSO retire orphaned dead code,
not just add the new view. Verified:
- `apps/vscode/src/extension.ts:555` — `setContext codev.panelContainerEmpty false` is unconditional
  (because `codev.dev` is always present), so `codev.placeholder` (gated by that key) can NEVER render.
  This flip becomes dead once the placeholder is gone → retire it.
- `apps/vscode/src/views/panel-placeholder.ts:18,20` — stale body/tooltip text advertising #813/#814/
  #815 as future panel tabs, shown to a user who by construction can't see the view → remove.
- `apps/vscode/src/extension.ts:552` comment calls #813/#814/#815 "sibling tabs" — now STALE (see
  rescope ruling below); clean up as part of the same repurpose.
- Existing manifest tests already flagged in spec Constraints (contributes-panel / panel-placeholder /
  contributes-dev) will need updating in lockstep.

### Architect confirmations on follow-ons (2026-08-24) — carry into PLAN/IMPLEMENT
- **1049 spec stays BYTE-FROZEN at the owner gate** — NO scope movement from either follow-on
  (#1548, #1549). Do not edit the spec for them.
- **Implementation rule:** build the panel's local primitives (pill/header/list-row) with clean
  EXTRACTION SEAMS in mind, but do NOT pre-build the shared layer. #1549 extracts from proven code,
  not speculation. => local + small now; generalize later.
- **#1548** is a sibling follow-on: "generalizes contexts"; **#1549** "generalizes the rendering
  substrate". Both follow the same ruling as here: surface first, generalize after. #1049 is the
  proving ground for both; #1049 must not block on either.

### #1549 — shared webview foundation (filed 2026-08-25, architect-directed)
Spun off from a #1049 design discussion: no shared Codev webview component/style layer exists
(only VSCode `--vscode-*` tokens); artifact-canvas is currently scoped to markdown artifacts only.
Architect decision: EXPAND artifact-canvas into a general-purpose renderer (not a new package) —
"a canvas is meant to be a general-purpose renderer". #1049 is the forcing function + first consumer.
SEQUENCING (recorded so the plan honors it): #1049 must NOT block on #1549 — #1049 ships its few
primitives (pill/header/list-row) LOCAL + small; #1549 extracts/generalizes them afterward using
#1049 as proving ground. Keep #1049's plan self-contained; treat #1549 as a later extraction, not a
dependency. Substrate decision for #1049 stands: React panel so Document Review can host <ArtifactCanvas>.

### #813/#814/#815 rescope ruling (architect, 2026-08-14)
#813 (Recently Closed) / #814 (Team) / #815 (Status) are HELD pending this surface and will be
rescoped as PARTICIPATING FEATURES rendering into the contextual panel's modes (e.g. Attention
sub-views), NOT sibling panel tabs. => The umbrella/participating boundary is the load-bearing part
of that design — keep it CRISP in the plan (umbrella ships skeleton + resolver + switching + minimal
stubs; these three render their content into my mode render-targets in their own PRs).

### 2026-08-24 — Pre-gate flags addressed (commit fd07b555a); PROTOCOL correction noted
- Architect delta review APPROVED both mechanism changes (independent predicates; TabInputTextDiff.modified).
- Two pre-gate flags addressed IN PLAN (messages had crossed):
  1. Surface identity = TUPLE (kind, resourcePath, builderId). builderId/resourcePath change is a
     transition even at same kind → builder A terminal → builder B terminal CLEARS transient nav
     (#1497 guard). Added explicit sentence + test case.
  2. 6-vs-7 render targets ENUMERATED + MAPPED in plan: spec's own list = 6 (1+2+2+1); "seven"
     miscounts its own list → counting artifact, NO dropped/merged target → documentation-only, no
     scope change. Per architect, no re-route needed (only if a target were dropped).
- PROTOCOL CORRECTION (architect): I do NOT run porch approve, EVER. Flow: Amr decides → architect
  records via porch approve. My post-approval action = porch done to advance. (My earlier "I'll run
  porch approve on Amr's decision" was wrong wording; corrected.)
- Plan-approval gate refreshed for Amr; HOLDING. Post-approval: architect runs porch approve, then I
  run porch done → begin Phase 1 (resolver + types).

### 2026-08-24 — IMPLEMENT Phase 1 (Mode resolver + contract types) — done, verifying
- plan-approval APPROVED by Amr (architect recorded via porch approve). porch done → implement, phase_1.
- Created: apps/vscode/src/contextual-panel/types.ts (extension-local contract), resolver.ts (pure
  resolveMode), src/__tests__/contextual-panel-resolver.test.ts (24 tests).
- Design: SurfaceContext = independent predicates; resolver applies precedence terminal→diff→artifact
  →attention; ManualSelection overrides only to an APPLICABLE mode (doc-review needs artifact); never
  emits {document-review,summary} (forced detail); never throws (cleanString guards → attention).
  Worktree artifact carries builderId into context (A2). Applicability: doc-review = artifact present,
  others always true.
- Env: had to build workspace deps (codev-types, codev-sdk, artifact-canvas) — worktree dist/ was
  missing → 18 pre-existing test files + check-types failed on UNBUILT deps (not my code). After build:
  test:unit 69 files / 836 tests PASS (my 24 incl); check-types CLEAN. dist/ gitignored (not committed).
- Next: signal PHASE_COMPLETE → porch consultation + checks → commit/next phase.

### 2026-08-24 — Phase 1 cmap iter1 → fixed (commit af384f9bd)
- Gemini APPROVE; Codex REQUEST_CHANGES (code untracked → diff had only docs); Claude COMMENT
  (full suite/types/lint verified green; 2 substantive).
- PROCESS MISS: signalled PHASE_COMPLETE with code UNTRACKED → reviewers saw only docs. Fixed: now
  commit phase code BEFORE signalling. Lesson for phases 2-4: commit implementation first.
- A2 was a NO-OP: resolveSelection dropped artifact.builderId. Realized it: scopedBuilderId =
  drilledBuilderId ?? artifact?.builderId → clicking Code Review/Builder Inspector on a worktree
  artifact lands on THAT builder's detail. +3 tests (worktree→detail scoped; plain artifact→summary).
- Added source-scan PURITY guard test (resolver imports only ./types.js; no vscode/node:). Spec makes
  no-I/O an automated criterion.
- Expanded never-throws to 6 surfaces × 6 selections (incl builderId:42). 28 tests, types+lint clean.
- Rebuttal: 1049-phase_1-iter1-rebuttals.md. Next: porch done (iter2) → re-consult → commit/Phase 2.

### 2026-08-24 — Phase 1 cmap iter2: ALL THREE APPROVE (HIGH)
- Gemini/Codex/Claude all APPROVE. Applied Claude's 2 cheap non-blocking hardening notes to the
  load-bearing core: (a) MODE_KINDS is now Record<ModeKind,true> — exhaustive by construction, a 5th
  mode fails to compile until listed; (b) purity source-scan now also catches side-effect/dynamic
  import + require (closed the from-only gap). 28 tests, types+lint clean.
- CARRY TO PHASE 4 (Claude non-blocking note, confirm w/ architect before pills go live): manual
  selection scopes to artifact.builderId but DROPS builderDiff/builderTerminal ids. Defensible per
  spec walkthrough, but decide at Phase 4 whether clicking e.g. Builder Inspector while a diff is
  active should scope to the diff's builder.
- Next: commit, porch done (re-verify) → porch should commit phase + advance to Phase 2.

### 2026-08-25 — IMPLEMENT Phase 2 (Panel surface + placeholder retirement) — done, verifying
- Created: contextual-panel/panel-provider.ts (WebviewViewProvider — FIRST in ext), panel-template.ts
  (nonce/CSP HTML), webview/main.ts (React createElement static shell), webview/components.ts (Pill,
  HeaderStrip local primitives — #1549 seams), webview/styles.css (--vscode-* tokens).
- Wiring: esbuild.js 3rd IIFE bundle (dist/webview/contextual-panel.js/.css); tsconfig.json exclude +
  tsconfig.webview.json include the webview dir; package.json codevPanel: codev.placeholder → 
  codev.contextualPanel {type:webview}; extension.ts registerWebviewViewProvider (retainContextWhenHidden).
- Retired placeholder: deleted views/panel-placeholder.ts + __tests__/panel-placeholder.test.ts +
  the dead setContext panelContainerEmpty flip + :552 comment. Updated contributes-panel.test.ts
  (contextual view + no-placeholder/no-gate asserts, kept sidebar+reveal-once) + contributes-dev comment.
- COMMITTED FIRST this time (e5b8924f0) — learned from phase 1.
- Verify: esbuild 3 bundles OK; check-types clean (both); eslint clean; vitest 68 files / 838 tests PASS.
- Descriptor cache + re-post on visibility deferred to Phase 3 (when host posts descriptors) — noted.
- Next: signal PHASE_COMPLETE → porch checks + cmap.

### 2026-08-25 — Phase 2 cmap iter1 → addressed
- Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES. Convergent: visibility-cache deliverable
  was assigned to Phase 2 but deferred (silent). DI omitted. No template test.
- Visibility cache: FORMALLY RELOCATED to Phase 3 in the plan (not dropped) — it's inseparable from
  descriptor posting (Phase 3); implementing in P2 = dead untested scaffolding + noUnusedLocals. Added
  as P3 deliverable+AC+test. Captured retainContextWhenHidden coupling (view NOT re-resolved on
  re-show → onDidChangeVisibility is the re-post trigger, per Claude).
- DI: documented DI-when-needed in plan (TerminalManager P3, stores P4) — injecting unused deps = dead
  params.
- Added contextual-panel-template.test.ts (5 tests: nonce↔CSP↔script binding, default-src none, no
  inline/wildcard, cspSource scoping, distinct nonce/render). Security-relevant surface.
- Manual EDH render: can't evidence headless → flagged as dev-approval item (honest).
- 69 files / 843 tests, types+lint clean. Rebuttal: 1049-phase_2-iter1-rebuttals.md.

### 2026-08-25 — Phase 2 cmap iter2: Gemini APPROVE, Claude APPROVE, Codex COMMENT (phase accepted)
- No REQUEST_CHANGES. Two non-blocking notes, BOTH reviewer-scoped to Phase 3 (they live in files P3
  rewrites) → deferred to Phase 3, NOT re-iterating Phase 2:
  * P3-TODO-A: panel-provider.ts comment is INVERTED — under retainContextWhenHidden:true,
    resolveWebviewView does NOT re-fire on re-show (my comment says it does). Fix when P3 adds the
    cache/re-post. Correct statement: context persists; re-post cached descriptor on onDidChangeVisibility.
  * P3-TODO-B: components.ts Pill uses `disabled` attr + title → tooltip won't render in Chromium
    (greyed-pill hover hint invisible). Switch to aria-disabled + no onClick (also better a11y:
    keeps pill focusable/discoverable). Do in P3 when pills get real applicability wiring.
- Cosmetic (left, justified): style-src 'unsafe-inline' kept (matches markdown-preview; P3/P4 bodies +
  React inline styles will use it); .cp-context .cp-builder CSS is for P3's builder-name label.
- Next: porch should advance to Phase 3 (Context adapter + contextual switching).

### 2026-08-25 — IMPLEMENT Phase 3 START (Context adapter + contextual switching)
- KEY API finding: @types/vscode 1.105 Tab.input union = TabInputText|TabInputTextDiff|TabInputCustom|
  TabInputWebview|TabInputNotebook|TabInputNotebookDiff|TabInputTerminal|unknown. NO TabInputTextMultiDiff!
  → multi-file vscode.changes diff has UNKNOWN tab input. Handle diff predicate as: (a) TabInputTextDiff
  → getDiffInjectEntry(input.modified.fsPath).builderId; (b) multi-diff (unknown tab) → focused sub-file =
  activeTextEditor.fsPath → registry lookup, BUT only when tab is NOT text/custom (else a normal-tab builder
  file misreads as diff). Registry lookup = getDiffInjectEntry(fsPath) (diff-inject-codelens.ts:217);
  change event = onDidChangeDiffInjectRegistry.
- Design: pure deriveSurfaceContext(TabInfo,...) returns INDEPENDENT predicates (collects all, resolver
  picks precedence — the C3 contract); surfaceIdentity(descriptor) pure. Thin SurfaceContextReader does
  vscode instanceof classify + reads live state + tracks lastFocused. Provider subscribes triggers in ctor,
  re-derive+resolve, POST ONLY when surfaceIdentity changes (cheap on cursor-moves), cache lastDescriptor,
  re-post on onDidChangeVisibility (retain:true → resolveWebviewView NOT re-fired). Inject TerminalManager.
- Also fixing P3-TODO-A (provider lifecycle comment) + P3-TODO-B (Pill: aria-disabled not disabled attr so
  title tooltip renders). Header text escaping = React auto-escape (descriptor via postMessage as DATA, never
  interpolated into HTML) — document it.

### 2026-08-25 — IMPLEMENT Phase 3 done, verifying (commit e8baa9d4f)
- Files: messages.ts (render/ready contract), surface-context.ts (PURE deriveSurfaceContext +
  surfaceIdentity — split so vscode-free/testable), surface-reader.ts (vscode glue: classifyTab +
  SurfaceContextReader + last-focus), panel-provider.ts (rewrite: triggers→resolve→post-on-identity-
  change, cache + onDidChangeVisibility re-post, ready→repost, inject TerminalManager; fixed P3-TODO-A
  comment), webview/main.ts (message-driven render, labelFor, per-mode placeholder), components.ts
  (Pill aria-disabled = P3-TODO-B fix + pillsFromDescriptor), extension.ts (pass terminalManager+dispose).
- Split surface-context.ts → pure core + surface-reader.ts (host) because importing vscode at module
  top broke the pure vitest test. Mirrors resolver.ts purity.
- Tests: surface-context (13 pure), provider (6, mocked vscode + diff registry) incl the terminal→editor
  EXIT test (getActiveBuilderId stays 'b' but last-focus demotes → attention; the #1497/flagged-bug guard).
- Multi-file diff has UNKNOWN tab input (no TabInputTextMultiDiff in 1.105) → builder from focused
  sub-file (activeTextEditor), gated so normal-tab builder file isn't misread as diff.
- Header text escaping = React auto-escape (descriptor posted as DATA, never HTML-interpolated) — documented.
- Verify: 71 files / 862 tests, check-types + eslint + build all clean. Committed before signaling.
- Visibility cache (relocated from P2) DONE here as promised.
- Next: PHASE_COMPLETE → porch checks + cmap.

### 2026-08-25 — Phase 3 cmap iter1 → fixed
- Gemini APPROVE; Codex + Claude REQUEST_CHANGES (real bugs, some forward into P4).
- FIXES: (1) surfaceIdentity(descriptor) → surfaceKey(inputs) [raw surface] + provider transition id =
  surfaceKey|descriptor (catches file-A→B same-Attention AND diff-registry-populate same-tab); (2) diff
  now emits BOTH builderDiff + artifact when modified is a codev artifact (Document Review stays navigable);
  (3) tab-focus gated on ACTIVE-TAB ACTIVATION (seeded lastTabResource on resolveWebviewView) — background
  churn no longer demotes a focused terminal; (4) added provider diff + registry-populate tests (real
  getDiffInjectEntry + onDidChangeDiffInjectRegistry wiring); (5) header-escaping source-scan (no
  innerHTML/dangerouslySetInnerHTML); (6) per-view disposables in separate array, disposed on re-resolve.
- Caught a self-bug mid-fix: lastTabResource started undefined → first churn read as activation → seed it.
- 71 files / 870 tests, check-types+eslint+build clean. Rebuttal: 1049-phase_3-iter1-rebuttals.md.

### 2026-08-25 — Phase 3 cmap iter3
- Gemini+Claude APPROVE; Codex REQUEST_CHANGES: multi-diff sub-file nav stale (no onDidChangeActiveTextEditor).
  FIXED: added onDidChangeActiveTextEditor trigger + multi-diff provider test (sub-file change re-resolves,
  artifact applicability flips). 72 files/875 tests.
- Claude non-blocking → PHASE 4 TODOs: (a) 'other' tabs share identity (edge, webview/settings); (b) disabled
  hint wording is artifact-specific (fine — DocReview only disable-able mode); (c) transitionIdOf omits
  level/applicability (re-verify when ManualSelection lands).

### 2026-08-25 — IMPLEMENT Phase 4 (Transient navigation + summary stubs) — done, verifying (891b938c9)
- messages.ts: NavigateMessage/DrillInMessage + parseNavigation (validates mode∈ModeKind AND
  builderId∈known-builders; invalid→ignore). pills.ts: isModeKind.
- provider: in-memory ManualSelection (NEVER persisted); onMessage → parseNavigation → set selection →
  evaluate('manual'); evaluate('surface') CLEARS selection when surfaceKey changes (clear-on-transition);
  summaryFor() = buildersWithPending() (code-review) / overview builder ids (builder-inspector); postId
  includes summary ids so a queue/overview change re-posts. Injected ReviewQueueStore + OverviewCache.
- webview: navigable pills → mode-navigate; SummaryList (builder-id rows) → drill-in; EmptyState.
  local List/Row primitives + CSS (#1549 seams).
- Tests: messages validation (8), provider navigation (navigate→summary, drill-in→detail, invalid
  ignored, surface-change clears selection, summary re-post on queue change), no-persistence source+
  manifest scan. 74 files / 890 tests, types+eslint+build clean.
- CHANGELOG: NOT on this branch — per repo convention (UNRELEASED.md self-doc) it's the architect's
  post-merge docs/vscode-changelog workflow (worktrees/changelog). Updated plan to reflect. Entry text
  provided to architect below.
- ALL 4 PHASES IMPLEMENTED. Next: PHASE_COMPLETE → cmap; then PR.

### CHANGELOG ENTRY TEXT — for the architect's docs/vscode-changelog post-merge workflow (#1049)
apps/vscode/CHANGELOG.md (under [Unreleased] → What's new):
- **Contextual `Codev` bottom-panel tab.** A single panel tab that follows what you're looking at:
  spec/plan/review markers when an artifact is open (Document Review), a builder's review queue on its
  diff (Code Review), a builder's phase/gate/activity on its terminal (Builder Inspector), or a
  cross-builder "what needs my attention" roll-up otherwise. Mode pills navigate between them and snap
  back to context the moment you change what you're looking at; nothing is pinned or persisted. This
  ships the panel skeleton, resolver, and switching — each mode's rich content arrives with its own
  feature (#1037 review comments, #859/#945 markers, files-not-yet-reviewed). The old empty "Codev"
  placeholder tab is replaced; `Codev Dev` is unchanged.

docs/releases/UNRELEASED.md (its own ## section):
## Contextual bottom panel
The `Codev` bottom-panel tab now adapts to what you're doing — Document Review, Code Review, Builder
Inspector, or an Attention roll-up — switching automatically with the active editor/terminal and
offering mode pills to browse. Purely contextual: no pinning, no persisted panel state.

### 2026-08-25 — Phase 4 cmap iter1 → fixed
- Gemini+Claude APPROVE; Codex REQUEST_CHANGES: active pill not clickable (no path detail→summary).
  FIXED: pillIsInteractive(state)=state!=='disabled'; Pill attaches onClick for active too; clicking
  active builder-scoped pill → mode-navigate (no builderId) → summary. +tests. Provided changelog text
  in thread (was promised, missing). 74 files/892 tests.

### 2026-08-25 — Phase 4 cmap iter2 (Codex vs Claude SPLIT on A2 navigation)
- Gemini+Claude APPROVE; Codex REQUEST_CHANGES: resolveSelection artifact fallback → summary
  unreachable while viewing a worktree artifact. Claude: intended per A2, non-blocking.
- RESOLUTION: moved A2 nav-scoping resolver→provider. resolveSelection now pure (builderId→detail
  else summary). Provider selectionForNavigate: first-click on CR/BI over a worktree artifact scopes
  to that builder (A2 kept); clicking the ACTIVE detail mode zooms out to summary. Satisfies both.
- FLAGGED to architect: this refines A2's navigation semantics (zoom-out) — they can veto.
- 74 files/891 tests (consolidated 2 resolver A2 tests → 1).

### 2026-08-25 — A2 refinement ACCEPTED by architect (no veto) + gesture-family requirements
- Architect confirmed Codex's bug reading had spec grounding (always-navigable criterion promises the
  cross-builder summary is reachable). My synthesis kept all rulings. Two pre-PR requirements: complete
  gesture-family TEST+DOC, and state it as designed behavior in PR body + plan/review.
- Found+fixed a gap: click-active-at-SUMMARY over a worktree artifact re-scoped to detail (A2 fallback).
  Fix: selectionForNavigate — once already-in-mode (current.kind===mode), return {mode} (no A2 re-scope).
  Also removed the ctx/sel flag from postId (it broke the active-DocReview no-op: identical descriptor
  re-posted only because selection flag changed). Render = descriptor+summary only.
- Gesture family now: active+detail→summary; active+summary→no-op; active+DocReview→no-op(detail-only);
  zoom-out is transient, cleared on surface change→contextual. All 4 TESTED. Documented in plan Phase 4.
- 74 files/894 tests, types+eslint+build clean. Next: porch done → phase complete → PR.
