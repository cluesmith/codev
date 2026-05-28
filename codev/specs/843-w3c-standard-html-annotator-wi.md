# Specification: W3C-Standard HTML Annotator with Inline JSON-LD Storage

## Metadata
- **ID**: spec-2026-05-24-w3c-html-annotator
- **Issue**: #843
- **Status**: draft (revision 3 — incorporates architect inline-comment feedback on preview default, default-on toggle, unification vision, and GitHub review experience)
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

1. **The file opens in Preview mode by default** (rendered iframe view). Prose annotation is **active by default** — existing annotations are highlighted with `<mark>` overlays on load; selecting any text range surfaces the comment dialog immediately. No toggle click required to start annotating; the new mode is the headline experience for HTML.
2. **Source view remains available** via the existing toolbar button (renamed from "Preview" to a paired toggle: "Source ↔ Preview"). Users who want the line-based workflow on HTML — or who need to hand-edit the JSON-LD block, the document markup, or read inline `<!-- REVIEW(@architect): ... -->` comments left by other tools — click into source view. Source view continues to support line-based annotation exactly as it does today (no regression).
3. **Prose annotation interactions** (in Preview mode, which is the default):
   - Existing annotations are highlighted with `<mark>` overlays in the iframe on load.
   - Selecting any text range in the iframe surfaces a comment dialog (reusing the same dialog as line-based mode).
   - Submitting the comment computes a W3C TextQuoteSelector + TextPositionSelector for the range, writes the annotation into the file's `<script type="application/ld+json" id="codev-annotations">` block (creating the block if absent), and saves the file via the existing save endpoint.
   - The annotations panel lists all annotations on the open file (prose and any pre-existing line-based REVIEW comments), distinguishing them visually with a small badge (`prose` vs `line`). For users who want to disable prose annotation temporarily (e.g., to read without selection chrome), an **"Annotate prose"** toggle in the toolbar is **on by default** and can be flipped off; flipping it off hides the highlights and disables selection capture but does not delete the JSON-LD block.
4. Closing and reopening the file: annotations re-anchor. Annotations that re-anchor cleanly show as highlights; orphaned annotations (the quote no longer matches) appear in the annotations panel with an "orphaned" badge and the captured quote, so the user can manually find and reattach or delete them.

The file remains a single source of truth — anyone with a text editor can read, diff, version-control, or delete annotations directly in the `<script>` block.

### Unification direction (HTML-now, Markdown-next)

The architect raised a directional concern at spec review: the desired end state is a **unified annotation experience** across rendered content, not a permanent split between "prose annotations for HTML" and "line annotations for markdown." Line annotations were a useful-but-temporary mechanism justified by the cost of building a real range-anchoring system; with Apache Annotator vendored and a W3C-shaped storage format in place, the line-anchoring shortcut becomes optional.

**Scope of this spec**: HTML files only. The new prose annotator becomes the default mode for `.html` files; line-based REVIEW comments in HTML remain readable in source view (no migration, no breakage) but the default authoring surface is prose.

**Out of scope for this spec, designed for**: Markdown files. The same JSON-LD block design is intentionally **content-type-agnostic**: every selector (TextQuoteSelector + TextPositionSelector) anchors to rendered character offsets in the displayed DOM, not to source-file line numbers. That means a future follow-up spec can extend the prose annotator to markdown with no JSON-LD format change. The remaining design question for markdown (where does the JSON-LD live — appended-comment in the `.md` file, sidecar `.md.annotations.json`, or as `<script type="application/ld+json">` in a synthesized HTML output) is genuinely a separate spec. Pulling that into this spec would push the surface area from one file type (HTML, where rendered = source) to two (Markdown, where rendered ≠ source and source-line-stability is a user expectation), at least doubling the implementation cost. **Deferred to a follow-up spec, not abandoned.**

**Line-mode disposition**:
- For **code** (`.js`/`.ts`/`.py`/etc.): line-based REVIEW comments remain the only mode — code review is line-anchored by nature; this spec does not propose changing it.
- For **HTML**: line-based REVIEW comments remain *readable and editable* in source view, but the default workflow becomes prose annotation. Pre-existing `<!-- REVIEW(@architect): ... -->` comments are shown in the annotations panel alongside JSON-LD annotations.
- For **Markdown**: unchanged in this spec. A follow-up spec is expected to extend prose annotation to markdown, at which point line-based comments in markdown can be marked as legacy.

## GitHub Review Considerations

The architect raised the concern: "How do reviewers see HTML annotations in a GitHub PR?" Codev's annotator UI does not run on github.com — reviewers see whatever GitHub's diff and file viewer show. This section documents what is and isn't visible there.

**What IS visible in a GitHub PR diff:**
- Every annotation appears in the diff as a JSON object addition inside the `<script type="application/ld+json" id="codev-annotations">` block. The fields most useful for review — `body[0].value` (the comment), `target.selector[0].exact` (the quoted text from the document), `creator.name` (who wrote it), `created` (when) — are plain human-readable strings.
- Edits to the underlying HTML appear as ordinary HTML diffs.
- A reviewer scanning the PR can read every annotation by glancing at the JSON-LD block; nothing is encoded or compressed.

**What is NOT visible in a GitHub PR diff:**
- The `<mark>` highlights — they are applied by the annotator at view time inside Codev's iframe; GitHub never runs that code.
- The visual association between an annotation and the *surrounding* document context. The `exact` quote is captured, but a reviewer who wants to see "where in the rendered document is this annotation attached" must check out the branch and `afx open` the file.

**Practical implication for the headline path**: for casual PR review (a reviewer reading the diff in the GitHub web UI), every annotation's *content* is plain-text-readable. For deeper review (seeing the annotation in context, navigating between annotations), the recommended workflow is `gh pr checkout && afx open path/to/file.html` — the same workflow already used for reviewing line-based REVIEW comments on prose-heavy files today.

**Possible future improvements (out of scope for this spec):**
- A `codev annotations summarize <file>` CLI that produces a markdown-formatted index of all annotations in a file, intended for PR descriptions or PR comments.
- A GitHub Action (opt-in) that auto-comments on PRs touching HTML files with a per-annotation summary linking to a hosted Codev preview, if a hosted-preview surface ever exists.

Neither is required for the headline use case. Listed here to make clear that the GitHub-review limitation has known mitigation paths if and when it becomes painful.

## Stakeholders

- **Primary Users**: Codev users reviewing prose-style HTML content (design docs, reports, generated HTML output, AI-authored documents).
- **Secondary Users**: Architects reviewing builder output that happens to be HTML; users of `afx open` more generally.
- **Technical Team**: Codev maintainers (UI, annotator, tower routing).
- **Business Owners**: Codev project (self-hosted; no external decision-maker).

## Success Criteria

### Functional
- [ ] Opening an HTML file with `afx open` lands the user in **Preview mode by default**, with the prose-annotation layer active. Existing annotations highlight on load; selecting text immediately surfaces the comment dialog.
- [ ] The "Annotate prose" toggle in the toolbar is **on by default** for HTML files. Flipping it off hides highlights and disables selection capture (but does not modify the JSON-LD block); flipping it back on restores both.
- [ ] A "Source" toolbar button (paired toggle with "Preview") lets the user flip into the legacy source-view annotate mode at any time. Source view continues to work exactly as today, including line-based REVIEW-comment authoring.
- [ ] Selecting text in the iframe (with the toggle on) and entering a comment writes a W3C-compliant annotation into the file's `<script type="application/ld+json" id="codev-annotations">` block.
- [ ] The block validates against the W3C Web Annotation Data Model (a single `AnnotationCollection` with `items` of type `Annotation`, each carrying a `TextQuoteSelector` and a `TextPositionSelector`). See **JSON-LD Contract** below for the exact shape.
- [ ] Closing and reopening the file re-anchors annotations using `@apache-annotator/dom` matchers and re-applies `<mark>` highlights.
- [ ] Editing the surrounding HTML in a text editor (insert/delete a few sentences nearby) and reopening: annotations whose `prefix`/`suffix` still matches anchor cleanly; annotations whose anchor text was modified appear in the panel as **orphaned** with the captured quote shown.
- [ ] An annotation can be deleted via the annotations panel; deletion rewrites the JSON-LD block and saves the file.
- [ ] Triple-Enter to submit (current dialog behavior) works in the new mode.
- [ ] Switching from Preview back to source view (annotate mode) after a prose-annotation save re-renders the source grid from the updated `currentContent` (existing `togglePreviewMode` only toggles CSS display today — `renderFile()` must be called when toggling away from Preview if `currentContent` changed). **Required, not optional.**
- [ ] Clicking a prose annotation in the panel: if in Preview mode, scrolls the iframe to the highlight and pulses it; if in source mode, scrolls the source grid to the `<script id="codev-annotations">` line and visually flags the entry by its `id` field.
- [ ] Clicking a **line annotation** (a `<!-- REVIEW(@architect): ... -->` comment) in the panel while Preview mode is active: the parent flips to source view (calling `togglePreviewMode()`) and then performs the existing source-grid line-scroll + pulse behavior for the comment's line. Rationale: line annotations have no Preview-mode visual representation (no `<mark>` overlay, no rendered-DOM anchor); the only place to focus them is in source view, so the click implicitly switches modes. The line-annotation panel item carries an iconographic hint (e.g. "↩ source") so users understand the click will switch modes before they click.
- [ ] Saved files round-trip correctly: the saved HTML on disk does NOT contain the injected vendor script tags (Apache Annotator + bridge), only the user's original markup plus the updated `<script type="application/ld+json" id="codev-annotations">` block.
- [ ] When the existing JSON-LD block is malformed, the "Annotate prose" toggle is disabled with a tooltip ("Annotations block is malformed — fix in source view to re-enable") and no save path touches the block.

### Non-Functional
- [ ] Iframe sandbox is NOT weakened: `sandbox="allow-scripts"` (null origin) is preserved. Selection capture, highlighting, and parent communication use `postMessage` from an injected script inside the iframe.
- [ ] Save uses the existing `POST .../save` endpoint. No new server route is required for annotation persistence (the JSON-LD block is part of the file).
- [ ] No annotation server, no sidecar storage, no sync protocol. The file is the only state.
- [ ] All vendored dependencies (Apache Annotator) ship as a single pre-bundled file in `packages/codev/templates/vendor/`, consistent with how `marked.min.js`, `prism.min.js`, `purify.min.js` are vendored today. No build step on the user's machine.
- [ ] Existing line-based annotator (`open.html` source view, REVIEW-comment storage) continues to work unchanged for HTML, MD, and code files.

### Test Coverage
- [ ] Unit tests: TextQuoteSelector/Position generation from a `Range`, JSON-LD block round-trip (parse → modify → serialize → parse), graceful handling of malformed JSON-LD.
- [ ] Unit tests: re-anchoring against a modified document (using jsdom) — exact match, prefix/suffix drift tolerance, orphan detection.
- [ ] E2E test (Playwright): full headline path — open HTML file (lands in Preview mode with prose annotation active by default), select text, comment, save, close, reopen, verify highlight reappears.
- [ ] E2E test (Playwright): default-mode regression — opening an `.html` file lands in Preview by default and the "Annotate prose" toggle is on. Toggling it off hides highlights without modifying the file on disk. Clicking "Source" flips to legacy source-view annotate mode, and existing line-based REVIEW-comment authoring still works there.
- [ ] E2E test (Playwright): orphan path — modify the HTML in-test, reopen, verify orphan appears in panel.

## Constraints

### Technical Constraints
- **Iframe isolation must not be weakened.** The current `sandbox="allow-scripts"` (null-origin) protects the parent (Codev tower UI) from arbitrary HTML content that may contain hostile scripts. Adding `allow-same-origin` would let iframe scripts call `fetch('/api/...')` against the tower, read the tower's localStorage cookies, etc. — unacceptable. The annotator code that reads selections and applies highlights MUST run **inside** the iframe and communicate with the parent via `postMessage`.
- **No new server endpoints.** Persistence reuses `POST /api/annotate/:tabId/save` (full-file write). The JSON-LD block IS part of the file.
- **No build step on the user's machine.** Apache Annotator and its transitive deps must be pre-bundled by Codev's build pipeline into a single file under `packages/codev/templates/vendor/`, like the other vendored libs. The vendor file ships in the published npm package.
- **No regression to existing capabilities** (default mode for HTML changes; capabilities do not regress). Source-view annotation, markdown preview, image/video/PDF viewers, and the line-based REVIEW-comment workflow for HTML files all continue to work exactly as today, reachable from the toolbar. The only behavior change is the *default* landing mode for `.html` files (Preview-with-prose-annotation instead of source-annotate). Markdown files, code files, and all other types are unchanged.
- **Single source of truth.** No sidecar files. No annotation server. The HTML file holds everything.
- **W3C compliance.** Annotation JSON shape must validate against the W3C Web Annotation Data Model (https://www.w3.org/TR/annotation-model/). External tools should be able to read the annotations without Codev-specific knowledge.

### Business Constraints
- Ship within the Codev v3.x line (no major version bump required). Additive feature; backward-compatible with all existing annotator workflows.
- Apache Annotator is Apache-2.0 licensed — compatible with Codev. Vendor copy must preserve the NOTICE / LICENSE files in `packages/codev/templates/vendor/` per Apache-2.0 §4(d).

## JSON-LD Contract

The annotation block is exactly one `<script type="application/ld+json" id="codev-annotations">` element. It contains a single JSON object — a W3C `AnnotationCollection` with an explicit `@context` and an `items` array.

```json
{
  "@context": [
    "http://www.w3.org/ns/anno.jsonld",
    { "codev": "https://codev.dev/ns/annotation#" }
  ],
  "type": "AnnotationCollection",
  "codev:schemaVersion": 1,
  "items": [
    {
      "id": "urn:uuid:6f1a3d2c-...-...",
      "type": "Annotation",
      "created": "2026-05-24T15:32:01Z",
      "modified": "2026-05-24T15:32:01Z",
      "creator": {
        "type": "Person",
        "name": "M Waleed Kadous",
        "nickname": "admin@cluesmith.com"
      },
      "body": [
        { "type": "TextualBody", "value": "this is a classic pangram", "format": "text/plain", "purpose": "commenting" }
      ],
      "target": {
        "source": "self",
        "selector": [
          { "type": "TextQuoteSelector", "exact": "the quick brown fox", "prefix": "...", "suffix": "..." },
          { "type": "TextPositionSelector", "start": 142, "end": 161 }
        ]
      }
    }
  ]
}
```

**Required fields per annotation**: `id` (UUID urn), `type` (`"Annotation"`), `created` (ISO 8601 UTC), `modified` (ISO 8601 UTC), `creator`, `body` (array with at least one `TextualBody`), `target.selector` (array containing exactly one `TextQuoteSelector` AND one `TextPositionSelector`).

**Codev-specific extensions** live under the `codev:` prefix declared in `@context`. Currently only `codev:schemaVersion` (integer). Future extensions (per-author colors, threads, etc.) extend this namespace without breaking W3C validation.

**Schema-version policy**: Current is `1`. If a file on load has `codev:schemaVersion` greater than what this build understands, surface a warning ("Annotations created by a newer Codev version — read-only for now"), render no highlights, and DO NOT overwrite the block. If the field is absent, treat as version `1` for backward compat.

**The block contains no Codev runtime state.** Selectors are pure data per the W3C model; external tools can read and validate the file without any Codev-specific code.

## Save / Persistence Model

The save endpoint (`POST /api/annotate/:tabId/save`) is and remains a dumb pipe: it writes `req.body.content` to disk verbatim. No server-side parsing, no author injection at save time, no JSON-LD mutation. All serialization is performed in the iframe bridge before posting.

**Author info** is resolved at **template render time**, not at save time. The existing tower route at `tower-routes.ts:2480+` already template-substitutes `{{FILE_PATH}}`, `{{LANG}}`, etc. into `open.html`. Add `{{GIT_USER_NAME}}` and `{{GIT_USER_EMAIL}}` to that substitution (resolving via `git config user.name` / `git config user.email` from the file's containing repo, with `name=anonymous, email=""` fallback when git config returns nothing or the file is outside a git repo). The client uses these injected values to build the `creator` object before posting. Zero new server endpoints.

**Implementation note** (Gemini iter-2 finding #3): The current `handleWorkspaceAnnotate` function in `tower-routes.ts` is synchronous (returns `void`). Resolving git config requires spawning `git` as a subprocess and awaiting its output. The route must be refactored to `async function handleWorkspaceAnnotate(...)` returning `Promise<void>` so the git lookup can `await` without blocking the Tower event loop. The caller (`handleWorkspaceRoutes`) is already async, so this is a clean refactor — no signature ripple upstream.

**Iframe-to-disk round-trip — script-leak prevention**: The iframe bridge MUST construct the saved HTML by:
1. Holding the original HTML (as fetched from disk and passed in via `srcdoc`) in a string variable inside the bridge.
2. On any annotation mutation, computing the new JSON-LD block string.
3. Splicing the new block into the original HTML string (replacing the existing `<script id="codev-annotations">…</script>` element if present, else appending before `</body>` or at end-of-document if no `</body>`).
4. Posting that spliced string back to the parent via `postMessage`. The parent does NOT serialize the iframe's live DOM — that DOM contains the injected vendor script tags and Apache Annotator's `<mark>` wrappers, and would corrupt the file on save.

**Block stability** (refined per Codex iter-2 finding #2): The invariant is **scoped to the annotator's write paths**, not to user-driven text edits. Specifically:

- **Annotator-driven write paths** (Preview-mode prose-annotation create/update/delete, the iframe bridge's splice-and-save flow) MUST refuse to overwrite a block whose existing content fails `JSON.parse`. The block stays byte-for-byte identical; a UI message ("Annotations block is malformed — fix in source view to re-enable") surfaces. The toggle is disabled (per the `ready` postMessage `malformed: true` flag).
- **User-driven write paths** (source-view text edits where the user is *intentionally* editing the JSON-LD block to repair it) are NOT subject to the invariant — that would make hand-repair impossible. Source-view saves write `fileLines.join('\n')` verbatim, exactly as they do today; the annotator does not gate them. After the user saves a hand-repair, the next Preview-mode open will re-parse and (if now valid) re-enable the toggle.

In short: **the annotator never silently overwrites a malformed block; the user always can.** The two paths are distinguishable in the code because they use different save entry points (Preview-mode save flows through the iframe bridge's `content-changed` postMessage and updates `currentContent`; source-mode save reads from `fileLines`/the source grid).

## postMessage Protocol

Parent ↔ iframe communication uses `postMessage`. All messages carry `__codevAnnotator: true` for origin validation. Parent rejects any `message` event whose `source !== iframe.contentWindow` or whose `data.__codevAnnotator !== true`.

| # | Type | Direction | Payload | Purpose |
|---|------|-----------|---------|---------|
| 1 | `ready` | iframe → parent | `{ annotationCount, malformed: boolean }` | Iframe finished loading + parsing existing block. Parent enables/disables the "Annotate prose" toggle based on `malformed`. |
| 2 | `selection` | iframe → parent | `{ selector: { quote, position }, rangeText, clientRect: { top, left, width, height } }` | User completed a text selection. The iframe captures `range.getBoundingClientRect()` (selection's bounding rect in iframe-viewport coordinates) and includes it in the message. Because the iframe is null-origin, the parent cannot query this directly. Parent transforms `clientRect` into parent-document coordinates using the iframe's own `getBoundingClientRect()` offset and opens the comment dialog anchored near the selection. (Claude iter-2 finding #2.) |
| 3 | `persist-annotation` | parent → iframe | `{ id?, body: string, creator: {name, nickname} }` | User submitted the dialog. If `id` is present, update; else create. Iframe writes the JSON-LD entry, applies the highlight, then sends `content-changed`. |
| 4 | `delete-annotation` | parent → iframe | `{ id }` | User clicked delete in the panel. Iframe removes the entry, removes the highlight, sends `content-changed`. |
| 5 | `focus-annotation` | parent → iframe | `{ id }` | User clicked a panel item. Iframe scrolls the highlight into view and pulses it. |
| 6 | `content-changed` | iframe → parent | `{ html, annotations: [{id, body, creator, anchored: boolean}] }` | Authoritative new HTML and annotation list. Parent **MUST** atomically update both `currentContent = html` AND `fileLines = html.split('\n')` before calling `saveFile()`. The existing `saveFile()` in `open.html` serializes via `fileLines.join('\n')` — if `fileLines` is not refreshed, the save will write the **stale, pre-annotation** source to disk, silently dropping the new annotation. Then refresh the panel and call `saveFile()`. |
| 7 | `error` | iframe → parent | `{ code, message }` | Unrecoverable iframe-side error (malformed block on parse, cross-iframe selection rejected, etc.). Parent surfaces via toast. |

## Assumptions

- Apache Annotator (`@apache-annotator/dom@0.2.0`) bundles successfully as a single ESM/UMD file with its transitive deps (`@apache-annotator/selector`, `@medv/finder`, `@babel/runtime-corejs3`). See **Dependencies** for the version pin rationale and the policy on `0.3.0-dev.*` prereleases. The bundled file is expected to be in the ~50–150KB minified range. If bundling produces something disproportionately large (>500KB), this becomes a discussion point at plan time (vendor a subset, use a different matching library, etc.) — not a spec change.
- The existing save endpoint can handle the additional bytes added by the JSON-LD block without changes. (Save already does full-file writes of arbitrary size; HTML with a few annotations is unremarkable.)
- The bug-281+ family of tests that exercise `open.html` continue to pass unchanged. New tests are added; existing tests are not modified.

## Solution Approaches

### Approach 1: Inject annotator JS into the iframe via srcdoc rewriting (RECOMMENDED)

**Description**: Before assigning `iframe.srcdoc = currentContent`, the parent rewrites the HTML to inject a `<script>` tag containing the vendored Apache Annotator + a thin "iframe bridge" that:
- On load, reads `<script type="application/ld+json" id="codev-annotations">` from the iframe's own document, parses annotations, and applies highlights via Apache Annotator's `highlightText`.
- Listens to `selectionchange`/`mouseup` in the iframe, computes selectors via Apache Annotator's `describe` functions, and `postMessage`s the candidate selection to the parent.
- Receives `postMessage` instructions from the parent ("show comment dialog response: persist this annotation with id=X / delete annotation X") and updates highlights + the JSON-LD block accordingly.
- **Holds the pristine source HTML in a string variable** at iframe load (separate from the live DOM, which gets mutated by the bridge and Apache Annotator) and uses **string splicing** — not live-DOM serialization — to produce the saved HTML. This is critical: serializing the live iframe DOM would include the injected vendor script tags and Apache Annotator's `<mark>` wrappers in the saved file, corrupting it on every save.
- **Escapes `</script>` sequences when injecting the pristine HTML into the bridge script via template substitution.** If the bridge is built as `const pristine = ${JSON.stringify(currentContent)};` and the source HTML contains a literal `</script>` (e.g. inside a `<pre>` block of example code, or inside a comment), the browser's HTML parser will terminate the bridge `<script>` prematurely, breaking annotation entirely. The bridge MUST emit the pristine string with all `</script>` sequences escaped — e.g. `${JSON.stringify(currentContent).replace(/<\/script>/gi, '<\\/script>')}`. The escaped form parses identically in JavaScript but does not match the HTML parser's script-end pattern. (Gemini iter-2 finding #2.)
- Posts the spliced HTML back to the parent via `postMessage`; the parent treats this as the new `currentContent` and triggers the existing `saveFile()` path.

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

**Resolved (per architect feedback rev-3)**: Default for `.html`. Opening any `.html` file lands the user in **Preview mode with prose annotation active** — no CLI flag, no extension list, no user opt-in. The architect's intent is that prose annotation IS the headline experience for HTML once shipped; gating it behind two clicks would defeat the purpose. Source view (line-based mode) is one toolbar click away for users who need it. The CLI surface of `afx open` is unchanged — the default mode change happens client-side in `open.html`'s init path, keyed on file extension.

**Q2 (from issue): How are orphaned annotations surfaced when re-anchoring fails?**

**Proposed answer**: In the annotations panel, orphaned annotations render with:
- An `[orphaned]` badge in a warning color
- The captured `exact` quote shown in the panel item (so the user can find it manually)
- The comment text (so the user can decide whether to keep it)
- A delete button (same as in-anchor annotations)
- A "show in raw JSON-LD" affordance that scrolls the source view to the `<script>` block and highlights the entry, so the user can hand-edit the selector if they want to reattach it

Orphaned annotations are NOT auto-deleted. They persist in the JSON-LD block; they just don't apply a highlight. This is the safe default — annotations represent user intent and shouldn't disappear silently.

**Q3 (from issue): JSON-LD author info — pull from `git config user.name`?**

**Proposed answer**: Yes, with a fallback. The W3C model allows a `creator` field on each annotation. We populate it with `{ type: "Person", name: <git config user.name>, nickname: <git config user.email> }`. If `git config` returns nothing or the file is outside a git repo, fall back to `{ type: "Person", name: "anonymous" }`.

**Resolution mechanism (revised after consultation)**: Author info is resolved **at template render time**, not at save time. The existing tower route at `tower-routes.ts:2480+` already template-substitutes `{{FILE_PATH}}`, `{{LANG}}`, `{{IS_HTML}}`, etc. into `open.html`. Add `{{GIT_USER_NAME}}` and `{{GIT_USER_EMAIL}}` to that same substitution. The client uses these values to build the `creator` object before posting. This honors the "no new server endpoints" constraint and matches the existing template pattern.

Note: the existing line-based annotator (`open.html:1072`) hardcodes `(@architect)` for HTML/MD comments — it does NOT consult git config today. Pulling git config for the new prose mode is therefore strictly an improvement; it does not align with a pre-existing pattern (because that pattern is "hardcoded `@architect`" rather than "resolve from git"). The hardcoded `@architect` behavior in line mode is out of scope for this spec.

### Resolved by this revision (promoted from open question to requirement)

**Q4 (was Critical, now baked in)**: Source-view auto-refresh after a Preview-mode save is now a hard **Functional success criterion** (see above). When `togglePreviewMode()` switches from Preview back to source AND `currentContent` has changed since the last `renderFile()` call, `renderFile()` is re-invoked. This addresses Gemini's iter-1 observation that today's toggle is purely a CSS `display` flip and does not re-render. Edge case (revised per Claude iter-2 finding #3): line-based REVIEW comments in source view auto-save the moment the dialog is submitted (`saveComment()` calls `saveFile()` immediately at `open.html:1088`), so there is no class of "unsaved REVIEW comments" to reconcile. The only pending-edit class is **edit-mode textarea changes** tracked by the existing `hasUnsavedChanges` flag. If a user has pending edit-mode changes when switching to Preview, those are already part of `currentContent` and will be saved together with any prose annotation made in Preview. The `hasUnsavedChanges` warning UI continues to work unchanged.

**Q5 (Important)**: Should the new annotator support **annotating across iframe boundaries** (e.g., a selection that starts in one paragraph and ends in another that's inside a nested iframe)? **Resolved: no.** Apache Annotator handles single-document ranges. Nested iframes in user HTML are out of scope; selections that cross them are rejected with a toast ("Please select text within a single section.").

**Q6 (Important)**: How do we handle HTML files that already contain a `<script type="application/ld+json" id="codev-annotations">` block from a previous version of the annotator? **Resolved**: per the JSON-LD Contract section, annotations carry `codev:schemaVersion`. On read, unknown future versions surface a warning, render no highlights, and never overwrite the block. The `codev:` prefix is properly declared in `@context` to keep the document JSON-LD-valid.

### Still open (need architect input)

**Q7 (Nice-to-know)**: Should highlights be visually distinct between "your" annotations (current git user) and "others"? The W3C model carries `creator`, so we have the data. Proposed: **defer to a follow-up.** Ship visual parity first; per-author color is a UX refinement that doesn't block the primitive.

**Q8 (Important — raised by Codex review)**: Panel interaction in source view. The Functional criterion says "click a prose annotation in source mode scrolls to the JSON-LD line and flags it by `id`." But the JSON-LD is a single multi-line block — Prism's syntax-highlighted output may render it as one collapsed area. **Proposed**: scroll to the *start* of the JSON-LD `<script>` tag (one line address) and toast the annotation `id` and `exact` quote so the user can find it via Ctrl-F. If this proves clunky in practice (plan-phase feedback), we can refine to pretty-print the JSON-LD on output so each annotation is on its own line and we can scroll to a specific sub-line. Punt to plan unless the architect has a strong preference now.

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

1. **Happy path**: Open `test.html` (rendered as a paragraph of text) — file opens directly into Preview mode with prose annotation active (no toggle clicks required). Select the phrase "the quick brown fox". Enter comment "this is a classic pangram". Save. Inspect the file on disk: JSON-LD block contains one annotation with `exact: "the quick brown fox"`, matching prefix/suffix, matching position offsets, and the comment text. Close. Reopen → annotation re-anchors, `<mark>` overlay visible.

2. **Round-trip across edits (minor)**: Annotate "the quick brown fox". Save. In a text editor, change the surrounding paragraph's *first* sentence (text before the prefix). Reopen → annotation still anchors (prefix may shift but `exact` still matches uniquely).

3. **Round-trip across edits (orphaning)**: Annotate "the quick brown fox". Save. In a text editor, change "fox" to "dog" — the `exact` no longer matches. Reopen → annotation appears in panel with `[orphaned]` badge, captured quote, comment text intact.

4. **Multiple annotations**: Add three annotations on three different ranges. All persist. Reopening: all re-anchor.

5. **Delete from panel**: Click delete on an annotation. JSON-LD block updates, file saves, highlight disappears from the iframe.

6. **Source view auto-refresh after Preview save** (Q4 confirmation): With source view open, switch to Preview, add an annotation, switch back to source view → source shows the updated JSON-LD block.

7. **Malformed JSON-LD on load**: A file with `<script id="codev-annotations">{ malformed</script>` opens with a panel warning, no highlights, and a "repair manually" affordance. Subsequent saves do NOT overwrite the malformed block.

8. **No annotations block present**: Opening a clean HTML file shows the iframe normally; no JSON-LD block exists; first annotation creates the block.

9. **HTML without `<body>` tag**: Opening a fragment-style HTML file (e.g. just `<p>Hello</p>`) works — the injected script and JSON-LD block are appended to the document.

10. **Save purity** (script-leak prevention, Claude iter-2 finding #4): Open a clean HTML file, add an annotation, save, then re-read the file from disk (bypassing Codev). Assert the file content contains NEITHER injected vendor `<script src=".../apache-annotator..."` nor `<mark>` wrappers from highlight application — only the user's original markup plus the new `<script type="application/ld+json" id="codev-annotations">` block. This is the script-leak-prevention invariant from the Save / Persistence Model section, listed here as its own named scenario because the failure mode (silent file corruption on every save) is catastrophic.

11. **`</script>` literal in source HTML** (Gemini iter-2 finding #2): Open an HTML file whose body contains a literal `</script>` sequence inside a `<pre>` code-example block. Verify: the bridge does not abort, prose annotation works normally, and saves do not corrupt the file. Implementation must escape `</script>` to `<\/script>` when embedding `currentContent` into the bridge script.

### Non-Functional Tests

1. **Sandbox preserved**: After the change, `iframe.sandbox.value` is exactly `"allow-scripts"` — no `allow-same-origin`. Verified in an automated test (Playwright assertion on the rendered iframe attributes).

2. **`postMessage` origin check**: A test fires a `postMessage` from a non-iframe source with a valid-looking payload — parent ignores it.

3. **Headline path E2E (Playwright)**: scripted run of the issue's "End-to-end usability check" steps 1–6.

## Dependencies

### External Libraries (vendored)
- **`@apache-annotator/dom`** + transitive deps (`@apache-annotator/selector`, `@medv/finder`, `@babel/runtime-corejs3`): bundled into a single file at `packages/codev/templates/vendor/apache-annotator.min.js`. Apache-2.0; LICENSE + NOTICE files copied to the vendor directory.

  **Version**: pin to `0.2.0` (latest stable on npm as of 2026-05-24). The `0.3.0-dev.*` prerelease line exists but is not flagged stable; do not use `^0.3.0` (resolves to zero packages under standard semver). If the plan-phase investigation finds a required API in `0.3.0-dev.23` that's missing in `0.2.0`, document the swap to the explicit dev pin in the plan and surface to the architect for sign-off.

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
| Apache Annotator API changes between minor versions | Low | Low | Vendor pins `0.2.0` (exact). Vendor file committed to repo. Upgrades are deliberate; see **Dependencies** for the swap-to-`0.3.0-dev.*` escape hatch. |
| Iframe `postMessage` plumbing has subtle bugs across browsers | Low | Medium | E2E test in Playwright (Chromium baseline; same browser real users hit via Codev terminal). Manual smoke test in Safari before tagging release. |
| User edits the `<script id="codev-annotations">` block by hand and breaks JSON | Medium | Low | Graceful malformed-JSON handling: surface warning, don't overwrite. (Already in functional tests #7.) |
| Source-view + Preview-view divergence (Q4) confuses users | Low | Medium | Auto-refresh source view after Preview save (Q4 proposed answer). E2E covers it. |
| Apache-2.0 NOTICE compliance miss | Low | Medium | Plan phase explicitly includes copying LICENSE + NOTICE files to `vendor/` directory. Spec calls this out in Constraints. |
| Annotation `creator` leaks private email if a user shares an HTML file publicly | Low | Low | Author email comes from `git config user.email` (the same email already in commits the user pushes). Same trust boundary; no new exposure. Documented in security section. |

## Expert Consultation

### Iteration 1 (rev-2)

**Date**: 2026-05-24
**Models Consulted**: Gemini Pro, GPT-5 Codex, Claude Opus (3-way parallel review)

**Verdicts**:
- Gemini: REQUEST_CHANGES (2 sharp catches: hallucinated server-side `getAuthor()`, vendor-script leak on save)
- Codex: REQUEST_CHANGES (5 findings: author/save-route contradiction, panel-interaction gaps, JSON-LD contract under-specified, malformed-block write policy, Q4 should be a requirement)
- Claude: COMMENT (4 findings: wrong Apache Annotator version pin, Q3/save-route contradiction, malformed-block + new-annotation flow, postMessage protocol under-specified)

**Sections Updated based on consultation**:
- **JSON-LD Contract** (new section): exact shape, required fields, `@context` declaration, `codev:` namespace, schema-version policy. Addresses Codex#3, Claude#11.
- **Save / Persistence Model** (new section): clarifies the save endpoint is a dumb pipe; author resolution via template substitution at render time (`{{GIT_USER_NAME}}` / `{{GIT_USER_EMAIL}}`), not save-time mutation; iframe bridge uses **string splicing** on the pristine source HTML, never live-DOM serialization. Addresses Gemini#1, Gemini#2, Codex#1, Codex#4, Claude#8.
- **postMessage Protocol** (new section): 7-entry table of message types with direction and payload. Addresses Claude#12.
- **Success Criteria** (added 4 new bullets): source-view re-render on toggle, panel-click semantics, script-leak-free saves, disabled toggle on malformed block. Addresses Codex#2, Codex#5, Gemini#2, Gemini#3, Claude#9.
- **Q3** (revised): switched to template-substitution mechanism; explicitly notes the existing `@architect` hardcode is unchanged. Addresses Gemini#1, Claude#8.
- **Q4** (promoted from open question to baked-in requirement). Addresses Codex#5, Claude#13.
- **Q6** (resolved via `@context` design in JSON-LD Contract section).
- **Q8** (new — Codex#2 derivative — source-mode panel-click behavior).
- **Dependencies**: version pin corrected to `0.2.0` with explicit note that `^0.3.0` resolves to zero packages. Addresses Claude#7.
- **Approach 1**: added explicit string-splicing requirement. Addresses Gemini#2.

**Findings NOT incorporated as spec changes (deferred to plan)**:
- Claude#2 (`open.html` is 1843 lines — modularity concern). This is a plan-phase architecture call. Plan should consider whether to split the iframe bridge into a separate vendored module (`packages/codev/templates/vendor/codev-annotator-bridge.js`) bundled at build time, vs inlining in `open.html`. The spec just requires it to work; how to organize the code is a plan concern.
- Claude#10 (`highlightText` vs `highlightRange` API name): verified — `highlightText` is correct (confirmed against `apache/incubator-annotator` source at `packages/dom/src/highlight-text.ts`).

### Iteration 2 (rev-3) — architect inline-comment review

**Date**: 2026-05-27
**Reviewer**: Architect (inline `<!-- REVIEW(@architect): ... -->` comments on the rev-2 spec)

**Comments addressed**:
- **Default mode for HTML should be Preview** (was: source-view annotate). Spec rev-3 changes the default landing mode to Preview-with-prose-annotation. Source view still reachable via toolbar. Q1 resolution rewritten. Test scenarios + functional success criteria updated.
- **"Annotate prose" toggle should be on by default** (was: opt-in click). Spec rev-3 makes the toggle default-on; user can flip off to hide highlights without modifying the file. Functional criteria updated.
- **Unification concern** ("less concerned with prose vs line; more concerned with unified experience; ideally drop line annotations from markdown too"). Spec rev-3 adds a **Unification direction** subsection under Desired State that frames HTML-now as the headline mode, markdown-next as an explicit follow-up that the JSON-LD format is intentionally shaped to support without a contract change. The split is preserved for code (line-only) since code review is inherently line-anchored.
- **GitHub review concern** ("how do reviewers see html annotations in GitHub?"). Spec rev-3 adds a **GitHub Review Considerations** section documenting what's visible in PR diffs (annotation JSON fields are plain-text-readable: `body.value`, `selector.exact`, `creator.name`, `created`) versus what isn't (the `<mark>` overlays don't render; spatial context requires `gh pr checkout && afx open`). Two non-blocking future improvements listed.

**Re-consultation results**: A second 3-way parallel review (Gemini, Codex, Claude) was run after rev-3.

- **Gemini iter-2**: COMMENT (4 findings — 2 critical, 2 minor). All addressed.
- **Codex iter-2**: REQUEST_CHANGES (4 findings — version contradiction, malformed-block scope, line-annotation panel behavior in Preview, preview-save persistence). All addressed.
- **Claude iter-2**: COMMENT (4 findings — 1 was already fixed mid-flight; the other 3 minor — selection clientRect, Q4 rationale, save-purity test — addressed).

**Findings incorporated into rev-3 post-consult**:
- **Apache Annotator version pin** is now `0.2.0` everywhere (Assumptions, Dependencies, Risks). The earlier mixed `^0.3.0` / `0.2.0` mentions were stale copies from rev-1. (Codex#1, Claude#1.)
- **Block stability invariant** is now scoped to annotator-driven writes; user-driven source-mode hand-repair of malformed JSON-LD is explicitly allowed. (Codex#2.)
- **Line-annotation panel-click behavior in Preview mode**: clicking a line annotation in Preview implicitly switches to source view; a "↩ source" icon hints at this before the click. New functional success criterion. (Codex#3.)
- **postMessage `content-changed` row**: explicit requirement that parent MUST update both `currentContent` AND `fileLines = html.split('\n')` before `saveFile()` — without the `fileLines` refresh, `saveFile()`'s `fileLines.join('\n')` serialization writes pre-annotation source. (Codex#4, Gemini#1.)
- **`</script>` escaping in pristine HTML injection**: Approach 1 now mandates escaping `</script>` to `<\/script>` when embedding `currentContent` into the bridge script. (Gemini#2.)
- **Async refactor note for `handleWorkspaceAnnotate`**: Save / Persistence Model section now flags the required signature change to support awaiting `git config` lookups. (Gemini#3.)
- **`clientRect` in `selection` payload**: postMessage protocol row #2 now requires the iframe to include the selection's bounding rect for dialog positioning. (Claude#2.)
- **Q4 rationale**: corrected to reference edit-mode textarea changes (tracked by `hasUnsavedChanges`) rather than "unsaved REVIEW comments" — REVIEW comments save immediately on dialog submit. (Claude#3.)
- **Save purity test**: new functional scenario #10 explicitly asserts saved files contain no injected scripts/marks. (Claude#4.)
- **`</script>` literal test**: new functional scenario #11 covers the edge case of source HTML containing a literal `</script>` in a `<pre>` block.

**No iter-2 finding was rejected; all 12 findings across the three reviewers were either incorporated or already-correct in the current rev-3 spec (Gemini's `(@codev-skeleton/roles/architect.md)` reference appears to be a misread — the spec already states `(@architect)`, which I verified against `open.html:1072`).** Detailed dispositions in `843-specify-iter2-architect-rebuttal.md`.

## Approval

- [ ] Architect Review (rev-3)
- [ ] Expert AI Consultation Complete (Gemini, Codex, Claude) — rev-2 done; rev-3 re-run pending
- [ ] Open Questions Q7–Q8 resolved with architect (Q1–Q6 resolved per rev-3)

## Notes

- The new prose annotator is the **default mode for HTML** (per architect feedback rev-3). Source view (line-based) remains one click away in the toolbar — no functional regression for users who prefer it.
- Line-based REVIEW comments in pre-existing HTML files remain readable in the annotations panel (alongside JSON-LD annotations) and editable in source view. No migration tool is required; both formats coexist forever.
- Unification with markdown is **deferred to a follow-up spec**, not abandoned. The JSON-LD format is designed to be content-type-agnostic, so the same `<script type="application/ld+json">` model can apply to rendered markdown later without a format change.
- No GitHub PR will be opened per implementation phase; phases commit to the same branch, single PR at the end (per builder prompt's PR Strategy).

---

## Amendments

<!-- TICK amendments will be appended here -->
