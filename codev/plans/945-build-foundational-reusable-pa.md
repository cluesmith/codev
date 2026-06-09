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
- [ ] `tsconfig.json` extending the repo base; `vitest.config.ts`.
- [ ] `src/adapters/{FileAdapter,MarkerAdapter,ThemeAdapter}.ts` — **interfaces only**.
- [ ] `src/types.ts` — `ReviewMarker`, `Disposable`, `ArtifactCanvasProps` (incl.
      `onAddComment(line: number): void`, optional `onError?(err: unknown): void`).
- [ ] `src/styles/default-theme.css` — the 8 v1 `--codev-canvas-*` tokens with fallbacks.
- [ ] `src/index.ts` — public API exports (component placeholder, all interfaces/types).
- [ ] Workspace wiring (picked up by `packages/*`; `pnpm install` resolves).
- [ ] Tests: import-boundary (no `vscode`/`node:*`/`fs`/`fetch`); build-smoke (CJS `require` + ESM `import`).

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
- [ ] `src/components/ArtifactCanvas.tsx` — wires `FileAdapter` (read + watch),
      `MarkerAdapter` (list), `ThemeAdapter`; subscriptions via `useEffect` with idempotent
      `dispose()`; auto re-`list` when `watch` fires (D6); errors → `console` + `onError?`.
- [ ] **v1 marker rendering (deferred #4):** minimal line-level indicator for lines bearing a
      `ReviewMarker`, author + text via the overlay; no inline bubbles / minimap (those = #863).
- [ ] Theme binding via CSS variables only; `resolve()` not on the render path (D4 Model A).
- [ ] Tests: overlay intent (scenario 2), marker round-trip (scenario 3), ThemeAdapter
      contract (scenario 4), invariant (scenario 6), subscription teardown (scenario 9),
      keyboard activation.

#### Implementation Details
- **Deferred #5:** while touching Current State references, correct the spec's
  `review-decorations.ts` path to `packages/vscode/src/review-decorations.ts`.

#### Acceptance Criteria
- [ ] Clicking `+` (mouse or keyboard) invokes `onAddComment` with the expected 0-based line; package never calls `add`.
- [ ] Existing markers render (minimal v1 fidelity); host-side `add` + `watch` re-list refreshes them.
- [ ] Disposing a subscription stops further re-renders; `dispose()` twice is a no-op.

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
- [ ] `examples/` — a Vite dev page with stub `FileAdapter`/`MarkerAdapter`/`ThemeAdapter`,
      a sample artifact, demonstrating load → render → hover → click `+` → adapter receives
      intent → host add → marker round-trips. Excluded from the published package.
- [ ] `README.md` — the three adapter contracts, `ArtifactCanvasProps`, the `--codev-canvas-*`
      tokens + override example, and a host-implementation walkthrough.
- [ ] Any remaining cross-cutting tests (end-to-end smoke via the example harness).

#### Acceptance Criteria
- [ ] Smoke-test host demonstrates the full round-trip.
- [ ] README documents adapters + a host example.
- [ ] Full package `test` script green.

#### Test Plan
- **Manual**: run the Vite harness; exercise hover/click/keyboard/round-trip.
- **Integration**: end-to-end via the harness fixtures.

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

## Notes
This plan keeps host integration out of scope (per spec Non-Goals). The smoke-test host uses
stub adapters purely to validate the package contract end-to-end. The five deferred items are
tracked as plan-gate acceptance criteria above and will be verified at the plan consult and the
plan-approval gate.
