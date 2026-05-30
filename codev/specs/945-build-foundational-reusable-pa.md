# Specification: Foundational reusable package `@cluesmith/codev-artifact-canvas` for cross-surface markdown artifact review

## Metadata
- **ID**: spec-2026-05-31-945-build-foundational-reusable-pa
- **Status**: draft
- **Created**: 2026-05-31
- **GitHub Issue**: [#945](https://github.com/cluesmith/codev/issues/945)
- **Protocol**: SPIR
- **Predecessors / related**: #857 (VSCode editor-side inline REVIEW comments — shipped), #859 (comment-from-preview — on HOLD at plan-approval, will re-plan against this), #858/#860–#863 (review-surface family — consume this package)
- **Area**: `area/cross-cutting` (new package; eventual consumers are dashboard + vscode + future mobile)

## Clarifying Questions Asked

Issue #945 is an unusually complete architect brief — it pins the package boundary, the
adapter skeleton, the theming strategy, the text-as-source-of-truth invariant, a proposed
phase decomposition, acceptance criteria, and an explicit out-of-scope list. No blocking
clarification was sought before drafting; the spec's job here is to **lock** the structural
decisions the issue proposes and to surface the one genuine inconsistency found during
codebase verification (the REVIEW marker format — see Open Questions §1). The remaining
"real spec decisions" the issue itself flagged (single package vs sub-packages, adapter
sync/async semantics, ThemeAdapter push vs pull, region-marker serialization, CSS strategy)
are resolved below with rationale.

## Problem Statement

Codev's natural-language artifacts — specs, plans, reviews — need an interactive rendering
and review surface. Today the only place a human can attach review comments to these files
is the **VSCode source editor** (gutter `+` via the Comments API, shipped in #857). Two
structural gaps follow:

1. **VSCode's built-in markdown preview cannot host the required interactions.** #859
   established that the platform's `previewScripts` / `markdownItPlugins` / `previewStyles`
   contribution points are render-only with no back-channel messaging to the extension host.
   Adding comment-from-preview cannot be done by extending the built-in preview; it requires
   *owning* the preview surface (a `CustomTextEditorProvider` + an extension-owned webview).

2. **The dashboard has no spec/plan/review surface at all.** It shows builders, PRs, and
   backlog, but offers no reading or review-comment affordance for the underlying artifacts.
   Architects working away from VSCode (meetings, a different machine, eventually mobile)
   have no review path.

Both gaps share a root cause: **there is no reusable layer for rendering Codev artifacts and
overlaying interactive review affordances.** Building it once per surface (VSCode webview,
dashboard route, future mobile wrapper) means three implementations to maintain and three
places the UX can diverge. Building it once as a shared package, adapted per surface, is the
only path that scales as the review-surface family (#858–#863) grows.

## Current State

- **#857 (shipped):** `packages/vscode/src/comments/plan-review.ts` provides editor-side
  inline review comments via the VSCode Comments API. Hover a line in `codev/{plans,specs,
  reviews}/*.md` → gutter `+` → inline input → the comment is written into the file as
  `<!-- REVIEW(@<author>): <text> -->` on the **following line**. The on-disk anchor is
  **positional** (the marker's location in the file), not an explicit line number. Parsing
  regex: `/<!--\s*REVIEW\s*\(@([^)]+)\)\s*:\s*([\s\S]*?)\s*-->/g`. Author is the current
  GitHub login, falling back to `architect`. `review-decorations.ts` highlights these lines.
  This flow is editor-only and must remain untouched.
- **Dashboard (`packages/dashboard`):** React 19 + Vite 6 + Vitest, served by Tower. No
  artifact-rendering or review surface exists.
- **Monorepo shape:** pnpm workspace (`packages/*`). Sibling packages establish conventions:
  `@cluesmith/codev-types` (pure types, `tsc`, ESM), `@cluesmith/codev-core` (runtime utils,
  `tsc`, ESM, multi-subpath `exports`), `@cluesmith/codev-dashboard` (React app, Vite). There
  is **no existing React component library package** and **no existing dual-format (CJS+ESM)
  build** in the monorepo — this package introduces both.
- **No package exists** at `packages/artifact-canvas/`.

## Desired State

A new package `@cluesmith/codev-artifact-canvas` (at `packages/artifact-canvas/`) that any
host can embed to get: a source-position-aware markdown renderer, an interactive
comment-authoring overlay (hover-`+`), and clean adapter seams for all I/O. After it lands:

- **#859** re-plans into a thin VSCode host: a `CustomTextEditorProvider` that wraps the
  package and implements three adapters (~200 LOC) instead of re-deriving rendering + overlay.
- **The dashboard** can gain an artifact route (separate future issue) by implementing the
  same three adapters against Tower endpoints — no second renderer.
- **Future mobile** (Capacitor/Tauri) embeds the same React components with a mobile adapter.

This issue ships **only the package and a smoke-test host**. No production host integration.

## Stakeholders
- **Primary users (indirect):** architects/reviewers who will eventually review artifacts in
  VSCode preview and the dashboard — they benefit once hosts consume the package.
- **Primary consumers (direct):** the builders/maintainers of #859 (VSCode host) and the
  future dashboard-route issue, who depend on the adapter contracts being right.
- **Technical maintainers:** Codev monorepo maintainers — this adds a package to the build
  graph and the first React-component-library + dual-bundle build in the repo.

## Goals
- A **single** publishable package providing a markdown renderer with source-line metadata,
  a comment-authoring overlay, and three host adapter interfaces.
- **Host-agnostic by construction**: zero direct filesystem / `fetch` / VSCode API imports
  in package source. All I/O flows through adapters supplied by the host.
- **Text-as-source-of-truth invariant** enforced by an automated test: no package affordance
  emits output that isn't either (a) a source-markdown text mutation or (b) a clearly
  delimited text artifact alongside the source.
- A **smoke-test host** demonstrating end-to-end: load sample markdown → render → hover →
  click `+` → adapter receives `{line}` → marker round-trips into text.
- A **dual-format (CJS + ESM)** build consumable by both a VSCode webview and the dashboard's
  Vite/ESM pipeline.

## Non-Goals (Out of Scope)
- **VSCode host integration** — #859's re-plan owns the `CustomTextEditorProvider` + adapters.
- **Dashboard host integration** — separate future issue; designed-for, not implemented.
- **Mobile host integration** — designed-for, not implemented.
- **Freehand sketch / voice / image annotation** — rejected by the text-as-source-of-truth
  invariant (cannot be read deterministically by teammates or by Claude-as-builder).
- **Region-lasso anchoring** — viable later (a lasso yields a text line range); the v1 type
  surface reserves a `lineRange` shape for it but ships no lasso UI.
- **Diff rendering (#858)** — hosts use `vscode.diff` (VSCode) or a separate lib (dashboard).
- **The later overlay/widget/panel features themselves** — TOC + per-heading toolbar (#861),
  reading/AC progress + frontmatter badges (#862), review-summary panel (#860), inline marker
  rendering + `<canvas>` minimap (#863). This package establishes the *layer and seams* they
  plug into; their feature work is their own issues. The directory skeleton may stub these
  folders, but only the renderer + comment overlay + adapters are implemented here.
- **markdown-it extensions** — core only for v1: no KaTeX (math), Mermaid, code syntax
  highlighting, or custom heading numbering. Each is a follow-up if needed.

## Constraints

### Baked decisions (from the issue — treated as fixed)
The issue body does not use a literal `## Baked Decisions` heading, but the following are
stated as architect decisions and are carried here as fixed constraints:

1. **Package name & location**: `@cluesmith/codev-artifact-canvas` at `packages/artifact-canvas/`.
2. **React-based components** (not framework-agnostic Web Components). Rationale in the issue:
   the dashboard's existing React investment makes React components far cheaper to embed; VSCode
   webviews and Capacitor/Tauri all host React fine.
3. **`markdown-it`** as the renderer core, with a `data-line` source-mapping rule.
4. **Adapter interfaces only** in the package — no adapter *implementations*. The three seams
   are `FileAdapter`, `MarkerAdapter`, `ThemeAdapter`.
5. **Theming via CSS custom properties** (`--codev-canvas-*`), with a shipped default
   stylesheet; hosts override the variables.
6. **Text-as-source-of-truth invariant** (see dedicated section) applies to every affordance.
7. **The "canvas" name** is metaphorical at v1 and becomes literal at #863 (minimap `<canvas>`).
8. **Dual-format bundle** (CJS + ESM) suitable for VSCode-webview and dashboard-Vite consumers.
9. **#857 stays untouched** — no regression to the editor-side review flow.

### Technical constraints
- pnpm workspace member under `packages/*`; version-aligned with the monorepo (`3.1.x`).
- `react` / `react-dom` as **peer dependencies** (range `^18 || ^19` — the dashboard is on
  React 19; VSCode webviews and mobile wrappers may pin 18). `markdown-it` as a direct dep.
  To honor the React 18 floor, **package source avoids React-19-only APIs** (no `use()`, no
  `useFormStatus`, no `useOptimistic`) — an iter-1 Claude refinement.
- **Packaging hygiene (iter-1 Codex/Claude):** the smoke-test host and any dev-only deps it
  pulls (`examples/`) are **excluded from the published package** (`files` array / build
  output) so they never ship to consumers.
- No Node-only or VSCode-only API may appear in shipped package source (enforceable by an
  import-boundary test and by the package having no `vscode`/`fs`/`node:*` imports).
- Must build to both CJS and ESM with type declarations and an importable default stylesheet.

## Locked Structural Decisions

These are the decisions the SPECIFY phase exists to lock. The HOW (build tooling choice,
file layout details, test framework wiring) is deferred to the plan.

### D1 — Single package, not sub-packages
Ship one package `@cluesmith/codev-artifact-canvas`. The internal folders (`renderer/`,
`overlays/`, `widgets/`, `panels/`, `adapters/`, `components/`) are organizational, not
separately published. **Rationale:** the surfaces share one dependency set and one release
cadence; sub-packaging adds workspace + versioning overhead with no consumer benefit at this
scale. Revisit only if an independent consumer needs the renderer without React.

### D2 — Adapter I/O is async; theme resolution is sync + push
- `FileAdapter.read` and `.watch`, and all `MarkerAdapter` methods, are **async**
  (`Promise`-returning). Hosts back them with async I/O (`vscode.workspace.fs`, Tower REST).
- `ThemeAdapter.resolve(token)` is **synchronous** (returns a resolved string); theme tokens
  are cheap, cached values read during render. Theme changes are delivered **push-style** via
  `ThemeAdapter.onChange(handler)` so the canvas re-renders on host theme switches.
- `watch` / `onChange` return a `Disposable` (`{ dispose(): void }`) for teardown.
- **Subscription lifecycle ownership (iter-1 Gemini/Claude):** the React component owns
  every subscription via `useEffect` cleanup — it calls `Disposable.dispose()` on unmount and
  on dependency change (e.g. `uri` change). The host's `Disposable` **must be idempotent**
  (calling `dispose()` more than once is a safe no-op).
- **Change coalescing (iter-1 Codex/Claude):** the package re-renders on *each* `watch` /
  `onChange` callback; it does **not** internally debounce. If a host fires high-frequency
  change events (e.g. a noisy file watcher), debouncing/coalescing is the host's
  responsibility before invoking the callback.
- **Error semantics (iter-1 all three):** adapter rejections are the **host's** concern in
  v1. The package `await`s adapter calls inside a guard: a rejected `MarkerAdapter.add` /
  `FileAdapter.read` is caught, logged via an injectable logger (defaulting to `console`),
  and surfaces to an **optional** host-provided `onError(err: unknown)` callback on the
  component; the package never throws out of an event handler and never silently corrupts
  state (a failed `add` leaves the rendered markers unchanged). There is no built-in retry in
  v1 — retry/toast UX is the host's call.

### D3 — The package is serialization-agnostic; the host owns on-disk marker format
The package defines the **in-memory** `ReviewMarker` shape and calls `MarkerAdapter.add(...)`;
it does **not** mandate how markers are written to disk. The host's `MarkerAdapter`
implementation owns serialization. **Rationale:** this is what keeps #857 untouched — the
VSCode host can keep the existing positional `<!-- REVIEW(@author): text -->` form, while a
dashboard host could choose an explicit-line form, without the package forcing either. The
`ReviewMarker.raw` field carries the original marker text for lossless round-tripping. (See
Open Questions §1 for the reconciliation this resolves.)

### D4 — Theming is pure CSS custom properties
The package ships `default-theme.css` mapping component styles onto `--codev-canvas-*`
variables (e.g. `--codev-canvas-foreground`, `--codev-canvas-background`,
`--codev-canvas-accent`, `--codev-canvas-comment-marker`). Hosts override by setting those
variables — e.g. `--codev-canvas-foreground: var(--vscode-foreground)` in a VSCode webview,
or dashboard design tokens on the dashboard. No CSS-in-JS, no CSS Modules; a single static
stylesheet keeps it consumable from both a webview `<link>`/inline-style and a Vite import.

### D5 — Renderer emits `data-line` on block tokens
The markdown-it instance carries a source-mapping rule that stamps `data-line="<n>"` on
rendered block elements: paragraphs, headings, list items, code blocks, blockquotes, tables.
This is the single source of truth the comment overlay uses to map a hovered block back to a
source line. Inline-level mapping is out of scope for v1 (block granularity matches the
comment model).

**Line base is 0-based (iter-1 all three).** `data-line` and the overlay callback's
`{ line }` are **0-based**, derived from markdown-it's `token.map[0]` (0-based at the AST).
This matches the existing #857 host, which reads/writes via VSCode's 0-based
`document.lineAt`. Hosts whose native API is 1-based convert at the adapter boundary. This
base is part of the contract and is documented in the README.

### D6 — Comment overlay is presentation + intent only
The hover-`+` overlay renders the affordance and, on click, invokes a host-supplied callback
with `{ line: number }`. The **text-input UX and the write-back both live in the host
adapter**, not the package. **Rationale:** input affordances differ per surface (VSCode
`InputBox`, a dashboard modal, a mobile sheet); forcing one into the package would couple it
to a surface. The package guarantees the *intent* ("comment requested at line N") and the
*round-trip refresh* (re-render markers after `MarkerAdapter` reports a change).

## Adapter Interface Contracts (the core SPECIFY deliverable)

These TypeScript interfaces are the package's public contract — getting them wrong forces
rework across 6+ dependent issues, which is why they're locked at spec time. They refine the
issue's skeleton with the D2/D3 semantics above. Exact field names are part of the contract;
the plan may add JSDoc but must not change shapes without re-approval.

```ts
/** Disposable handle returned by subscriptions; mirrors VSCode's Disposable shape.
 *  Implementations MUST make dispose() idempotent (calling it twice is a safe no-op). */
interface Disposable {
  dispose(): void;
}

/** Reads document content and notifies on external change. */
interface FileAdapter {
  read(uri: string): Promise<string>;
  watch(uri: string, onChange: (content: string) => void): Disposable;
}

/** Reads and mutates review markers. Serialization is the implementation's concern (D3). */
interface MarkerAdapter {
  list(uri: string): Promise<ReviewMarker[]>;
  add(uri: string, line: number, text: string, author: string): Promise<void>;
  // Reserved for later issues (declared as optional so hosts may implement incrementally):
  // addRegion?(uri: string, lineStart: number, lineEnd: number, text: string, author: string): Promise<void>;
  // setCheckbox?(uri: string, line: number, checked: boolean): Promise<void>; // AC-progress (#862)
}

/** Resolves theme tokens (sync, D2) and notifies on host theme change (push, D2). */
interface ThemeAdapter {
  resolve(token: string): string;       // e.g. resolve("foreground") → host-specific value
  onChange(handler: () => void): Disposable;
}

/** In-memory marker model. `raw` preserves the on-disk text for lossless round-tripping. */
interface ReviewMarker {
  author: string;
  line: number;
  text: string;
  raw: string;
  lineRange?: { start: number; end: number };  // reserved for region anchors (not used in v1)
}
```

## Text-as-Source-of-Truth Invariant (architectural guardrail)

Every interactive affordance the package surfaces **must serialize its output to structured
text in the source markdown** (or a clearly delimited adjacent text file). The invariant
exists because every annotation has two audiences who must act on it precisely: (1) teammates
re-reading the file later, and (2) Claude-as-builder spawned to address the feedback.
Affordances whose output requires interpretation rather than precise reading — freehand
drawings, voice notes, image overlays — are out of scope.

Concrete consequences (carried forward to every dependent issue):
- Comment overlays resolve to REVIEW markers in text (positional today; the host owns the
  exact byte form per D3).
- Region-anchored comments (later) resolve to a text marker carrying author + text + a
  structured line range.
- AC-progress checkboxes (later) mutate `- [ ]` ↔ `- [x]` in source.
- `<canvas>`-based rendering (later: minimap, possible lasso) are *rendering/input*
  primitives; the data they read and write remains text.

**Acceptance includes an automated test** asserting no package affordance produces output
that isn't (a) a source-markdown text mutation or (b) a clearly delimited adjacent text
artifact.

## Solution Approaches (alternatives considered)

### Approach A — Shared React package + per-host adapters *(chosen)*
Build the renderer, overlay, and adapter seams once; hosts implement three adapters.
- **Pros:** one renderer/overlay to maintain; UX parity across surfaces by construction;
  makes #859 thin and the dashboard route + mobile cheap; the adapter seam is the natural
  test boundary.
- **Cons:** introduces the repo's first React-component-library package and first dual-format
  build; the contract must be right up front (mitigated by this spec + the smoke-test host).
- **Complexity:** Medium. **Risk:** Medium (contract lock-in) — addressed by SPIR's gates.

### Approach B — Framework-agnostic Web Components *(rejected)*
- **Pros:** host-framework-neutral; embeddable anywhere.
- **Cons:** throws away the dashboard's React investment; React↔custom-element interop and
  styling/theming friction; the team's component idioms are React. The issue explicitly
  rejects this.

### Approach C — Build per surface, no shared package *(rejected — the status quo trap)*
- **Pros:** each surface optimal in isolation; no new package.
- **Cons:** three renderers + three overlays to maintain; UX divergence; every #858–#863
  feature implemented up to three times. This is exactly what the issue exists to prevent.

### Approach D — Extend VSCode's built-in markdown preview *(rejected — infeasible)*
#859 already established the built-in preview's contribution points are render-only with no
host back-channel, so comment-from-preview is impossible without owning the surface.

## Open Questions

### Critical (blocks progress) — none
All decisions needed to begin are resolved above.

### Important (affects design)

1. **REVIEW marker format reconciliation.** The issue body states the marker form is
   `<!-- REVIEW(@author, line=N): text -->` and calls it "the existing convention from #857".
   **Codebase verification shows that is not the current convention** — #857 writes positional
   `<!-- REVIEW(@author): text -->` (line implied by file position; regex captures author +
   text only). **Proposed resolution (per D3):** the package stays serialization-agnostic; the
   in-memory `ReviewMarker` carries `line` (derived from position on read) and `raw` (for
   round-tripping). The VSCode host preserves the positional #857 form (satisfying the
   "no regression" AC); a host that wants explicit `line=N`/`lines=N-M` may opt in without the
   package mandating it. *This will be raised with the architect at the spec-approval gate so
   the "existing convention" wording can be confirmed or corrected.*

2. **Smoke-test host form.** Issue leaves it to the implementer: a Vite dev-server route or a
   minimal VSCode webview. **Proposed:** a Vite dev-server harness inside the package
   (`examples/`), since it exercises the ESM build and the React components without VSCode
   tooling, runs in CI headlessly, and doubles as living adapter-implementation documentation.

### Nice-to-know (optimization)

3. **Build tool for the dual bundle** (`tsup` vs Vite library mode vs raw esbuild). A plan
   decision; the spec only requires the CJS+ESM+types+CSS output.
4. **Whether `default-theme.css` ships as a separate import path** (`.../default-theme.css`)
   vs auto-injected. Leaning separate import (explicit, tree-shakeable, host-overridable).

## Success Criteria / Acceptance Criteria

Functional (MUST):
- [ ] `packages/artifact-canvas/` exists; `package.json` declares
      `@cluesmith/codev-artifact-canvas`, peer-deps on `react`/`react-dom`, dep on `markdown-it`.
- [ ] Renderer produces HTML with `data-line` attributes on block tokens (paragraphs,
      headings, list items, code blocks, blockquotes); a unit test covers the attribution.
- [ ] A comment-overlay component renders a hover-`+` on rendered blocks; clicking invokes a
      callback receiving `{ line: number }`; the text-input + write-back live in the host
      adapter, not the package (unit test asserts the callback contract).
- [ ] Three adapter interfaces (`FileAdapter`, `MarkerAdapter`, `ThemeAdapter`) plus
      `ReviewMarker` and `Disposable` are exported from the public API; the package has zero
      direct filesystem, `fetch`, or VSCode-API imports (import-boundary test).
- [ ] Theming via CSS custom properties; the package supplies a default stylesheet mapping to
      `--codev-canvas-*` variables; documented host override examples.
- [ ] A smoke-test host demonstrates end-to-end: load sample markdown → render → hover →
      click `+` → adapter receives the call → marker round-trips.
- [ ] Build produces a **CJS + ESM** bundle (with type declarations) consumable by both a
      VSCode webview and the dashboard's Vite/ESM pipeline.
- [ ] **Text-as-source-of-truth invariant test**: no affordance produces output that isn't
      either a source-markdown text mutation or a clearly delimited adjacent text artifact.
- [ ] `README.md` documents the three adapter contracts + a host-implementation example.

Non-functional (MUST):
- [ ] **No regression** to the existing VSCode editor-side review flow (#857 untouched).
- [ ] Package source contains no `vscode`, `node:*`, or direct `fs`/`fetch` imports.
- [ ] New code carries unit tests; no reduction in monorepo test health (the new package's
      `test` script runs green and is wired into the build graph).

### Test Scenarios
**Functional**
1. Render a sample artifact; assert each block element carries the correct `data-line`.
2. Hover a block → `+` appears; click → callback fires with the expected `{ line }`.
3. A stub `MarkerAdapter.list` returns markers → they render; `add` is invoked with
   `(uri, line, text, author)` on a simulated submit; on resolve the markers re-render.
4. `ThemeAdapter.onChange` fires → the canvas re-renders with new resolved tokens.

**Non-functional**
5. Import-boundary test: scanning package source finds no forbidden imports.
6. Invariant test: enumerate affordances; assert each maps to text mutation / text artifact.
7. Build smoke: the CJS entry `require()`s and the ESM entry `import()`s without error.

## Dependencies
- **Blocks**: #859 (on HOLD) — released to re-plan against this once it ships.
- **Blocked by**: nothing.
- **Coordinates with**: `@cluesmith/codev-types` and `@cluesmith/codev-core` conventions for
  monorepo package shape (naming, version alignment, `exports` style).
- **Libraries**: `markdown-it` (dep); `react`/`react-dom` (peer); a dual-bundle build tool
  (plan-decided); Vitest + Testing Library (test, matching the dashboard).

## What This Unlocks
| Issue | After this lands |
|---|---|
| **#859** (HOLD) | Re-plans to a thin VSCode `CustomTextEditorProvider` (~200 LOC) wrapping the package. |
| **#860** (review-summary panel) | Ships as a panel component in the package; hosts mount it. |
| **#861** (TOC + per-heading toolbar) | Overlay component in the package; identical across surfaces. |
| **#862** (reading/AC progress, frontmatter badges) | Widget components in the package. |
| **#863** (inline markers + minimap) | Rendering-layer additions; the literal `<canvas>` first appears here. |
| **Dashboard artifact route** (future) | Becomes possible — same package, dashboard-side adapters. |
| **Future mobile review** | Becomes possible — same package, mobile-side adapters. |

## Why SPIR
- **The package boundary and adapter contracts are one-shot.** Get them wrong and 6+ dependent
  issues need rework. The SPECIFY phase exists to lock these as a deliberate contract before
  any code commits to them.
- **Cross-package blast radius**: monorepo package layout, the dashboard's eventual consumption
  story, and #859's re-plan dependency all hinge on this. SPIR's spec-approval gate makes the
  package boundary an explicit, reviewed contract; a lighter protocol would fold these
  decisions into implementation tradeoffs.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Adapter contract is wrong; dependents need rework | Med | High | Lock contracts at spec-approval; validate via the smoke-test host before merge; mark future methods optional for incremental adoption. |
| First dual-format (CJS+ESM) build in the repo is fiddly | Med | Med | Treat build tooling as its own plan phase with a build-smoke test (scenario 7). |
| Marker-format mismatch silently regresses #857 | Low | High | D3 keeps the package serialization-agnostic; explicit "#857 untouched" AC + open-question raised at the gate. |
| Scope creep into #860–#863 features | Med | Med | Non-Goals fence the implemented surface to renderer + comment overlay + adapters; later folders may be stubbed but not built. |
| React peer-version skew (dashboard 19 vs webview 18) | Low | Med | Peer range `^18 || ^19`; avoid React-19-only APIs in package source. |

## Consultation Log

### Iteration 1 — Specify (2026-05-31)
**Models:** Gemini (gemini-3.1-pro-preview), Codex (gpt-5.4-codex), Claude (claude-opus).
**Verdict:** all three **APPROVE WITH SUGGESTIONS** — no blockers; cleared to proceed to
planning. All three independently affirmed D3 (serialization-agnostic package) as the
keystone decision and praised the marker-format catch (Open Q §1).

Refinements folded into the spec from the convergent feedback:
- **Adapter error semantics** (all three) → added to D2: host owns errors in v1; package
  guards adapter calls, logs via injectable logger, surfaces to an optional `onError`
  callback, never throws out of a handler, no built-in retry.
- **`data-line` line base** (all three) → D5 now states 0-based explicitly (from
  `token.map[0]`), consistent with #857's `document.lineAt`; hosts convert at the boundary.
- **Subscription lifecycle ownership** (Gemini, Claude) → D2: React `useEffect` owns
  disposal; `Disposable.dispose()` must be idempotent (also noted on the interface).
- **Change coalescing** (Codex, Claude) → D2: package re-renders per callback, does not
  debounce; coalescing is the host's responsibility.
- **Packaging hygiene** (Codex, Claude) → Technical Constraints: `examples/` smoke host
  excluded from the published `files`/build output.
- **React 18 floor** (Claude) → Technical Constraints: package source avoids React-19-only
  APIs (`use()`, `useFormStatus`, `useOptimistic`).

Open Questions §3 (build tool) and §4 (default-theme import path) remain plan-level
decisions, as the reviewers agreed. Open Question §1 (REVIEW marker format) remains flagged
for the architect at the spec-approval gate — the D3 resolution stands regardless of the
wording fix.

## Notes
This spec deliberately includes the adapter interface signatures verbatim because, for this
feature, the interfaces *are* the specification (the WHAT) — not implementation detail. The
HOW (build tooling, file layout, test wiring, the smoke-test harness internals) is left to
the plan.
