---
approved: 2026-06-09
approval_note: >-
  Human override of the "approve only on a clean re-consult" bar. iter-4 consult on the
  committed spec was Claude APPROVE (HIGH), Codex REQUEST_CHANGES (HIGH, 3 small items),
  Gemini lane unavailable (agy not installed). Approved by the architect + session human
  with Codex's items deferred to the plan phase — NOT a clean 3-way pass.
validated: [claude]   # iter-4 APPROVE; codex REQUEST_CHANGES (deferred to plan); gemini lane unavailable
deferred_to_plan:
  - "Codex: D2 'injectable logger' claim has no matching prop in the locked interface — drop the claim or add the prop."
  - "Codex: ThemeAdapter.resolve token format — pin bare name (\"foreground\") vs full property (\"--codev-canvas-foreground\")."
  - "Codex: sanitization test must actually exercise DOMPurify — html:false neutralizes <script> first; retarget at a markdown javascript: link."
  - "Claude: clarify v1 marker-render fidelity vs #863 (what the canvas renders natively vs what #863 layers on)."
  - "Claude: fix path reference — review-decorations.ts is at packages/vscode/src/, not under comments/."
---

# Specification: Foundational reusable package `@cluesmith/codev-artifact-canvas` for cross-surface markdown artifact review

## Metadata
- **ID**: spec-2026-05-31-945-build-foundational-reusable-pa
- **Status**: approved 2026-06-09 (human override; see YAML frontmatter; 5 items deferred to the plan phase)
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
  GitHub login, falling back to `architect`. `review-decorations.ts` (at `packages/vscode/src/`, not under `comments/`) highlights these lines.
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

### D2 — Adapter I/O is async; subscriptions and theme resolution are sync
- **Async (`Promise`-returning):** `FileAdapter.read` and all `MarkerAdapter` methods. Hosts
  back them with async I/O (`vscode.workspace.fs`, Tower REST).
- **Synchronous, returns a `Disposable` immediately:** `FileAdapter.watch` and
  `ThemeAdapter.onChange` *register* a subscription and return `{ dispose(): void }` right
  away; the notifications themselves arrive **asynchronously** via the supplied callback.
  (iter-2 Codex: this resolves the earlier prose that wrongly lumped `watch` in with the async
  methods — the interface signatures are the source of truth.)
- **Synchronous, returns a value:** `ThemeAdapter.resolve(token)` returns a resolved string;
  theme tokens are cheap, cached values. See **D4** for the exact `resolve()`-vs-CSS-variable
  responsibility split.
- **Subscription lifecycle ownership (iter-1 Gemini/Claude):** the React component owns
  every subscription via `useEffect` cleanup — it calls `Disposable.dispose()` on unmount and
  on dependency change (e.g. `uri` change). The host's `Disposable` **must be idempotent**
  (calling `dispose()` more than once is a safe no-op).
- **Change coalescing (iter-1 Codex/Claude):** the package re-renders on *each* `watch` /
  `onChange` callback; it does **not** internally debounce. If a host fires high-frequency
  change events (e.g. a noisy file watcher), debouncing/coalescing is the host's
  responsibility before invoking the callback.
- **Error semantics (iter-1 all three):** adapter rejections are the **host's** concern in
  v1. The package guards the adapter calls *it* makes — `FileAdapter.read` / `.watch` and
  `MarkerAdapter.list`: a rejection is caught, logged to the `console`, and surfaces to an
  **optional** host-provided `onError(err: unknown)` callback on the component; the package
  never throws out of an event handler and never silently corrupts state (a failed `list`
  leaves the prior
  rendered markers unchanged). `MarkerAdapter.add` is invoked by the **host** (D6), so its
  rejection is handled host-side. There is no built-in retry in v1 — retry/toast UX is the
  host's call.

### D3 — The package is serialization-agnostic; the host owns on-disk marker format
The package defines the **in-memory** `ReviewMarker` shape; the **host** calls
`MarkerAdapter.add(...)` (per D6 the package emits a comment *intent* event and never writes
markers itself). The package does **not** mandate how markers are written to disk. The host's
`MarkerAdapter` implementation owns both the call and the serialization. **Rationale:** this is what keeps #857 untouched — the
VSCode host can keep the existing positional `<!-- REVIEW(@author): text -->` form, while a
dashboard host could choose an explicit-line form, without the package forcing either. The
`ReviewMarker.raw` field carries the original marker text for lossless round-tripping. (See
Open Questions §1 for the reconciliation this resolves.)

### D4 — Theming is pure CSS custom properties (`resolve()` is JS-side only)
**CSS custom properties are the sole theming mechanism for v1 rendering.** The package ships
`default-theme.css` mapping all component styles onto `--codev-canvas-*` variables. Hosts theme
the canvas by **setting those variables** on the canvas container — e.g.
`--codev-canvas-foreground: var(--vscode-foreground)` in a VSCode webview, or dashboard design
tokens on the dashboard. No CSS-in-JS, no CSS Modules; a single static stylesheet keeps it
consumable from both a webview `<link>`/inline-style and a Vite import.

**v1 `--codev-canvas-*` token vocabulary** (the default stylesheet ships a fallback value for
each; hosts override any subset):
`--codev-canvas-foreground`, `--codev-canvas-background`, `--codev-canvas-accent`,
`--codev-canvas-border`, `--codev-canvas-muted` (secondary text),
`--codev-canvas-code-background`, `--codev-canvas-link`,
`--codev-canvas-comment-marker` (the hover-`+` / marker affordance color).

**Responsibility split with `ThemeAdapter.resolve()` — Model A (iter-2 Codex/Claude, also
iter-1 Gemini):** v1 rendering and overlays bind to the **CSS variables**, never to
`resolve()`. `ThemeAdapter` exists for **JS-side consumers that must read an exact value** —
chiefly #863's `<canvas>` minimap, which has to read a hex color to paint pixels. `resolve(token)`
returns the current value of a `--codev-canvas-*` token and `onChange` lets such a consumer
repaint on a host theme switch. **In v1 `resolve()` is therefore *not* on the render path** —
it is part of the locked contract for the #863 era and is exercised only by the smoke-test host
and a unit test, not by the v1 renderer or overlay. (This is the long-standing ThemeAdapter/CSS
overlap, now resolved rather than deferred.)

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
The hover-`+` overlay renders the affordance and, on click, invokes the component's
**`onAddComment(line: number)`** prop — the single canonical comment-intent seam (formally
typed as `ArtifactCanvasProps.onAddComment` in the interface block; `line` is 0-based per D5).
**The package stops there.** The text-input UX *and* the write-back both live in the **host**:
the host collects the comment text and calls its own `MarkerAdapter.add(uri, line, text, author)`.
**The package never calls `MarkerAdapter.add` itself.** After the host writes, the canvas
refreshes **automatically**: when `FileAdapter.watch` fires with new content, the component
re-renders **and re-calls `MarkerAdapter.list(uri)`** to pick up the new marker — the host does
not re-trigger the list itself (iter-2 Claude). A host **without** a file watcher triggers the
same refresh by passing a **new `refreshKey`** value (a number or string) to the component:
when its underlying data changes, the host bumps `refreshKey`, which re-runs the read +
marker-list. (A plain same-props re-render does *not* re-fetch — that is correct React; the
`refreshKey` prop lets a no-watcher host drive refresh without remounting or subclassing.)

**Rationale:** input affordances differ per surface (VSCode `InputBox`, a dashboard modal, a
mobile sheet) and so does write-back; forcing either into the package would couple it to a
surface and contradict D3 (serialization-agnostic). The package owns the *intent* and the
*round-trip refresh*; the host owns *input* and *write*.

This is the single authoritative model. The Acceptance Criteria and Test Scenario 3 below are
written to match it: the package is asserted to *emit the intent event*, and a host-side test
harness performs the `add` + refresh.

### D7 — Rendered HTML is sanitized (no script execution)
Markdown artifacts are rendered into a live DOM inside a VSCode webview and the browser
dashboard, and artifacts can carry PR-sourced or otherwise untrusted prose. The renderer
therefore (a) runs markdown-it with `html: false` (raw inline/block HTML is **not** passed
through), and (b) sanitizes the generated HTML with **DOMPurify** before it reaches the DOM
(React injection or otherwise) — defense in depth, so a future relaxation of `html` cannot
silently open an XSS hole. `dompurify` is a declared package dependency. REVIEW HTML-comment
markers remain non-executable metadata: they are consumed by `MarkerAdapter`/the renderer and
surfaced as overlay UI, never emitted as executable content. See **Security Considerations**
for the precedent (Codev #0048) and the required test. **Rationale:** rendering untrusted
markdown into a privileged webview without sanitization is a classic XSS vector; both Gemini
and Codex flagged its absence as blocking at iter-1.

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

/** Reads and mutates review markers. Serialization is the implementation's concern (D3).
 *  In v1 the package calls only `list`; `add` is invoked by host glue code (D6). */
interface MarkerAdapter {
  list(uri: string): Promise<ReviewMarker[]>;
  add(uri: string, line: number, text: string, author: string): Promise<void>; // host-invoked (D6)
  // Reserved for later issues (declared as optional so hosts may implement incrementally):
  // addRegion?(uri: string, lineStart: number, lineEnd: number, text: string, author: string): Promise<void>;
  // setCheckbox?(uri: string, line: number, checked: boolean): Promise<void>; // AC-progress (#862)
}

/** JS-side theme access for canvas-drawing consumers (D4, Model A); NOT used by v1 render. */
interface ThemeAdapter {
  resolve(token: string): string;             // full custom-property name, e.g. resolve("--codev-canvas-foreground")
  onChange(handler: () => void): Disposable;  // sync register; fires on host theme switch
}

/** In-memory marker model. `raw` preserves the on-disk text for lossless round-tripping. */
interface ReviewMarker {
  author: string;
  line: number;                                  // 0-based, matches `data-line` (D5)
  text: string;
  raw: string;
  lineRange?: { start: number; end: number };  // reserved for region anchors (not used in v1)
}

/** Public props of the React canvas component — the host-facing contract. `onAddComment`
 *  is the single canonical comment-intent seam (D6): the overlay calls it with a 0-based
 *  line; the host does the text input and calls MarkerAdapter.add. */
interface ArtifactCanvasProps {
  uri: string;
  fileAdapter: FileAdapter;
  markerAdapter: MarkerAdapter;
  themeAdapter: ThemeAdapter;
  onAddComment(line: number): void;            // comment-intent event (D6); line is 0-based (D5)
  onError?(err: unknown): void;                // optional host error sink (D2)
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

## Security Considerations

The package renders markdown into a **privileged DOM** — a VSCode webview and the browser
dashboard — and the markdown it renders is not always trusted (artifacts can include
PR-authored prose, pasted content, or text from contributors outside the core team). Rendering
untrusted markdown into such a surface without sanitization is a classic XSS vector.

**Locked requirement (D7):**
1. **markdown-it `html: false`.** Raw inline and block HTML in the source is not passed
   through to the output.
2. **DOMPurify sanitization.** The HTML markdown-it produces is run through **DOMPurify**
   before it reaches the DOM. This is defense-in-depth: even if a later feature relaxes the
   `html` option or injects HTML through another path, the sanitize step still strips
   executable content. `dompurify` is a declared dependency of the package.
3. **REVIEW markers stay metadata.** REVIEW HTML-comment markers are parsed/consumed by the
   `MarkerAdapter` and renderer and surfaced as overlay UI; they are never emitted as
   executable HTML.

**Precedent.** Codev already treats sanitized markdown rendering as the norm: `codev/specs/
0048-markdown-preview.md` established a markdown-preview surface, and DOMPurify is already
bundled as a vendored client library (served via `tower-routes.ts`). D7 keeps this new package
consistent with that precedent rather than introducing an unsanitized renderer.

**Required test (see Test Scenario 8).** A sample artifact that attempts to embed executable
content (e.g. `<img src=x onerror=...>`, `<script>...</script>`, a `javascript:` URL) renders
with that content neutralized — no script executes and no event-handler attribute survives.

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
      `@cluesmith/codev-artifact-canvas`, peer-deps on `react`/`react-dom`, deps on
      `markdown-it` and `dompurify`.
- [ ] Renderer produces HTML with `data-line` attributes on block tokens (paragraphs,
      headings, list items, code blocks, blockquotes, tables); a unit test covers the
      attribution.
- [ ] A comment-overlay component renders a hover-`+` on rendered blocks; clicking invokes the
      **`onAddComment(line: number)`** prop (the canonical intent seam, `ArtifactCanvasProps`);
      the package does **not** call `MarkerAdapter.add` (text-input + write-back are host-owned,
      D6). A unit test asserts the intent-prop contract.
- [ ] The hover-`+` affordance is **keyboard-accessible** — reachable via keyboard focus and
      activatable with Enter/Space (not hover-only), with an accessible label for screen
      readers; a test covers keyboard activation. (iter-2 Claude)
- [ ] The public API exports the three adapter interfaces (`FileAdapter`, `MarkerAdapter`,
      `ThemeAdapter`), the data types `ReviewMarker` and `Disposable`, and the component props
      `ArtifactCanvasProps`; the package has zero direct filesystem, `fetch`, or VSCode-API
      imports (import-boundary test).
- [ ] Theming via CSS custom properties; the package ships a default stylesheet defining a
      fallback for **each v1 `--codev-canvas-*` token (D4)**; hosts override by setting the
      variables; documented host override examples. `ThemeAdapter.resolve()` is JS-side only
      (D4, Model A) and is not on the v1 render path.
- [ ] A smoke-test host demonstrates end-to-end: load sample markdown → render → hover →
      click `+` → adapter receives the call → marker round-trips.
- [ ] Build produces a **CJS + ESM** bundle (with type declarations) consumable by both a
      VSCode webview and the dashboard's Vite/ESM pipeline.
- [ ] **Text-as-source-of-truth invariant test**: no affordance produces output that isn't
      either a source-markdown text mutation or a clearly delimited adjacent text artifact.
      (For v1 concretely: the comment overlay's only output channel is the `onAddComment`
      intent event — no side-channel writes.)
- [ ] **HTML-sanitization (D7)**: markdown-it runs with `html: false` and output is
      DOMPurify-sanitized before render; rendered HTML contains **no executable script
      content** even when the input markdown attempts to embed it (`<script>`, `onerror=`,
      `javascript:` URLs). A test covers this.
- [ ] `README.md` documents the three adapter contracts + a host-implementation example.

Non-functional (MUST):
- [ ] **No regression** to the existing VSCode editor-side review flow (#857 untouched).
- [ ] Package source contains no `vscode`, `node:*`, or direct `fs`/`fetch` imports.
- [ ] New code carries unit tests; no reduction in monorepo test health (the new package's
      `test` script runs green and is wired into the build graph).

### Test Scenarios
**Functional**
1. Render a sample artifact; assert each block element carries the correct `data-line`.
2. Hover a block → `+` appears; click → the `onAddComment` intent event fires with the
   expected `{ line }`.
3. A stub `MarkerAdapter.list` returns markers → they render. Simulating a `+` click emits
   the intent event with the expected `{ line }`; a host-side test harness then calls
   `MarkerAdapter.add(uri, line, text, author)` and, on the subsequent refresh (a `watch`
   callback or a re-`list`), the new marker renders. The package itself never calls `add`.
4. `ThemeAdapter` contract (D4 Model A): a unit test asserts `resolve(token)` returns the host
   value and `onChange` fires on a simulated theme switch — these serve #863's `<canvas>`, not
   v1 render (v1 visual theming is via CSS variables and needs no re-render).

**Non-functional**
5. Import-boundary test: scanning package source finds no forbidden imports.
6. Invariant test: assert the comment overlay's only output channel is the `onAddComment`
   intent event — no side-channel writes (generalizes to future affordances).
7. Build smoke: the CJS entry `require()`s and the ESM entry `import()`s without error.
8. **Sanitization (D7):** render an artifact containing `<script>`, an `onerror=` attribute,
   and a `javascript:` URL; assert none execute and the dangerous attributes/elements are
   stripped from the rendered DOM.
9. **Subscription teardown:** after `dispose()` on a `FileAdapter.watch` / `ThemeAdapter.onChange`
   subscription, further host notifications do not trigger re-render (no leak); `dispose()`
   called twice is a safe no-op.

## Dependencies
- **Blocks**: #859 (on HOLD) — released to re-plan against this once it ships.
- **Blocked by**: nothing.
- **Coordinates with**: `@cluesmith/codev-types` and `@cluesmith/codev-core` conventions for
  monorepo package shape (naming, version alignment, `exports` style).
- **Libraries**: `markdown-it` + `dompurify` (deps); `react`/`react-dom` (peer); a
  dual-bundle build tool (plan-decided); Vitest + Testing Library (test, matching the
  dashboard).

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
| Unsanitized HTML in an artifact executes in the webview/dashboard (XSS) | Low | High | D7: markdown-it `html: false` + DOMPurify sanitize before render; sanitization AC + Test Scenario 8; follows #0048 precedent. |

## Consultation Log

### Iteration 1 — Specify (2026-05-31)
**Models:** Gemini (gemini-3.1-pro-preview), Codex (gpt-5.4-codex), Claude (claude-opus).
**Verdicts (per the on-disk verdict files):**
- **Gemini — REQUEST_CHANGES (confidence HIGH).** Blocker: missing XSS/DOMPurify
  sanitization invariant. Other comments: D2-vs-D4 ThemeAdapter/CSS overlap; suggested a
  generic `FileAdapter.write` for future checkbox mutations; confirmed the #857 marker-format
  catch is correct.
- **Codex — REQUEST_CHANGES (confidence HIGH).** Blockers: (1) D6 (intent-only) contradicts
  the Acceptance Criteria + Test Scenario 3 (which implied the package calls
  `MarkerAdapter.add`); (2) no explicit markdown HTML-sanitization requirement. Also:
  underspecified adapter error states.
- **Claude — APPROVE (confidence HIGH).** No blockers; minor notes (line-base, error policy,
  sanitization stance, blockquotes/tables in AC, Disposable teardown test).

**Net: 2-of-3 REQUEST_CHANGES.** Two real blockers, both addressed in this revision.

Changes made to clear the blockers:
- **XSS sanitization (Gemini + Codex blocker)** → added **D7** + a **Security Considerations**
  section: markdown-it `html: false` + DOMPurify sanitize before render; `dompurify` added to
  declared deps; new AC + Test Scenario 8; references the #0048 precedent.
- **D6 vs AC/Scenario-3 contradiction (Codex blocker)** → D6 reworded as the single
  authoritative *intent-only* model (overlay emits `onAddComment(line)`; the **host** calls
  `MarkerAdapter.add`; the package never calls `add`). Fixed the contradicting line in D3,
  the AC comment-overlay item, and Test Scenario 3; annotated the `MarkerAdapter` interface.

Non-blocking refinements also folded in:
- **Adapter error semantics** (all three) → D2: package guards the calls it makes; `add`
  errors are host-side; optional `onError`; no built-in retry.
- **`data-line` / `ReviewMarker.line` base** (all three) → D5 + interface state **0-based**.
- **Subscription lifecycle / idempotent Disposable** (Gemini, Claude) → D2 + interface;
  Test Scenario 9 covers teardown.
- **Change coalescing** (Codex, Claude) → D2: host's responsibility.
- **Packaging hygiene** (Codex, Claude) → `examples/` excluded from published output.
- **React 18 floor** (Claude) → package source avoids React-19-only APIs.
- **AC element list** (Claude) → blockquotes + tables added to match D5.

Deferred (reviewer-agreed): Open Q §3 (build tool) and §4 (default-theme import path) stay
plan-level. Gemini's `FileAdapter.write` idea is noted for the #862 follow-up, not added to
the v1 contract. Open Q §1 (REVIEW marker format) — the architect confirmed #857 is positional;
the D3 resolution stands.

### Iteration 2 — Specify re-consult (2026-06-09)
Re-ran the 3-way consult on the iter-1-revised spec. **Verdicts (per the verdict files):**
- **Gemini — SKIPPED (COMMENT, LOW):** the `agy` lane produced no output (CLI not
  installed/signed-in); not an actual review.
- **Codex — REQUEST_CHANGES (HIGH):** three contract issues — (1) `FileAdapter.watch`
  async/sync contradiction between D2 prose and the interface; (2) the comment-intent seam not
  formally locked (event-vs-`onAddComment` drift; no typed component-props interface);
  (3) `ThemeAdapter.resolve` underspecified vs D4's CSS-variable theming.
- **Claude — APPROVE (HIGH):** no blockers; notes on the same ThemeAdapter/CSS overlap, the
  refresh-flow ambiguity, accessibility, and minor edge cases.

**Net: not clean (1 APPROVE, 1 REQUEST_CHANGES, 1 skipped lane)** — did not meet the
"≥2 APPROVE, zero REQUEST_CHANGES" bar. Proceeded to iter-3.

### Iteration 3 — Specify revision (2026-06-09)
Addressed Codex's three issues + Claude's cheap convergent notes:
- **`FileAdapter.watch` async/sync:** D2 reworded — `read` + `MarkerAdapter` methods are async;
  `watch`/`onChange` are synchronous, returning a `Disposable` immediately (callbacks fire
  async). The interface signatures are the source of truth.
- **Comment-intent seam locked:** added `ArtifactCanvasProps` to the interface block with the
  canonical `onAddComment(line: number): void` prop (+ adapters, `uri`, optional `onError`);
  D6, the AC, and Test Scenario 2/3 now all reference it. Exported from the public API.
- **ThemeAdapter/CSS resolved (Model A):** D4 now locks CSS variables as the sole v1 theming
  mechanism, enumerates the v1 `--codev-canvas-*` token vocabulary, and scopes `resolve()`/
  `onChange` to JS-side consumers (#863's `<canvas>`), off the v1 render path. Test Scenario 4
  reframed accordingly.
- **Refresh flow (Claude):** D6 now states the component auto-re-calls `MarkerAdapter.list`
  when `watch` fires — hosts don't re-trigger it.
- **Accessibility (Claude):** new AC — the hover-`+` is keyboard-reachable/activatable
  (Enter/Space) with a screen-reader label; test covers it.

Deferred to plan (reviewer-agreed): out-of-range-marker policy, React-18 CI matrix, dual-format
build-tool choice. **Gemini lane:** dead (`agy` unavailable) — pending a decision on whether to
restore it or proceed with Codex + Claude as the panel. To be re-consulted (iter-4).

## Notes
This spec deliberately includes the adapter interface signatures verbatim because, for this
feature, the interfaces *are* the specification (the WHAT) — not implementation detail. The
HOW (build tooling, file layout, test wiring, the smoke-test harness internals) is left to
the plan.
