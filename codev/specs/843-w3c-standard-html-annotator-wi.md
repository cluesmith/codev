# Specification: W3C-Standard HTML Annotator with Inline JSON-LD Storage

## Metadata
- **ID**: spec-2026-05-24-w3c-html-annotator
- **Issue**: #843
- **Status**: draft
- **Created**: 2026-05-24

## Problem Statement

The Codev annotator (`packages/codev/templates/open.html`) is line-based: comments anchor to whole lines and are stored as inline source comments (`<!-- REVIEW: ... -->` for HTML/MD, `// REVIEW:` for JS, etc.). This is the right model for code review, where lines are the atomic unit. It is the wrong model for **prose-style HTML** (rendered documents, reports, articles, design docs), where the meaningful unit is an arbitrary text range — a phrase, a clause, a few words spanning element boundaries.

A user reading a rendered HTML document via `afx open` today can switch to "Preview" mode (sandboxed iframe), but cannot select a phrase and attach a comment to it. They must drop back into source view, find the surrounding line, and leave a `<!-- REVIEW: ... -->`. This is friction, and the resulting comment loses the precise quote it was about.

We need a second annotation mode — a W3C Web Annotation-compliant annotator for HTML — that anchors to arbitrary text ranges using TextQuoteSelector + TextPositionSelector, persists the annotation set inline in the HTML file (as embedded JSON-LD), and re-anchors on load using a real matching library (Apache Annotator, not hand-rolled).

The existing line-based annotator continues to own code and markdown; the new mode is exclusively for HTML in **preview view**.

## Current State

`open.html` handles HTML files today by:

1. **Source view (Annotate mode, default for `.html`)** — renders the file as syntax-highlighted source with line numbers. Clicking a line number opens a comment dialog; saved comments become `<!-- REVIEW(@architect): ... -->` lines inserted into the source. Re-opening the file reads the comments back from the source.
2. **Preview mode** — toggled via the "Preview" button. Renders `currentContent` into a sandboxed iframe (`<iframe sandbox="allow-scripts" srcdoc=...>`). **No annotation interaction is available in this mode** — it's purely a viewer.

Save path: `POST /api/annotate/:tabId/save` with the entire file content. The server writes the file. (See `packages/codev/src/agent-farm/servers/tower-routes.ts:1531+`.)

Iframe isolation: `sandbox="allow-scripts"` gives the iframe a **null origin**, so the parent document cannot read `iframe.contentDocument.getSelection()` or otherwise reach in. Communication must go through `postMessage`.

## Desired State

A user opens an HTML file via `afx open path/to/file.html`:

1. The file opens in source-view annotate mode (current behavior, unchanged — preserves the existing line-based workflow for users who want it).
2. The user clicks "Preview" to enter the rendered iframe view.
3. **(New)** In preview mode, a small "Annotate prose" toggle appears in the toolbar. When enabled:
   - Existing annotations (from the file's embedded JSON-LD block) are highlighted with `<mark>` overlays in the iframe.
   - Selecting any text range in the iframe surfaces a comment dialog (reusing the same dialog from line-based mode).
   - Submitting the comment computes a W3C TextQuoteSelector + TextPositionSelector for the range, writes the annotation into the file's `<script type="application/ld+json" id="codev-annotations">` block (creating the block if absent), and saves the file via the existing save endpoint.
   - The annotations panel lists prose annotations alongside line annotations, distinguishing them visually.
4. Closing and reopening the file: annotations re-anchor. Annotations that re-anchor cleanly show as highlights; orphaned annotations (the quote no longer matches) appear in the annotations panel with an "orphaned" badge and the captured quote, so the user can manually find and reattach or delete them.

The file remains a single source of truth — anyone with a text editor can read, diff, version-control, or delete annotations directly in the `<script>` block.

## Stakeholders

- **Primary Users**: Codev users reviewing prose-style HTML content (design docs, reports, generated HTML output, AI-authored documents).
- **Secondary Users**: Architects reviewing builder output that happens to be HTML; users of `afx open` more generally.
- **Technical Team**: Codev maintainers (UI, annotator, tower routing).
- **Business Owners**: Codev project (self-hosted; no external decision-maker).

## Success Criteria

### Functional
- [ ] Opening an HTML file with `afx open` and switching to Preview mode reveals an "Annotate prose" toggle.
- [ ] With the toggle on, selecting text in the iframe and entering a comment writes a W3C-compliant annotation into the file's `<script type="application/ld+json" id="codev-annotations">` block.
- [ ] The block validates against the W3C Web Annotation Data Model (a single `AnnotationCollection` with `items` of type `Annotation`, each carrying a `TextQuoteSelector` and a `TextPositionSelector`).
- [ ] Closing and reopening the file re-anchors annotations using `@apache-annotator/dom` matchers and re-applies `<mark>` highlights.
- [ ] Editing the surrounding HTML in a text editor (insert/delete a few sentences nearby) and reopening: annotations whose `prefix`/`suffix` still matches anchor cleanly; annotations whose anchor text was modified appear in the panel as **orphaned** with the captured quote shown.
- [ ] An annotation can be deleted via the annotations panel; deletion rewrites the JSON-LD block and saves the file.
- [ ] Triple-Enter to submit (current dialog behavior) works in the new mode.

### Non-Functional
- [ ] Iframe sandbox is NOT weakened: `sandbox="allow-scripts"` (null origin) is preserved. Selection capture, highlighting, and parent communication use `postMessage` from an injected script inside the iframe.
- [ ] Save uses the existing `POST .../save` endpoint. No new server route is required for annotation persistence (the JSON-LD block is part of the file).
- [ ] No annotation server, no sidecar storage, no sync protocol. The file is the only state.
- [ ] All vendored dependencies (Apache Annotator) ship as a single pre-bundled file in `packages/codev/templates/vendor/`, consistent with how `marked.min.js`, `prism.min.js`, `purify.min.js` are vendored today. No build step on the user's machine.
- [ ] Existing line-based annotator (`open.html` source view, REVIEW-comment storage) continues to work unchanged for HTML, MD, and code files.

### Test Coverage
- [ ] Unit tests: TextQuoteSelector/Position generation from a `Range`, JSON-LD block round-trip (parse → modify → serialize → parse), graceful handling of malformed JSON-LD.
- [ ] Unit tests: re-anchoring against a modified document (using jsdom) — exact match, prefix/suffix drift tolerance, orphan detection.
- [ ] E2E test (Playwright): full headline path — open HTML file, switch to Preview, toggle Annotate Prose, select text, comment, save, close, reopen, verify highlight reappears.
- [ ] E2E test (Playwright): orphan path — modify the HTML in-test, reopen, verify orphan appears in panel.

## Constraints

### Technical Constraints
- **Iframe isolation must not be weakened.** The current `sandbox="allow-scripts"` (null-origin) protects the parent (Codev tower UI) from arbitrary HTML content that may contain hostile scripts. Adding `allow-same-origin` would let iframe scripts call `fetch('/api/...')` against the tower, read the tower's localStorage cookies, etc. — unacceptable. The annotator code that reads selections and applies highlights MUST run **inside** the iframe and communicate with the parent via `postMessage`.
- **No new server endpoints.** Persistence reuses `POST /api/annotate/:tabId/save` (full-file write). The JSON-LD block IS part of the file.
- **No build step on the user's machine.** Apache Annotator and its transitive deps must be pre-bundled by Codev's build pipeline into a single file under `packages/codev/templates/vendor/`, like the other vendored libs. The vendor file ships in the published npm package.
- **No regression to existing modes.** Source-view annotation, markdown preview, image/video/PDF viewers, and the line-based REVIEW-comment workflow for HTML files must continue to work exactly as today. The new behavior is purely additive and gated on Preview-mode + an explicit "Annotate prose" toggle.
- **Single source of truth.** No sidecar files. No annotation server. The HTML file holds everything.
- **W3C compliance.** Annotation JSON shape must validate against the W3C Web Annotation Data Model (https://www.w3.org/TR/annotation-model/). External tools should be able to read the annotations without Codev-specific knowledge.

### Business Constraints
- Ship within the Codev v3.x line (no major version bump required). Additive feature; backward-compatible with all existing annotator workflows.
- Apache Annotator is Apache-2.0 licensed — compatible with Codev. Vendor copy must preserve the NOTICE / LICENSE files in `packages/codev/templates/vendor/` per Apache-2.0 §4(d).

## Assumptions

- Apache Annotator (`@apache-annotator/dom@^0.3.0`) bundles successfully as a single ESM/UMD file with its transitive deps (`@apache-annotator/selector`, `@medv/finder`, `@babel/runtime-corejs3`). The bundled file is expected to be in the ~50–150KB minified range. If bundling produces something disproportionately large (>500KB), this becomes a discussion point at plan time (vendor a subset, use a different matching library, etc.) — not a spec change.
- The existing save endpoint can handle the additional bytes added by the JSON-LD block without changes. (Save already does full-file writes of arbitrary size; HTML with a few annotations is unremarkable.)
- The bug-281+ family of tests that exercise `open.html` continue to pass unchanged. New tests are added; existing tests are not modified.

## Solution Approaches

### Approach 1: Inject annotator JS into the iframe via srcdoc rewriting (RECOMMENDED)

**Description**: Before assigning `iframe.srcdoc = currentContent`, the parent rewrites the HTML to inject a `<script>` tag containing the vendored Apache Annotator + a thin "iframe bridge" that:
- On load, reads `<script type="application/ld+json" id="codev-annotations">` from the iframe's own document, parses annotations, and applies highlights via Apache Annotator's `highlightText`.
- Listens to `selectionchange`/`mouseup` in the iframe, computes selectors via Apache Annotator's `describe` functions, and `postMessage`s the candidate selection to the parent.
- Receives `postMessage` instructions from the parent ("show comment dialog response: persist this annotation with id=X / delete annotation X") and updates highlights + the JSON-LD block accordingly.
- Reports the updated full HTML (with refreshed JSON-LD block) back to the parent via `postMessage` whenever the annotation set changes; the parent treats this as the new `currentContent` and triggers the existing `saveFile()` path.

**Pros**:
- Preserves `sandbox="allow-scripts"` — no weakening of isolation.
- Reuses the existing save path verbatim — one source of truth: the full file content.
- Apache Annotator does the matching; we don't roll our own.
- All annotation logic lives in one injected script — easy to audit and update.

**Cons**:
- HTML rewriting must be robust (where to inject the script — before `</body>` if present, else at end of document). Edge case: source HTML with no `<body>` tag at all (fragment-style HTML).
- `postMessage` round-trips for each interaction (selection → comment → persist → re-render) add some complexity, but each round-trip is local and synchronous-feeling.
- If the source HTML already has a `<script type="application/ld+json" id="codev-annotations">` block with malformed content, we must surface the error gracefully rather than silently overwriting the user's data.

**Estimated Complexity**: Medium
**Risk Level**: Low (iframe-bridge pattern is well-trodden)

### Approach 2: Weaken sandbox to `allow-scripts allow-same-origin`

**Description**: Set `sandbox="allow-scripts allow-same-origin"` so the parent can directly access `iframe.contentDocument` and `iframe.contentWindow.getSelection()`. All annotator logic stays in the parent.

**Pros**:
- Simpler architecture — no `postMessage` plumbing, no script injection.
- Easier to debug.

**Cons**:
- **Security regression.** Iframe content (arbitrary HTML, possibly AI-generated or downloaded) can now `fetch` against the tower server's origin, read shared cookies, mutate parent DOM via `parent.document`, etc.
- This is the kind of change that's easy to ship and hard to walk back — once users rely on the relaxed sandbox, hardening it later is a breaking change.

**Estimated Complexity**: Low
**Risk Level**: **High** (security)

**Decision**: Rejected. The Constraints section forbids weakening the sandbox.

### Approach 3: Drop the iframe, render inline via DOMPurify (like markdown)

**Description**: Render HTML directly into a parent-DOM `<div>` after DOMPurify sanitization, the same way markdown preview works today. No iframe, no sandbox, no `postMessage`.

**Pros**:
- Simplest possible architecture for annotation interaction.
- No iframe-bridge plumbing.

**Cons**:
- Loses CSS isolation — author's `<style>` blocks and class names bleed into the Codev UI, breaking layout.
- DOMPurify strips many tags/attributes that are perfectly valid in the source HTML (anything that could carry JS). The "rendered" view ceases to match what the user sees when they open the file in a browser.
- Doesn't address the use case: users want to annotate the document **as it actually renders**, including its own styles.

**Decision**: Rejected. The existing iframe rendering is load-bearing precisely because it preserves the document's own CSS context.

## Open Questions

### Resolved (proposed answers — confirm with architect at first consultation)

**Q1 (from issue): File-extension trigger — default for `.html`, or opt-in via flag/extension list?**

**Proposed answer**: No new trigger. The annotator opens `.html` files in source-view annotate mode by default (current behavior, unchanged). Prose annotation appears only when the user clicks **Preview** (existing button) AND clicks the new **Annotate prose** toggle that surfaces in preview mode. The toggle's state is per-tab, not persisted. Rationale: zero-regression for users who currently use line-based annotation on HTML; discoverable for users who want the new mode; no CLI surface change to `afx open`.

**Q2 (from issue): How are orphaned annotations surfaced when re-anchoring fails?**

**Proposed answer**: In the annotations panel, orphaned annotations render with:
- An `[orphaned]` badge in a warning color
- The captured `exact` quote shown in the panel item (so the user can find it manually)
- The comment text (so the user can decide whether to keep it)
- A delete button (same as in-anchor annotations)
- A "show in raw JSON-LD" affordance that scrolls the source view to the `<script>` block and highlights the entry, so the user can hand-edit the selector if they want to reattach it

Orphaned annotations are NOT auto-deleted. They persist in the JSON-LD block; they just don't apply a highlight. This is the safe default — annotations represent user intent and shouldn't disappear silently.

**Q3 (from issue): JSON-LD author info — pull from `git config user.name`?**

**Proposed answer**: Yes, with a fallback. The W3C model allows a `creator` field on each annotation. We populate it with `{ type: "Person", name: <git config user.name>, nickname: <git config user.email> }`. If `git config` returns nothing, fall back to `{ type: "Person", name: "anonymous" }`. We do this in the existing `getAuthor()` style used by line-based annotations (which embed `(@architect)` / `(@<name>)` in the comment prefix). Author resolution happens **server-side** in the save route (where git config is already accessible), not in the iframe.

### New (raised by this spec; need architect input)

**Q4 (Critical)**: When the user has the source view open and saves a prose annotation via Preview mode, the source view shows stale content. Two options:
  - **(a)** Source view auto-refreshes after a save initiated by Preview mode (re-renders syntax-highlighted source from the new content).
  - **(b)** Source view shows a "Reload to see changes" banner; user clicks to refresh.

  Proposed default: **(a)** auto-refresh, because the save is initiated by the user's own action in the same tab — there's no risk of conflicting unsaved edits in source view (saving from Preview while source view has dirty edits is already blocked by the existing `hasUnsavedChanges` check, which we will extend).

**Q5 (Important)**: Should the new annotator support **annotating across iframe boundaries** (e.g., a selection that starts in one paragraph and ends in another that's inside a nested iframe)? Proposed: **no.** Apache Annotator handles single-document ranges. Nested iframes in user HTML are out of scope; selections that cross them are rejected with a toast ("Selection crosses an iframe boundary — please select within a single frame.").

**Q6 (Important)**: How do we handle HTML files that already contain a `<script type="application/ld+json" id="codev-annotations">` block from a previous version of the annotator (forward compatibility)? Proposed: Annotations carry a `codev:schemaVersion` field. Current spec is `1`. On read, unknown future versions: surface a warning, render no highlights, do not overwrite the block on save. This makes the format extensible without painting future selves into a corner.

**Q7 (Nice-to-know)**: Should highlights be visually distinct between "your" annotations (current git user) and "others"? The W3C model carries `creator`, so we have the data. Proposed: **defer to a follow-up.** Ship visual parity first; per-author color is a UX refinement that doesn't block the primitive.

## Performance Requirements

- **Highlight application on load**: < 200ms for documents with up to 50 annotations on a ~500KB HTML file. (Apache Annotator's `highlightText` is O(annotations × document-text-length); this comfortably fits.)
- **Selection → comment dialog**: < 50ms perceived latency (the `postMessage` round-trip + dialog open).
- **Save round-trip**: dominated by the existing save endpoint (full-file POST). Acceptable up to the same file-size limits the current annotator accepts.
- **No memory leak**: opening/closing the same file 10 times in a row should not grow heap beyond baseline + per-document overhead. (Standard iframe lifecycle.)

## Security Considerations

- **Iframe isolation preserved** (see Constraints). The injected annotator script runs inside the iframe's null origin; it cannot reach Codev's origin.
- **`postMessage` validation**: The parent ignores any `message` event whose `source` is not the expected iframe `contentWindow` and whose `data` lacks the expected `__codevAnnotator: true` marker. Prevents stray messages from other windows / extensions from being interpreted as annotator commands.
- **JSON-LD parsing**: Use `JSON.parse` (not `eval`); wrap in try/catch; on parse error, surface "Annotations block malformed — repair manually or delete" rather than silently nuking the user's data.
- **`<mark>` injection**: Done by Apache Annotator's `highlightText`, which wraps existing text nodes — does not inject arbitrary HTML. Safe by construction.
- **Author identity**: Pulled from local `git config` — same trust boundary as the existing line-based annotator. No new exposure.

## Test Scenarios

### Functional Tests

1. **Happy path**: Open `test.html` (rendered as a paragraph of text). Toggle Preview → Annotate prose. Select the phrase "the quick brown fox". Enter comment "this is a classic pangram". Save. Inspect the file on disk: JSON-LD block contains one annotation with `exact: "the quick brown fox"`, matching prefix/suffix, matching position offsets, and the comment text. Close. Reopen → annotation re-anchors, `<mark>` overlay visible.

2. **Round-trip across edits (minor)**: Annotate "the quick brown fox". Save. In a text editor, change the surrounding paragraph's *first* sentence (text before the prefix). Reopen → annotation still anchors (prefix may shift but `exact` still matches uniquely).

3. **Round-trip across edits (orphaning)**: Annotate "the quick brown fox". Save. In a text editor, change "fox" to "dog" — the `exact` no longer matches. Reopen → annotation appears in panel with `[orphaned]` badge, captured quote, comment text intact.

4. **Multiple annotations**: Add three annotations on three different ranges. All persist. Reopening: all re-anchor.

5. **Delete from panel**: Click delete on an annotation. JSON-LD block updates, file saves, highlight disappears from the iframe.

6. **Source view auto-refresh after Preview save** (Q4 confirmation): With source view open, switch to Preview, add an annotation, switch back to source view → source shows the updated JSON-LD block.

7. **Malformed JSON-LD on load**: A file with `<script id="codev-annotations">{ malformed</script>` opens with a panel warning, no highlights, and a "repair manually" affordance. Subsequent saves do NOT overwrite the malformed block.

8. **No annotations block present**: Opening a clean HTML file shows the iframe normally; no JSON-LD block exists; first annotation creates the block.

9. **HTML without `<body>` tag**: Opening a fragment-style HTML file (e.g. just `<p>Hello</p>`) works — the injected script and JSON-LD block are appended to the document.

### Non-Functional Tests

1. **Sandbox preserved**: After the change, `iframe.sandbox.value` is exactly `"allow-scripts"` — no `allow-same-origin`. Verified in an automated test (Playwright assertion on the rendered iframe attributes).

2. **`postMessage` origin check**: A test fires a `postMessage` from a non-iframe source with a valid-looking payload — parent ignores it.

3. **Headline path E2E (Playwright)**: scripted run of the issue's "End-to-end usability check" steps 1–6.

## Dependencies

### External Libraries (vendored)
- **`@apache-annotator/dom@^0.3.0`** + transitive deps: bundled into a single file at `packages/codev/templates/vendor/apache-annotator.min.js`. Apache-2.0; LICENSE + NOTICE copied to the vendor directory.

### Internal Systems
- `packages/codev/templates/open.html` — extended (annotator dialog, panel, save path reused; new toggle button, new preview-mode wiring).
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — minor extension to inject author info into saves (Q3) if not already handled in the existing save route.
- Vendor build step in `packages/codev/scripts/` — new script to bundle Apache Annotator. Runs at `pnpm build` time; output is committed to the repo (consistent with the existing vendor pattern, which checks in pre-bundled files).

### Outgoing Dependencies on This Spec
- None. This is an additive feature; nothing else in Codev consumes the new JSON-LD format.

## References

- W3C Web Annotation Data Model: https://www.w3.org/TR/annotation-model/
- Apache Annotator (matching library): https://github.com/apache/incubator-annotator
- Existing annotator: `packages/codev/templates/open.html`
- Tower route serving annotator templates: `packages/codev/src/agent-farm/servers/tower-routes.ts:2480+`
- Existing iframe rendering: `packages/codev/templates/open.html:487` (`<iframe id="html-preview-container" sandbox="allow-scripts" ...>`)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Apache Annotator bundle is unexpectedly large (>500KB) | Low | Medium | Discovered at vendor-build step in plan phase. If hit: discuss with architect — options are tree-shaking, vendoring subset, or substituting a smaller matcher. Not a spec-rewrite. |
| Apache Annotator API changes between minor versions | Low | Low | Vendor pins `^0.3.0`. Vendor file committed to repo. Upgrades are deliberate. |
| Iframe `postMessage` plumbing has subtle bugs across browsers | Low | Medium | E2E test in Playwright (Chromium baseline; same browser real users hit via Codev terminal). Manual smoke test in Safari before tagging release. |
| User edits the `<script id="codev-annotations">` block by hand and breaks JSON | Medium | Low | Graceful malformed-JSON handling: surface warning, don't overwrite. (Already in functional tests #7.) |
| Source-view + Preview-view divergence (Q4) confuses users | Low | Medium | Auto-refresh source view after Preview save (Q4 proposed answer). E2E covers it. |
| Apache-2.0 NOTICE compliance miss | Low | Medium | Plan phase explicitly includes copying LICENSE + NOTICE files to `vendor/` directory. Spec calls this out in Constraints. |
| Annotation `creator` leaks private email if a user shares an HTML file publicly | Low | Low | Author email comes from `git config user.email` (the same email already in commits the user pushes). Same trust boundary; no new exposure. Documented in security section. |

## Expert Consultation

**Date**: 2026-05-24
**Models Consulted**: TBD (will run consult -m gemini, codex, claude in parallel after this draft commits)
**Sections Updated**: TBD

## Approval

- [ ] Architect Review
- [ ] Expert AI Consultation Complete (Gemini, Codex, Claude)
- [ ] Open Questions Q4–Q7 resolved with architect

## Notes

- The existing line-based annotator stays the default for HTML in source view. This spec is purely additive; nothing about today's workflow regresses.
- The new mode is gated behind two clicks (Preview → Annotate prose), which is intentional. Users who don't want it never see it.
- No GitHub PR will be opened per implementation phase; phases commit to the same branch, single PR at the end (per builder prompt's PR Strategy).

---

## Amendments

<!-- TICK amendments will be appended here -->
