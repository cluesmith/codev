# Rebuttal — Spec iteration 2: architect inline-comment review

The architect added 4 inline `<!-- REVIEW(@architect): ... -->` comments to the rev-2 spec at the `spec-approval` gate, on commit `f2a1fd39`. This document captures the disposition of each and the corresponding rev-3 changes.

**Disposition summary**: All 4 comments accepted in substance. Two were direct directives (default mode, default toggle state); two were design questions (unification, GitHub review) that the spec rev-3 now answers explicitly without ballooning scope.

---

## A1 — "Once we build this for html the preview mode should be the default"

**Position in rev-2**: At step 1 of Desired State, on the line "The file opens in source-view annotate mode (current behavior, unchanged — preserves the existing line-based workflow for users who want it)."

**Accepted**. Source-view annotate as the default for HTML was a conservative "additive, zero-regression" choice in rev-2. The architect's intent is that prose annotation IS the headline experience once shipped; if it lands behind two clicks, most users won't discover it and the line-based workflow stays the de facto default forever.

**Change in rev-3**: Desired State now opens with **"The file opens in Preview mode by default"** with prose annotation active on load. Source view reachable via toolbar (renamed "Preview" → paired "Source ↔ Preview" toggle). Q1 resolution rewritten to make this explicit. Functional success criteria updated. Happy-path test scenario no longer requires toggle clicks before annotation.

**Capability regression check**: None. Source view continues to work exactly as today (same code path, same line-based REVIEW-comment authoring); only the *default landing mode* for `.html` files changes. Markdown, code, image, video, PDF files are unchanged.

---

## A2 — "That should be on by default, similar to the code annotator"

**Position in rev-2**: At step 3 of Desired State, on the line introducing the "Annotate prose" toggle as opt-in.

**Accepted**. Same reasoning as A1: gating the headline mode behind a click defeats the purpose. The code annotator (line-based, in source view) doesn't require a toggle to annotate — the user just clicks a line. Symmetry suggests prose annotation should be similarly always-active in Preview mode.

**Change in rev-3**: The "Annotate prose" toggle is **on by default**. Flipping it off hides `<mark>` overlays and disables selection capture, but does NOT modify the JSON-LD block. Flipping back on restores both. This keeps a "read-without-distractions" affordance for users who want it, without making annotation an opt-in. Documented as a functional success criterion.

---

## A3 — "What if we only had prose annotations or just line annotations that could work with this? I am less concerned with prose vs line and more concerned with building a unified experience than line vs prose. Ideally we could get rid of line annotations from markdown too. Line annotations were just for the easy interface."

**Position in rev-2**: At step 3 of Desired State, on the line about prose annotations appearing alongside line annotations in the panel.

**Accepted in framing; deferred in scope (with explicit rationale)**. The architect's directional concern is correct: maintaining two parallel annotation models forever is a UX and code-organization tax. The aspirational end-state is prose annotations everywhere they make sense (HTML, rendered Markdown, possibly other rendered formats), with line annotations remaining only for what they're genuinely good at: code, where lines are the atomic unit.

**Why this spec stays HTML-only, not HTML-and-Markdown**:

1. **For HTML, rendered = source.** The iframe `srcdoc` is literally the file on disk. Selectors anchor to character offsets in the rendered DOM, which is also character offsets in the file. Round-trip is trivial.
2. **For Markdown, rendered ≠ source.** A selection in the rendered preview ("the **quick** brown fox", where "quick" is bold) corresponds to a markdown source range (`the **quick** brown fox`). The JSON-LD has to anchor to one or the other:
   - Anchor to **rendered** offsets: re-anchoring works when the source markdown is edited (because we re-render and re-match), BUT the JSON-LD itself can't live in the source `.md` file in a useful way — it'd have to live in a sidecar (`.md.annotations.json`) or appended HTML-comment block. That's a non-trivial design question: do we want sidecars in a previously-sidecar-free system?
   - Anchor to **source** offsets: defeats the prose-annotation goal — we'd be back to line/character anchoring on raw markdown source.
3. The **right** call is the rendered-offset + appended-HTML-comment-block design, but that requires its own spec because of how it interacts with markdown source-view annotation (the existing line-based mode) and with the "open in source-view by default for markdown" current behavior.

**Change in rev-3**: New **"Unification direction (HTML-now, Markdown-next)"** subsection under Desired State explicitly states:
- HTML is the headline mode now.
- Markdown unification is a deferred follow-up spec, not abandoned.
- The JSON-LD format is intentionally content-type-agnostic — selectors are character offsets in the rendered DOM, so the same storage shape extends to rendered markdown later without a contract change.
- Line-mode disposition: code keeps line annotations (best fit for code review); HTML keeps line annotations *readable* (no migration tool, no data loss) but the default authoring path becomes prose; markdown is unchanged in this spec.

**Notes** at the bottom of the spec restate this so future readers don't think the split is permanent.

---

## A4 — "One thing I'm worried about is being able to review html annotations in GitHub. How would that work?"

**Position in rev-2**: At the top of the Stakeholders section.

**Accepted**. This is a real concern that rev-2 did not address. GitHub will never run Codev's iframe annotator, so the question of "what does a reviewer see when they open a PR that adds HTML annotations" has to have an answer.

**The honest answer (now in rev-3 as a dedicated section, "GitHub Review Considerations")**:

What IS visible to GitHub reviewers:
- The JSON-LD diff. Every annotation appears as a JSON object inside the `<script type="application/ld+json" id="codev-annotations">` block. The fields most useful for review — `body[0].value` (the comment), `target.selector[0].exact` (the quoted text), `creator.name` (the author), `created` (timestamp) — are plain-text strings.
- The HTML source diff. Edits to the underlying markup appear as ordinary HTML diff hunks.
- A reviewer scanning the PR can read every annotation by glancing at the JSON-LD block; nothing is encoded or compressed.

What is NOT visible to GitHub reviewers:
- The `<mark>` highlights — they're applied client-side in Codev's iframe.
- The spatial context — "where in the rendered document is this annotation attached" requires `gh pr checkout && afx open path/to/file.html`. (Same workflow already used for reviewing line-based REVIEW comments on prose-heavy files today.)

Future improvements (out of scope for this spec, listed in the new section):
- A `codev annotations summarize <file>` CLI that prints a markdown index of annotations.
- An opt-in GitHub Action that auto-comments on PRs touching HTML files.

Neither is required for the headline case. They're listed in the spec so the GitHub-review limitation has documented mitigation paths if it becomes painful.

---

## Reconsult — results

A second 3-way parallel consult (Gemini, Codex, Claude) was run on rev-3 in parallel.

### Verdicts
- **Gemini iter-2**: COMMENT (4 findings — 2 critical: state-sync data loss, script-injection escaping; 2 minor: async refactor, alleged hardcode-string error)
- **Codex iter-2**: REQUEST_CHANGES (4 findings — version contradiction, malformed-block scope, line-annotation panel-click, preview-save persistence)
- **Claude iter-2**: COMMENT (4 findings — version contradiction, missing clientRect in postMessage, Q4 rationale wording, save-purity test gap)

### Dispositions (all 12 findings)

**Codex C1 (version contradiction)** + **Claude Cl1 (version contradiction)** — same issue, two reviewers caught it independently. **Accepted.** Apache Annotator version had stale `^0.3.0` mentions in Assumptions and Risks; Dependencies had the correct `0.2.0`. Now all three sections say `0.2.0` with a single pointer to the version pin rationale. (The earlier rev-2 fix only updated Dependencies; this rev-3 sweep finishes the job.)

**Codex C2 (malformed-block invariant scope)** — **Accepted.** The rev-2 invariant "all write paths refuse to overwrite a malformed block" is self-contradictory because it bans source-mode hand-repair, which is the user's only remedy. Refined: the invariant is scoped to **annotator-driven** write paths (Preview prose-annotation create/update/delete, iframe-bridge content-changed flow). User-driven source-mode saves continue to write `fileLines.join('\n')` verbatim — the user can always repair a broken block by hand.

**Codex C3 (line-annotation panel-click in Preview)** — **Accepted.** rev-2 left this undefined when the panel surfaces both prose and line annotations together. Rev-3: clicking a line annotation while Preview is active flips to source view and performs the existing source-grid line-scroll + pulse behavior. The panel item carries a "↩ source" icon hint so users see the mode switch coming.

**Codex C4 (preview-save persistence contract)** + **Gemini G1 (fileLines syncing)** — same issue, two reviewers caught it. **Accepted.** `saveFile()` in `open.html` serializes via `fileLines.join('\n')`. If the iframe's `content-changed` only updates `currentContent`, the save will write **stale, pre-annotation** source. postMessage protocol row #6 now explicitly mandates the parent updates BOTH `currentContent = html` AND `fileLines = html.split('\n')` before calling `saveFile()`.

**Gemini G2 (`</script>` escaping)** — **Accepted, critical**. Approach 1 originally said "hold pristine HTML in a string variable" without addressing how that string ends up in the injected bridge script. If embedded via `${JSON.stringify(currentContent)}`, an `</script>` literal in the source HTML (legitimate in `<pre>` example code) terminates the bridge script prematurely. Rev-3 mandates `.replace(/<\/script>/gi, '<\\/script>')` escaping. New test scenario #11 covers this.

**Gemini G3 (async refactor for `handleWorkspaceAnnotate`)** — **Accepted as implementation note.** Adding `{{GIT_USER_NAME}}` substitution requires `await`ing a `git config` subprocess. The route is currently sync (`void`); needs to become `async function ... returning Promise<void>`. Caller is already async, so the change is local. Rev-3 Save / Persistence Model section flags this.

**Gemini G4 (hardcode-string misread)** — **Rejected (factually incorrect)**. Gemini claimed the spec mistakenly says `open.html:1072` hardcodes `(@codev-skeleton/roles/architect.md)`. Verified via `grep`: the spec actually says `(@architect)` (matching the actual file). No change needed.

**Claude Cl2 (missing clientRect in selection payload)** — **Accepted.** The iframe is null-origin, so the parent cannot query `iframe.contentWindow.getSelection().getRangeAt(0).getBoundingClientRect()`. The iframe must include `clientRect: { top, left, width, height }` (iframe-viewport coords) in the `selection` postMessage; the parent transforms to parent-document coords via the iframe's own offset and anchors the comment dialog near the selection. Without this, the dialog appears at a fixed location, defeating the UX. postMessage protocol row #2 updated.

**Claude Cl3 (Q4 rationale references "unsaved REVIEW comments")** — **Accepted.** REVIEW comments auto-save the moment the dialog is submitted (`saveComment()` at `open.html:1088` calls `saveFile()` immediately). There is no class of "unsaved REVIEW comments." The Q4 rationale text was misleading even though the design conclusion (re-render on toggle if `currentContent` changed) was correct. Rev-3 reworded to reference edit-mode textarea changes tracked by `hasUnsavedChanges` — the only actual class of pending source-mode edits.

**Claude Cl4 (save-purity test scenario)** — **Accepted.** The script-leak-prevention invariant (saved file contains no injected vendor `<script>` tags or `<mark>` elements) was a functional success criterion but not a named test scenario. Failure mode is catastrophic (silent file corruption on every save). Rev-3 adds Functional Test #10 as an explicit scenario: open clean HTML → annotate → save → re-read file from disk → assert no injected scripts / marks.

### Net change vs rev-2 baseline

| Aspect | rev-2 | rev-3 |
|---|---|---|
| Default mode for `.html` | Source-view annotate | Preview-with-prose-annotation |
| Prose toggle state | Opt-in (off by default) | On by default |
| Unification framing | Implicit (HTML-only, line for code/MD) | Explicit (HTML-now, Markdown-next, code-line-forever) |
| GitHub review experience | Unaddressed | Documented section with future-improvements list |
| Apache Annotator pin | Mixed `^0.3.0` / `0.2.0` | Consistent `0.2.0` |
| Block stability scope | "All write paths" (self-contradictory) | Annotator-driven only; user hand-repair allowed |
| Line-annotation panel click in Preview | Undefined | Implicit mode-switch with iconographic hint |
| `fileLines` sync on `content-changed` | Implicit | Explicit: parent must update both `currentContent` AND `fileLines` |
| `</script>` injection escaping | Unspecified | Mandated with explicit regex |
| Async refactor for `handleWorkspaceAnnotate` | Unspecified | Flagged as required |
| `clientRect` in `selection` payload | Missing | Required |
| Q4 rationale | Misleading wording | Corrected |
| Save-purity test | Implicit | Explicit scenario #10 |
| `</script>` literal test | Missing | Explicit scenario #11 |

### Final state

All 4 architect inline comments addressed. All 12 cross-reviewer findings either incorporated (11) or correctly rejected as a misread (1). Spec is now ready for `spec-approval` gate signaling.
