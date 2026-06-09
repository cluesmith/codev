# Plan: Foundational reusable package `@cluesmith/codev-artifact-canvas`

## Metadata
- **ID**: plan-2026-06-09-945-build-foundational-reusable-pa
- **Status**: draft
- **Specification**: [codev/specs/945-build-foundational-reusable-pa.md](../specs/945-build-foundational-reusable-pa.md)
- **GitHub Issue**: [#945](https://github.com/cluesmith/codev/issues/945)
- **Created**: 2026-06-09

## Executive Summary

Build the shared library `@cluesmith/codev-artifact-canvas` (Approach A in the spec: one
React package + per-host adapter seams). The work splits into four committable phases:
(1) package skeleton + dual-format build + locked interfaces + theme tokens; (2) the
markdown renderer with `data-line` mapping + D7 sanitization; (3) the comment overlay
(intent-only) + v1 marker rendering + adapter wire-up + auto-refresh; (4) the smoke-test
host + README + cross-cutting tests. No host integration ships here (that's #859 / the
dashboard route / mobile).

This plan also **resolves the five items deferred from the spec consult** (the plan-gate
acceptance criteria) — see the **Deferred-Item Resolutions** section, which maps each to the
phase that closes it.

## Locked plan-level decisions (closing spec Open Questions §3/§4)

- **Build tool = `tsup`** (closes spec Open Q §3). It emits CJS + ESM + `.d.ts` from one
  config with minimal setup, handles TSX, and can bundle/copy the stylesheet. Vite library
  mode and raw esbuild were the alternatives; tsup is the lightest path to the spec's required
  dual-format output. The build-smoke test (a CJS `require()` + an ESM `import()`) guards it.
- **`default-theme.css` ships as a separate export path** (closes spec Open Q §4):
  `@cluesmith/codev-artifact-canvas/default-theme.css`. Explicit, host-overridable, not
  auto-injected — hosts opt in via `<link>`/import and override the `--codev-canvas-*` vars.

## Success Metrics
- [ ] All spec acceptance criteria met (functional + non-functional).
- [ ] All 5 deferred items resolved or consciously decided (see Deferred-Item Resolutions).
- [ ] Package source has zero `vscode` / `node:*` / direct `fs`/`fetch` imports (import-boundary test green).
- [ ] Dual CJS+ESM bundle + `.d.ts` builds; build-smoke test green.
- [ ] New package `test` script green and wired into the monorepo build graph.
- [ ] No regression to #857 (editor-side review flow untouched).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Package skeleton, dual-format build, locked interfaces, theme tokens"},
    {"id": "phase_2", "title": "Markdown renderer: data-line mapping + DOMPurify sanitization"},
    {"id": "phase_3", "title": "Comment overlay (intent-only) + v1 marker rendering + adapter wire-up"},
    {"id": "phase_4", "title": "Smoke-test host, README, cross-cutting tests"}
  ]
}
```

## Deferred-Item Resolutions (plan-gate acceptance criteria)

| # | Source | Item | Resolution | Phase |
|---|---|---|---|---|
| 1 | Codex | D2 "injectable logger" claim has no matching prop | **Drop the injectability claim.** Internal diagnostics go to `console`; the host-facing hook is the existing `onError?(err)` prop in `ArtifactCanvasProps`. No logger prop added. Spec D2 text adjusted accordingly during this phase's doc pass. | P1 (contract) |
| 2 | Codex | `ThemeAdapter.resolve` token format ambiguous | **Pin to the full custom-property name** — `resolve("--codev-canvas-foreground")`, 1:1 with the D4 vocabulary, no hidden bare-name mapping. Documented on the interface + README. | P1 (contract) |
| 3 | Codex | Sanitization test doesn't exercise DOMPurify (`html:false` neutralizes `<script>` first) | **Retarget the test** at a vector that survives `html:false` but is caught by DOMPurify: a markdown link `[x](javascript:alert(1))` (markdown-it emits an `<a href="javascript:…">`; the sanitize step strips the scheme). Assert the `javascript:` href is neutralized; keep `<script>`/`onerror` cases as secondary. | P2 (renderer/security) |
| 4 | Claude | v1 marker-render fidelity vs #863 | **Deliberate decision:** v1 renders a *minimal* marker presence — a line-level highlight/affordance on lines carrying a `ReviewMarker`, with author + text shown via the overlay (hover/expand). v1 does **not** ship polished inline marker bubbles or the `<canvas>` minimap — those are #863. `MarkerAdapter.list` provides the positioning data; v1 turns it into a minimal indicator only. | P3 (marker rendering) |
| 5 | Claude | `review-decorations.ts` path wrong in spec prose | **Correct path is `packages/vscode/src/review-decorations.ts`** (not under `comments/`). Apply the one-line fix to the spec's Current State during the Review phase doc pass. | P3 doc note / Review |

## Phase Breakdown

### Phase 1: Package skeleton, dual-format build, locked interfaces, theme tokens
**Dependencies**: None

#### Objectives
- Stand up `packages/artifact-canvas/` as a buildable, testable workspace member with the
  dual-format output and the **locked public contract** (interfaces + types + props), so every
  later phase and every downstream host builds against a stable surface.

#### Deliverables
- [ ] `packages/artifact-canvas/package.json` — name `@cluesmith/codev-artifact-canvas`,
      version aligned to the monorepo, `peerDependencies` `react`/`react-dom` (`^18 || ^19`),
      `dependencies` `markdown-it` + `dompurify`, `devDependencies` for tsup + Vitest +
      Testing Library; `exports` for the main entry and `./default-theme.css`; `files`
      excluding `examples/`.
- [ ] `tsup.config.ts` — CJS + ESM + `.d.ts`; externalize React; copy/emit the stylesheet.
- [ ] Dev type deps: `@types/markdown-it` + `@types/dompurify` (this is a `.d.ts`-emitting TS
      project) + `vite` (for the `examples/` dev page in P4) — iter-2 Claude.
- [ ] `tsconfig.json` extending `../config/tsconfig.base.json` (the repo base, as core/types do),
      adding `jsx` + DOM libs, and **overriding `module`/`moduleResolution` to `ESNext`/`bundler`**
      (the base is `NodeNext`; tsup owns module output — matches the dashboard's pattern, iter-3
      Claude); `vitest.config.ts`.
- [ ] `src/adapters/{FileAdapter,MarkerAdapter,ThemeAdapter}.ts` — **interfaces only**.
- [ ] `src/types.ts` — `ReviewMarker`, `Disposable`, `ArtifactCanvasProps` (incl.
      `onAddComment(line: number): void`, optional `onError?(err: unknown): void`).
- [ ] `src/styles/default-theme.css` — the 8 v1 `--codev-canvas-*` tokens with fallbacks.
- [ ] `src/index.ts` — public API exports (component placeholder, all interfaces/types).
- [ ] **Repo build/test/release wiring (iter-1 Codex):** the package is auto-discovered by
      `pnpm-workspace.yaml` (`packages/*`), but the repo's flows must be updated explicitly:
  - [ ] **root `package.json` `build`** — the actual script is
        `scripts/check-main-fresh.sh && pnpm --filter @cluesmith/codev-types build && pnpm --filter @cluesmith/codev-core build && pnpm --filter @cluesmith/codev build`
        (iter-2 Claude — accurate form). Insert the `@cluesmith/codev-artifact-canvas` build
        **after** `codev-core` and **before** `@cluesmith/codev`.
  - [ ] **root `package.json` `test` — do NOT extend it.** Today it runs only
        `@cluesmith/codev` (the dashboard isn't aggregated either) and CI does not use it. The
        package gets its **own** `test` script (Vitest) and is run in CI via the next bullet —
        matching the repo's per-package convention. (iter-3 Codex/Claude — removes the iter-3
        self-contradiction between this deliverable and the acceptance criterion.)
  - [ ] **`.github/workflows/test.yml`** — add a dedicated artifact-canvas build+test step in the
        `unit` job alongside the existing per-package steps. Placement: it has **no** core/types
        dependency, so the step can run right after `pnpm install` (no need to wait for the
        core/types builds). (iter-3 Codex/Claude; placement note iter-4 Claude.)
  - [ ] **`scripts/bump-all.sh`** — add `@cluesmith/codev-artifact-canvas` at the monorepo
        version (`3.1.x`, like the published packages — NOT the dashboard's private `0.0.0`).
  - [ ] **`codev/protocols/release/protocol.md`** — the release process still enumerates only
        codev/core/types (+ vscode) for version bump/publish. Add the new package to its
        version-bump enumeration. **Publish decision:** in v1 the package is consumed by hosts via
        `workspace:*` and bundled by them, so it is **not independently npm-published in v1**; add
        it to the publish list only when a consumer needs it standalone. (Note: unlike
        `@cluesmith/codev-core`, it is *not* even packed for `local-install.sh` — the parallel is
        only "workspace-consumed, not independently published", iter-4 Claude.) State this finding
        explicitly in the release doc. (iter-3 Codex.)
  - [ ] Confirm `local-install.sh` needs no change (package not consumed by a host or published
        standalone yet) — note the finding either way.
- [ ] `vitest.config.ts` uses a **DOM environment** (jsdom/happy-dom) so the renderer,
      sanitization, and overlay tests (which touch the DOM/DOMPurify) run (iter-1 Claude).
- [ ] Tests: import-boundary (no `vscode`/`node:*`/`fs`/`fetch`); build-smoke (CJS `require` +
      ESM `import`). *(Optional, iter-1 Claude:* a React-18 install-and-import smoke to guard
      the `^18` peer floor.*)*

#### Implementation Details
- **Deferred #1 (logger):** define the error contract here — `onError?` on `ArtifactCanvasProps`
  is the only host-facing error hook; internal logs go to `console`. Update spec D2 prose to
  drop "injectable logger."
- **Deferred #2 (token format):** `ThemeAdapter.resolve(token)` takes the full
  `--codev-canvas-*` property name; document on the interface + README.
- Token vocabulary matches spec D4 exactly (foreground, background, accent, border, muted,
  code-background, link, comment-marker).

#### Acceptance Criteria
- [ ] `pnpm --filter @cluesmith/codev-artifact-canvas build` produces `dist/` with CJS, ESM, `.d.ts`, and the stylesheet.
- [ ] Import-boundary + build-smoke tests pass.
- [ ] Public API exports the three interfaces + `ReviewMarker` + `Disposable` + `ArtifactCanvasProps`.
- [ ] The root `build` script includes the new package; the package has its own `test` script
      run via a dedicated `.github/workflows/test.yml` step (root `test` is **not** extended);
      `scripts/bump-all.sh` and the release protocol list it. *(Closes iter-1 Codex #1 + the
      iter-3 wiring items; no internal contradiction.)*

#### Test Plan
- **Unit**: import-boundary scan; type-export presence.
- **Integration**: build-smoke (`require()` the CJS entry; `import()` the ESM entry).

#### Rollback Strategy
Delete `packages/artifact-canvas/`; no other package depends on it yet.

#### Risks
- **Risk**: dual CJS+ESM is the repo's first such build. **Mitigation**: tsup + build-smoke test (spec Risk #2).

---

### Phase 2: Markdown renderer — `data-line` mapping + DOMPurify sanitization
**Dependencies**: Phase 1

#### Objectives
- Render markdown to **sanitized** HTML carrying `data-line` source positions on block tokens.

#### Deliverables
- [ ] `src/renderer/` — markdown-it instance (`html: false`) + a `data-line` rule stamping
      0-based `token.map[0]` on paragraphs, headings, list items, code blocks, blockquotes, tables.
- [ ] DOMPurify sanitize pass over the generated HTML before it reaches the DOM (D7).
- [ ] A React renderer component that mounts the sanitized HTML.
- [ ] Tests: `data-line` attribution (scenario 1); **sanitization (deferred #3)** —
      `[x](javascript:alert(1))` href neutralized (proves DOMPurify runs), plus `<script>` /
      `onerror=` secondary cases; assert no executable content survives.

#### Implementation Details
- **Deferred #3:** the primary sanitization assertion targets the markdown-generated
  `javascript:` link, which `html:false` does **not** strip — so the test fails if the DOMPurify
  step is removed. (A regression guard for the sanitize step itself.)

#### Acceptance Criteria
- [ ] Every block element carries the correct 0-based `data-line`.
- [ ] Sanitization test green, including the `javascript:`-link vector.

#### Test Plan
- **Unit**: data-line attribution across block types; sanitization vectors.

#### Rollback Strategy
Revert the renderer module; Phase 1 surface remains intact.

#### Risks
- **Risk**: a sanitize config that also strips legitimate content. **Mitigation**: test allowed markup renders intact alongside the attack vectors.

---

### Phase 3: Comment overlay (intent-only) + v1 marker rendering + adapter wire-up
**Dependencies**: Phase 2

#### Objectives
- Compose the full `ArtifactCanvas` component: render + hover-`+` intent overlay + minimal
  marker display + adapter-driven data flow + auto-refresh.

#### Deliverables
- [ ] `src/overlays/` — hover-`+` affordance → invokes `onAddComment(line)` (0-based). The
      package never calls `MarkerAdapter.add` (D6). **Keyboard-accessible**: focusable,
      Enter/Space activation, ARIA label.
- [ ] `src/components/ArtifactCanvas.tsx` — wires `FileAdapter` (read + watch) and
      `MarkerAdapter` (list). It **subscribes only to `FileAdapter.watch`** (via `useEffect`,
      idempotent `dispose()`) and auto re-calls `MarkerAdapter.list` when `watch` fires (D6).
      Errors → `console` + `onError?`.
- [ ] **ThemeAdapter stays off the v1 render path (iter-2 Codex; spec D4 Model A).**
      `themeAdapter` is accepted as a prop, but the v1 component **does NOT** subscribe to its
      `onChange` nor call `resolve()` for rendering — theming is entirely CSS-variable-driven.
      `resolve()`/`onChange` exist for #863's JS-side canvas and are exercised **only** by the
      standalone contract test (scenario 4), never by `ArtifactCanvas`. (Explicitly: do not add
      theme-driven re-render to v1.)
- [ ] **v1 marker rendering (deferred #4):** minimal line-level indicator for lines bearing a
      `ReviewMarker`, author + text via the overlay; no inline bubbles / minimap (those = #863).
- [ ] **Adapter error semantics (spec D2 — locked; iter-4 Codex):** the component guards every
      adapter call it makes (`FileAdapter.read`/`.watch`, `MarkerAdapter.list`,
      `ThemeAdapter.resolve`/`.onChange`): a rejection/throw is caught, logged to `console`, and
      surfaced via the optional `onError?` prop; the component never throws out of an event
      handler. A failed `MarkerAdapter.list()` **leaves the prior rendered markers in place** (no
      clear/corrupt). (`MarkerAdapter.add` is host-invoked, so its errors are host-side.)
- [ ] **Out-of-range-marker policy (spec deferred → resolved here; iter-4 Codex):** a
      `ReviewMarker` whose `line` is ≥ the document's current line count (e.g. a stale marker
      after truncation) is **ignored** (not rendered, not mis-anchored) and reported once via
      `onError?`/`console.warn`. Chosen over *clamp* (would mis-anchor) and *hard-error* (a stale
      marker shouldn't break the view); #863 may add smarter re-anchoring later.
- [ ] Tests: overlay intent (scenario 2), marker round-trip (scenario 3), ThemeAdapter
      contract (scenario 4), invariant (scenario 6 — asserts the overlay's *only* output channel
      is the `onAddComment` intent event; no side-channel writes), subscription teardown
      (scenario 9), keyboard activation, **adapter-error handling** (`read`/`list`/`watch` reject
      → `onError` fired + prior markers preserved), and **out-of-range marker** (dropped + warned).

#### Implementation Details
- **Deferred #5:** while touching Current State references, correct the spec's
  `review-decorations.ts` path to `packages/vscode/src/review-decorations.ts`.

#### Acceptance Criteria
- [ ] Clicking `+` (mouse or keyboard) invokes `onAddComment` with the expected 0-based line; package never calls `add`.
- [ ] Existing markers render (minimal v1 fidelity); host-side `add` + `watch` re-list refreshes them.
- [ ] Disposing a subscription stops further re-renders; `dispose()` twice is a no-op.
- [ ] A rejecting `read`/`list`/`watch`/`resolve`/`onChange` is caught → `onError` fired + logged; the component does not throw; a failed `list()` preserves prior markers (spec D2).
- [ ] An out-of-range `ReviewMarker` (`line` ≥ document line count) is dropped (not rendered) and warned once.

#### Test Plan
- **Unit**: overlay intent + keyboard; marker render; teardown.
- **Integration**: stub-adapter round-trip (list → render → intent → host add → watch → re-list → render).

#### Rollback Strategy
Revert overlay/component modules; renderer (P2) and skeleton (P1) remain usable.

#### Risks
- **Risk**: marker-fidelity scope creep toward #863. **Mitigation**: deferred-#4 boundary is explicit; review against it.

---

### Phase 4: Smoke-test host, README, cross-cutting tests
**Dependencies**: Phase 3

#### Objectives
- Prove the package end-to-end against a realistic (stub-adapter) host and document the contract.

#### Deliverables
- [ ] **Automated end-to-end test (iter-1 Codex #2)** at
      `src/__tests__/end-to-end.test.tsx` — the primary contract proof. Using Vitest +
      Testing Library (jsdom) it: mounts `<ArtifactCanvas>` with in-test stub adapters
      (`stubFileAdapter`, `stubMarkerAdapter`, `stubThemeAdapter` from
      `src/__tests__/fixtures/`) and a sample markdown fixture; asserts render; simulates
      hover + click (and keyboard Enter) on the `+` → asserts `onAddComment(line)` fired with
      the expected 0-based line; the test's stub `MarkerAdapter.add` **serializes a positional
      `<!-- REVIEW(@author): text -->` into the markdown fixture *string*** (the
      text-as-source-of-truth form, D3/#857), the stub `FileAdapter.watch` emits that updated
      **text**, and `read`/`list` **derive their state from the updated text — not an in-memory
      side store** → asserts the new marker renders. This proves the round-trip goes *through
      text* (satisfying the text-as-source-of-truth invariant), not merely UI refresh (iter-2 Codex).
- [ ] `examples/` — a Vite dev **page** (developer aid, not the proof) reusing the same stub
      adapters + sample artifact for hands-on/visual exercise. Concrete entrypoint:
      `examples/index.html` + `examples/main.tsx` + `examples/vite.config.ts`, launched by a
      package script `"dev:example": "vite examples"` (the `vite` devDep declared in P1).
      Excluded from the published package (`files`/`exports`). (iter-4 Codex/Claude.)
- [ ] `README.md` — the three adapter contracts, `ArtifactCanvasProps`, the `--codev-canvas-*`
      tokens + override example, a host-implementation walkthrough, and a short note on **why
      `tsup`** was chosen (so maintainers don't "normalize" it away — iter-1 Claude).

#### Acceptance Criteria
- [ ] The automated `end-to-end.test.tsx` round-trip passes (render → intent → host add →
      watch/re-list → marker renders), via mouse and keyboard.
- [ ] `examples/` Vite page runs and exercises the same flow by hand.
- [ ] README documents adapters + a host example + the tsup rationale.
- [ ] Full package `test` script green.

#### Test Plan
- **Integration (automated, primary)**: `src/__tests__/end-to-end.test.tsx` — full round-trip
  with stub adapters + fixtures at known paths (above).
- **Manual (dev aid)**: run the `examples/` Vite harness; exercise hover/click/keyboard.

#### Rollback Strategy
`examples/` and README are additive; removing them doesn't affect the published package.

#### Risks
- **Risk**: smoke host accidentally shipped. **Mitigation**: `files`/`exports` exclude `examples/` (verified in P1; re-checked here).

## Dependency Map
```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
(skeleton)   (renderer)   (overlay+markers)   (smoke host + docs)
```

## Risk Analysis
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Adapter contract wrong → 6+ dependents rework | Low (locked + consulted) | High | Contract validated by the smoke-test host before merge; future methods optional |
| First dual-format build is fiddly | Med | Med | tsup + build-smoke test (P1) |
| Sanitize step silently ineffective | Low | High | Deferred-#3 test targets a vector only DOMPurify catches |
| Marker scope creep into #863 | Med | Med | Deferred-#4 boundary explicit; reviewed against it |
| React peer-version skew (18 vs 19) | Low | Med | Peer range `^18 || ^19`; avoid React-19-only APIs; (optional) React-18 CI smoke |
| DOMPurify/renderer tests need a DOM | Low | Low | `vitest.config.ts` uses a jsdom/happy-dom environment (P1) |

## Consultation Log

### Plan iteration 1 (2026-06-09)
**Verdicts (per the verdict files):** Gemini SKIPPED (agy lane unavailable); **Codex
REQUEST_CHANGES (HIGH)**; **Claude APPROVE (HIGH)**. Not a clean 2/3.

Codex's two blockers, both addressed in iteration 2:
1. **Repo build/test/release wiring not named** — Phase 1 now explicitly updates root
   `package.json` (build + test) and `scripts/bump-all.sh`, and notes the `local-install.sh`
   finding, with a matching acceptance criterion. (The package would otherwise be an orphan
   despite the "version aligned / build-graph integration" claim.)
2. **Phase 4 end-to-end proof too vague** — locked an *automated* round-trip test at
   `src/__tests__/end-to-end.test.tsx` (Vitest + Testing Library + stub-adapter fixtures) as
   the primary contract proof; the `examples/` Vite page is now explicitly a dev aid, not the proof.

Claude APPROVE'd; folded its non-blocking notes: jsdom test environment (P1 + risk table),
tsup-rationale note in the README (P4), optional React-18 smoke (P1), and the P3-density /
P3a-P3b split called out as a builder escape hatch.

### Plan iteration 2 (2026-06-09)
**Verdicts:** Gemini SKIPPED (agy); **Codex REQUEST_CHANGES (HIGH)**; **Claude APPROVE (HIGH)**.
Not a clean 2/3. Codex's two spec-contract issues, both addressed in iteration 3:
1. **ThemeAdapter still on the render path** — P3 reworded: the v1 component accepts
   `themeAdapter` as a prop but does NOT subscribe to `onChange` or call `resolve()` for
   rendering (theming is CSS-variable-driven, D4 Model A); only `FileAdapter.watch` is
   subscribed; `resolve()`/`onChange` are exercised solely by the scenario-4 contract test.
2. **e2e proof didn't guarantee round-trip *through text*** — P4 e2e test now requires the stub
   `MarkerAdapter.add` to serialize a positional `<!-- REVIEW(...) -->` into the markdown fixture
   string, with `read`/`watch`/`list` deriving state from that updated text (not an in-memory store).

Claude APPROVE'd; folded its accuracy nits: accurate root `build` script form + insertion point;
root `test` convention clarified (per-package + CI, not a convention-breaking root extension);
`@types/markdown-it`/`@types/dompurify` + `vite` devDeps; tsconfig base = `../config/tsconfig.base.json`;
scenario-6 invariant assertion echoed in P3.

### Plan iteration 3 (2026-06-09)
**Verdicts:** Gemini SKIPPED (agy); **Codex REQUEST_CHANGES (HIGH)**; **Claude APPROVE (HIGH)**.
Not a clean 2/3. Codex's three (all wiring; the first a contradiction introduced in iter-2/3),
addressed in iteration 4:
1. **P1 test-wiring self-contradiction** — deliverable said "don't extend root `test`" while the
   AC said "root build *and test* include the package." Resolved decisively: root `build`
   includes it; root `test` is **not** extended; the package's own `test` runs in CI. AC reworded
   to match.
2. **Release wiring incomplete** — added a deliverable to update `codev/protocols/release/protocol.md`
   (version-bump enumeration) + an explicit publish decision: not independently npm-published in
   v1 (consumed via `workspace:*` + bundled by hosts, mirroring `@cluesmith/codev-core`).
3. **CI too abstract** — named `.github/workflows/test.yml` explicitly: add a dedicated
   artifact-canvas build+test step alongside the existing per-package steps.

Claude APPROVE'd; folded its tsconfig note (override `module`/`moduleResolution` to
`ESNext`/`bundler` since the base is `NodeNext` and tsup owns module output).

### Plan iteration 4 (2026-06-09)
**Verdicts:** Gemini SKIPPED (agy); **Codex REQUEST_CHANGES (HIGH)**; **Claude APPROVE (HIGH)**.
Not a clean 2/3. Codex's two gaps (both legitimate; the second a spec-mandated deferral that was
missed), addressed in iteration 5:
1. **Adapter error semantics had no AC/tests** — spec D2 locked the behavior; P3 now has an
   explicit error-semantics deliverable, AC, and tests (guarded `read/watch/list/resolve/onChange`
   → `onError` + console; failed `list()` preserves prior markers).
2. **Out-of-range-marker policy unresolved** — the spec explicitly deferred it to the plan; P3 now
   resolves it: an out-of-range `ReviewMarker` (line ≥ doc length) is **ignored** + warned once
   (chosen over clamp/hard-error), with a test.
Minor (Codex): named the `examples/` entrypoint (`index.html` + `main.tsx` + `vite.config.ts`,
`dev:example` script). Folded Claude's notes: CI step placement (no core/types dep → runs right
after install), publish-analogy precision (not even packed for local-install, unlike codev-core),
vite devDep timing.

## Notes
This plan keeps host integration out of scope (per spec Non-Goals). The smoke-test host uses
stub adapters purely to validate the package contract end-to-end. The five deferred items are
tracked as plan-gate acceptance criteria above and will be verified at the plan consult and the
plan-approval gate.
