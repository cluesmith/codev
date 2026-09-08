# Plan 1380 — iteration 1 rebuttals

Every finding from both reviewers was accepted and folded into the plan; none is disputed.
Where the two reviews overlapped (Phase 1's self-contradictory criterion, the Playwright CI
home, phase dependencies) one edit answers both.

## Codex (REQUEST_CHANGES)

1. **`column-width` is a preferred minimum, not the rendered width.** Accepted — paging and
   progress computed from the token would drift whenever columns stretch to fill the
   viewport. Phase 3 now introduces a shared *measured* column-geometry helper (rendered
   width + gap from layout), and Phase 5's readout explicitly consumes it.

2. **VS Code bootstrap lifecycle: the canvas mounts before the first host message.**
   Accepted — a later `initialReadingMode` prop cannot initialize an already-mounted
   uncontrolled component. Phase 6 now defines the bootstrap: the persisted mode is embedded
   in the initial webview HTML via a template placeholder the provider substitutes, read
   synchronously and passed at first mount. No remount, no mount delay, and
   `HostToWebviewMessage` needs no change.

3. **Wheel remap needs a native non-passive listener.** Accepted — Phase 3 specifies an
   effect-managed native `wheel` listener with `{ passive: false }`, and the browser test
   plan now asserts `preventDefault` efficacy (no residual vertical scroll).

4. **Playwright suite not wired into CI.** Accepted (jointly with Claude 2) — Phase 2 now
   names the `@playwright/test` devDependency on artifact-canvas itself, a
   `playwright.config.ts` with a `webServer` serving the vite `examples/` harness, and a
   concrete PR-triggered step in `.github/workflows/test.yml`. The acceptance criterion
   changed from "CI-runnable" to "passes in the PR CI run".

5. **Path and dependency corrections.** Accepted — `messages.ts` (not `.js`); Phases 3, 4,
   and 5 now declare their Phase 2 (and Phase 3, for 5) dependencies explicitly.

6. **Phase 1's impossible DOM-identity assertion.** Accepted (jointly with Claude 1) — the
   criterion is rescoped: no new classes/attributes on the body, rows, or any `[data-line]`
   block; the toggle is the sole added node.

7. **Cross-column selection and watch-reload missing from verification.** Accepted — both
   are now in Phase 6's dev-approval checklist; watch-reload additionally got automated
   homes (state half in Phase 1's unit tests, affordance re-host half in Phase 4's browser
   assertions).

## Claude (COMMENT)

1. **Phase 1 criterion contradicts its own deliverable.** Accepted — same fix as Codex 6,
   using the scoping the review suggested.

2. **Fixture has no CI home; `@playwright/test` unresolvable from artifact-canvas.**
   Accepted — same fix as Codex 4, adopting all three named specifics (devDep, serving
   harness, CI step).

3. **Understated harness coupling in Phases 3/5.** Accepted — dependencies updated (and
   Phase 4's parenthetical made explicit).

4. **Spec Scenarios 9 and 5c had no home.** Accepted — Scenario 9 split across Phase 1
   (mode-class survives rebuild, unit) and Phase 4 (affordance re-host + focus restoration
   under columns, browser), plus the Phase 6 manual pass; Scenario 5c added to Phase 6's
   checklist.

5. **Phase 6 file list incomplete; message-shape premise wrong.** Accepted —
   `apps/vscode/src/extension.ts` added; the `Memento` is plumbed through
   `MarkdownPreviewProvider`'s constructor; the message decision is now recorded in the
   plan: only `WebviewToHostMessage` (already a union) gains a member, `HostToWebviewMessage`
   stays an interface, and the initial mode travels in the template HTML (which also
   resolves Codex 2). The risk-table row was corrected to match.

6. **Mode-class placement ambiguous.** Accepted — the class sits on the canvas root; every
   multicol rule is scoped `.codev-canvas-mode-horizontal .codev-artifact-canvas-body`; no
   new rule reuses the shared `:is(body, rendered)` selectors, keeping `MarkdownView`
   untouched by construction.

7. **`offsetTop` row-relative behavior asserted as verified.** Accepted — reworded to a
   verification item on the browser harness; the spike's finding 8 covers only the
   container-level case.
