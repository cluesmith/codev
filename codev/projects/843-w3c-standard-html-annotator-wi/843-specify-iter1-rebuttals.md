# Rebuttal — Spec iteration 1 review feedback

Reviews:
- `843-specify-iter1-gemini.txt` — REQUEST_CHANGES
- `843-specify-iter1-codex.txt` — REQUEST_CHANGES
- `843-specify-iter1-claude.txt` — COMMENT

**Disposition**: All substantive findings accepted and incorporated. No disagreements. Spec revised in commit `ed66a9f0` ("[Spec 843] Spec with multi-agent review").

---

## Gemini findings

### G1 — Hallucinated server-side `getAuthor()` mechanism (REQUEST_CHANGES)
> The spec claims line-based annotations use a `getAuthor()` mechanism in the server's save route... This is completely false. The existing `open.html` client simply hardcodes `(@architect)`.

**Accepted.** Verified against `packages/codev/templates/open.html:1072` — the existing line-based annotator literally hardcodes `(@architect)` and consults no git config. There is no server-side `getAuthor()` and `/save` is a dumb pass-through.

**Change**: Q3 rewritten to use **template substitution** (`{{GIT_USER_NAME}}` / `{{GIT_USER_EMAIL}}` injected at template render time in `tower-routes.ts:2480+`, alongside existing `{{FILE_PATH}}` / `{{LANG}}` substitutions). The client uses these to build `creator` before posting. Zero new server endpoints. Save route remains a dumb pipe.

Also added a new dedicated section **Save / Persistence Model** that codifies this and explicitly states the previous claim about a `getAuthor()` server-side mechanism was wrong.

### G2 — Injected vendor scripts will leak into saved file (REQUEST_CHANGES)
> If the iframe bridge simply serializes its DOM, it will save Codev's internal `<script src="vendor/apache-annotator.min.js">` tags directly into the user's source code on disk.

**Accepted.** This was the most important catch in any of the three reviews — it would manifest on the very first save.

**Change**: Approach 1 description revised to require the iframe bridge to **hold the pristine source HTML in a string variable** at load and use **string splicing** (not live-DOM serialization) when producing the saved HTML. Also enshrined as a Success Criterion: "Saved files round-trip correctly: the saved HTML on disk does NOT contain the injected vendor script tags." Added a dedicated paragraph "Iframe-to-disk round-trip — script-leak prevention" in the new **Save / Persistence Model** section.

### G3 — Source-view stale grid on toggle
> `togglePreviewMode()` in `open.html` currently just toggles CSS `display: grid|none`. It does not re-render the source view.

**Accepted.** Verified — `renderFile()` is not called during the toggle.

**Change**: Added as a hard Functional success criterion: "Switching from Preview back to source view after a prose-annotation save re-renders the source grid from the updated `currentContent`. **Required, not optional.**" Promoted Q4 from open question to baked-in requirement (also satisfies Codex#5).

---

## Codex findings

### C1 — Creator injection conflicts with the save-model claim (REQUEST_CHANGES)
> The spec says persistence reuses the existing full-file POST /save path with no new server behavior, but Q3 also says creator should be populated server-side...

**Accepted.** Same root issue as Gemini#1.

**Change**: Same as G1 — server-side `getAuthor()` removed; replaced with template substitution at render time. New **Save / Persistence Model** section makes the dumb-pipe constraint explicit and locates author resolution in the template-render path.

### C2 — Panel interaction semantics for prose annotations incomplete
> Does not clearly define what clicking an anchored prose item does in source mode vs preview mode...

**Accepted.**

**Change**: Added Success Criterion: "Clicking a prose annotation in the panel: if in Preview mode, scrolls the iframe to the highlight and pulses it; if in source mode, scrolls the source grid to the `<script id='codev-annotations'>` line and visually flags the entry by its `id`." Also added Q8 to surface the residual question (how to address a specific sub-entry within the JSON-LD block, given Prism collapses multi-line blocks).

### C3 — JSON-LD contract needs more specificity
> Does not define the namespace/context treatment for Codev-specific fields or the minimum required annotation fields/IDs/timestamps.

**Accepted.**

**Change**: New dedicated section **JSON-LD Contract** with: exact JSON example, declared `@context` (W3C anno.jsonld + `codev:` namespace IRI), required-fields list (`id` as `urn:uuid:*`, `type`, `created`, `modified`, `creator`, `body`, `target.selector` containing exactly one TextQuote + one TextPosition), and explicit Codev-extension policy (everything Codev-specific lives under the `codev:` namespace declared in `@context`).

### C4 — Malformed-block write policy
> Should be stated as a general requirement across preview saves, source edits, and deletions, otherwise an implementation could accidentally replace or drop the block while still satisfying most of the spec.

**Accepted.**

**Change**: New **Save / Persistence Model** section codifies this as a single invariant: "if `parse(existing block) === error`, the block is preserved byte-for-byte; the new annotation path is refused with a UI message. This applies uniformly — there is no save path that may overwrite a malformed block." Also added Success Criterion: "When the existing JSON-LD block is malformed, the 'Annotate prose' toggle is disabled with a tooltip and no save path touches the block." (This also satisfies Claude#9.)

### C5 — Q4 should be a hard requirement
> Because `open.html` already has edit mode, dirty-state tracking, and auto-reload behavior, this should be a firm requirement in the main body, not left pending.

**Accepted.**

**Change**: Q4 promoted from "open question" to baked-in Success Criterion. (Also satisfies Gemini#3.) Acknowledged Claude's subtle edge case (line-based REVIEW comment unsaved + prose save) in the resolved-question text.

---

## Claude findings

### CL1 — Apache Annotator `^0.3.0` doesn't exist as stable
> Latest stable is `0.2.0`. A `^0.3.0` caret range will resolve to zero packages.

**Accepted.** Verified against npm registry — `0.2.0` is the only stable; `0.3.0-dev.*` are prereleases.

**Change**: Dependencies section now pins `0.2.0` explicitly, calls out that `^0.3.0` resolves to zero packages under semver, and instructs plan phase to surface an explicit dev-pin swap to the architect if needed.

### CL2 — open.html is 1843 lines, modularity concern
> Adding ~300-500 more lines of tightly interleaved logic makes future maintenance harder.

**Acknowledged, deferred to plan phase.** This is a plan-architecture decision, not a spec change. Documented in Consultation Log under "Findings NOT incorporated as spec changes (deferred to plan)": plan should consider whether to vendor the iframe bridge as a separate file (`packages/codev/templates/vendor/codev-annotator-bridge.js`) bundled at build time.

### CL3 — Q4 race / edge case
> A user who added an unsaved line-based REVIEW comment in source mode, then switched to Preview and added a prose annotation, would have both changes saved together in `currentContent`. This is actually correct behavior — but the spec should acknowledge it explicitly.

**Accepted.**

**Change**: Resolved-Q4 text now calls out this exact case and notes the existing `hasUnsavedChanges` mechanism is extended to surface "Save changes including unsaved source edits?" in the confirmation when applicable.

### CL4 — Q3 author resolution architecture
> "Happens server-side in the save route" doesn't match the current save route's architecture... template-substitution at render time is the cleanest path.

**Accepted.** Same as Gemini#1 / Codex#1.

**Change**: Template-substitution mechanism adopted in revised Q3.

### CL5 — postMessage protocol needs more specificity
> What message types exist? What's the shape? Which direction does each flow?

**Accepted.**

**Change**: New dedicated section **postMessage Protocol** with a 7-row table (`ready`, `selection`, `persist-annotation`, `delete-annotation`, `focus-annotation`, `content-changed`, `error`), each row specifying direction, payload shape, and purpose. Origin/source validation rule (`__codevAnnotator: true` marker + `source === iframe.contentWindow`) called out above the table.

### CL6 — Malformed JSON-LD + new annotation flow
> What happens when the user adds a new prose annotation while the existing block is malformed?

**Accepted.**

**Change**: Spec'd: the "Annotate prose" toggle is disabled with tooltip ("Annotations block is malformed — fix in source view to re-enable") when the block fails to parse. User is directed to repair manually. (Same Success Criterion bullet as C4.)

### CL7 — `highlightText` may not be the actual API name
> The relevant function in `@apache-annotator/dom` is `highlightRange` (or `highlightText` in older API drafts).

**Verified — `highlightText` IS correct.** Confirmed by reading `apache/incubator-annotator` source: `packages/dom/src/highlight-text.ts` exports `export function highlightText(target: Node | Range, ...)`. Documented in Consultation Log.

### CL8 — Q5 toast wording
> "Selection crosses an iframe boundary" is somewhat technical.

**Accepted.**

**Change**: Toast text in resolved Q5 changed to "Please select text within a single section."

### CL9 — Q6 `codev:` namespace not valid JSON-LD without `@context`
> Either define a `@context` that includes the Codev namespace, or use a plain key outside the W3C annotation body.

**Accepted.**

**Change**: Resolved Q6 in the new **JSON-LD Contract** section by declaring `{ "codev": "https://codev.dev/ns/annotation#" }` in `@context`. Document remains JSON-LD-valid.

---

## Summary

| Reviewer | Verdict | Findings | All addressed? |
|---|---|---|---|
| Gemini | REQUEST_CHANGES | 3 (2 critical, 1 minor) | Yes |
| Codex | REQUEST_CHANGES | 5 | Yes |
| Claude | COMMENT | 9 (incl. nits) | 8 addressed; 1 (CL2 — modularity) deferred to plan phase as documented |

Spec revision committed as `ed66a9f0`. Net effect: spec gained 3 new structural sections (JSON-LD Contract, Save / Persistence Model, postMessage Protocol), 4 new Success Criteria, Q3 / Q4 / Q6 resolved, Q8 added.
