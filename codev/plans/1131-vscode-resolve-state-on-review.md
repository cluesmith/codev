# PIR Plan: Resolve state on REVIEW markers + builder workflow for signalling addressed

## Understanding

Two halves, one loop: *architect adds an unresolved comment → builder addresses it and marks it resolved → architect verifies at the gate.*

1. **Mechanic (vscode + shared codec).** A `REVIEW` marker needs a `resolved` state that both authoring surfaces (editor Comments-API threads and the markdown-preview canvas cards) can show and toggle. The state has to live somewhere on disk, so this issue owns the format decision.
2. **Workflow (protocol docs).** Today no builder-facing doc tells a builder that `<!-- REVIEW(@…): … -->` markers exist, let alone to address them or signal it. Verified: `grep REVIEW codev/roles/builder.md codev-skeleton/protocols/*/prompts/*.md` finds only the phase-name headings of `review.md`. Builders handle markers today only because Claude happens to notice them.

### Where things stand (verified against the tree, not the issue text)

The architect's 2026-08-14 rescope is correct: #1055 (PR #1132) shipped edit + preview-side delete, **not** a format v2. There are still no ids and no attributes.

- **Shared codec** (the one canonical parser): `packages/sdk/src/review-markers.ts`. It moved out of `codev-core` into `@cluesmith/codev-sdk/review-markers`. The regex is at `:67`: `/^(\s*)<!--\s*REVIEW\s*\(@([^)]+)\)\s*:\s*([\s\S]*?)\s*-->\s*$/`. Its exports: `parseReviewMarkers`, `serializeReviewMarker`, `rewriteReviewMarkerBody`, `matchesExpectedMarker`, `markerAppendLine`, `isReviewMarkerLine`.
- **Identity today** is *positional*: `ReviewMarker.markerLine` (the marker's physical line, `review-markers.ts:52`), plus an optimistic-concurrency check on author + body prefix (`matchesExpectedMarker`, `:155`). Edit/delete from the preview key off this (`preview-provider.ts:282-342`). The editor path keys off the thread's anchor line (`plan-review.ts:208-230`).
- **Who parses markers** (importers of `review-markers` plus local regexes):
  - `apps/vscode/src/markdown-preview/preview-provider.ts:38`: codec import.
  - `apps/vscode/src/comments/plan-review.ts:67`: a **local duplicate regex** (`REVIEW_COMMENT_PATTERN`) that builds editor threads. A second local regex sits in the delete guard at `:283`.
  - `apps/vscode/src/review-decorations.ts:3`: a loose `REVIEW\s*\([^)]*\)` highlight.
  - `packages/artifact-canvas/src/renderer/renderer.ts:58`: strips *any* full-line `<!-- … -->` before rendering, so it is format-agnostic.
  - No dashboard (`apps/web`) or Tower code parses markers today. `canvas-relay.ts` relays traversal commands only.
  - **So "cross-host" in practice means:** (a) an *older installed VS Code extension* on another teammate's machine opening the same repo, (b) agents and humans reading and editing the raw markdown, and (c) a future dashboard host that pins an older `codev-sdk`.
- **Rendering consumers:**
  - Canvas cards: `ArtifactCanvas.tsx:133-229` (`buildMarkerCards`, with edit/delete actions via `data-action`).
  - Minimap: `overlays/MarkerMinimap.tsx` (#863, closed/shipped).
  - **#860 (summary view) is still OPEN and unbuilt.** There is no summary to add an "unresolved only" filter to, so that bullet is out of scope here (see Deferred).
- **Builder docs:**
  - Role doc: `codev/roles/builder.md` (117 lines).
  - Implement prompts: `codev/protocols/{pir,spir,aspir,air}/prompts/implement.md`.
  - PIR's plan prompt: `codev/protocols/pir/prompts/plan.md`. Plan-gate feedback is the most common place markers land.
  - Each of these is **byte-identical** to its `codev-skeleton/` twin today (verified with `diff -q`), so every edit lands in both.

## Plan-gate decisions

### Decision 1: Format mechanism (the core choice)

The deciding constraint is the architect's rescope point 2: *a v2 tag is invisible to v1 consumers, and a changed v1 shape corrupts them.* I traced each option through the **current shipped** codec and editor regexes, because that is exactly what an older installed extension runs:

| Option | Old extension sees it? | Old extension edits/deletes/appends safely? | Migration | Builder edit ergonomics | Identity needed? |
|---|---|---|---|---|---|
| **1. New tag** `<!-- REVIEWv2(id=…, @amr, resolved=false): … -->` | **No.** Comments vanish from old hosts entirely. | n/a (invisible) | Yes: rewrite on write, or dual-parse forever. | OK | Introduces ids (new invariant to maintain). |
| **2. Companion marker** `<!-- RESOLVED(@x): note -->` on the line after its REVIEW | Yes for the REVIEW itself. | **No, two silent breakages.** (a) `parseReviewMarkers` walks the anchor up over REVIEW lines only, so a REVIEW stacked *below* a RESOLVED line anchors to the RESOLVED line. The renderer strips that line, so there is no `data-line` element and the old canvas silently drops the card. (b) `markerAppendLine` stops at the RESOLVED line, so an old host appends a new comment *between* a REVIEW and the next one. Deleting a REVIEW on an old host also orphans its RESOLVED. | None | Must insert a correctly placed second line. | Pairing by adjacency (fragile under the old-host edits above). |
| **3. Sidecar** `.review-state.json` | Yes (markers unchanged). | Yes, but state silently detaches. | None | Edits two files in sync. | **Yes: needs stable ids**, which markers do not have. Keying by line or body breaks on any edit. |
| **1′. In-tag attribute, same `REVIEW` tag (recommended)** `<!-- REVIEW(@amr, resolved): … -->` | **Yes.** The current regex's `\(@([^)]+)\)` captures `amr, resolved` as the author string. | **Yes.** `isReviewMarkerLine` matches, so stacking, append and anchor logic are intact. `rewriteReviewMarkerBody` re-serializes the captured author verbatim, so the state survives an old-host edit. `matchesExpectedMarker` compares that same string on both sides. The delete-guard regex matches. The renderer strips the line. `review-decorations` highlights it. | **None.** Unresolved markers stay byte-identical v1. | Add or remove `, resolved` inside the parens. A one-token edit an agent cannot misplace. | **No.** State is co-located with the marker, so the existing positional identity (`markerLine` + verify) suffices. |

**Recommendation: 1′.** It is option 1's "extended attribute" idea without the new tag:
- **Graceful degradation instead of invisibility.** The worst an older extension does is display the author as `amr, resolved`. That is cosmetic and still *legible*: a human on an old host can see the comment is resolved.
- **No migration, no dual parsing.**
- **No second line to keep adjacent, no second file to keep in sync.**

**Grammar:**
- Inside the parens, `@author` comes first, optionally followed by comma-separated attributes: `REVIEW(@author[, attr]*)`.
- This issue defines exactly one attribute, the bare flag `resolved`.
- Unknown attributes (bare flags or `key=value`) are **parsed, preserved verbatim in original order on rewrite, and ignored**. The full grammar is pinned in section A (C4). That reserves the slot for a future `id=…` *if* a real requirement for out-of-band identity ever appears. No id is minted now.
- The author is the first comma-separated token. GitHub logins cannot contain commas or spaces, so the split is unambiguous.

**On "stable identity is now in scope"** (rescope point 1): I examined it and recommend *not* minting ids. Ids are only required when state lives *away* from the marker (option 3) or when something references a marker across files or sessions. Nothing in scope does either. Edit, delete and resolve all act on a marker the user is looking at, and the shipped `markerLine` + author/body-prefix verify already makes those race-safe. If the gate wants ids anyway, the reserved attribute slot makes `id=` additive later without a format break.

*Alternative inside 1′:* record who resolved it (`resolved=@builder`). Rejected for v1: builders share the human's GitHub identity, so the field would carry no trust signal, and the "who and why" belongs in the builder thread and commit (see Decision 3).

### Decision 2: Who may resolve: Model B (builder-can-resolve), as the issue recommends

The builder flips `resolved` when it has addressed the feedback. The architect verifies at the next human gate. Model A (architect-only) needs a round-trip per comment and defeats autonomous PIR/ASPIR. The UI does not enforce roles: anyone with the file can toggle, as with edit/delete today.

### Decision 3: How a builder signals "can't / won't address"

**Recommendation:** leave the marker **unresolved**, and record the reason in the builder thread (`codev/state/<id>_thread.md`) and in the gate-summary message to the architect. No third state, no extra marker.
- This keeps the on-disk vocabulary at one bit.
- The architect already reads the thread and the gate summary.
- A visible "still unresolved" marker is precisely the prompt the architect needs.

*Alternative:* a `blocked` attribute (cheap under 1′'s grammar). Deferred unless the gate wants it.

### Decision 4: Trust boundary (named explicitly in the role doc)

`resolved` is a **claim, not a proof**.
- The builder role doc says verification is expected.
- The gate prompts say to list the markers you resolved in the gate summary, so the architect can spot-check each against the diff.
- One line in `codev/roles/architect.md` (both trees) tells the architect to spot-check resolved markers at plan/dev/pr gates. Flagged as a small optional addition; drop it if the gate prefers builder-docs only.

### Decision 5: One resolve model for diff comments too? (proposal only, per lane brief)

#1562 owns the diff-comment queue (`review-queue/*`), and I do not touch it. *Proposal for the architect:* if diff comments later want a resolved state, they should reuse the same vocabulary (a boolean `resolved`, builder-can-resolve, architect verifies at the gate) so builders learn one rule. Nothing in this plan depends on that.

## Contract-surface sections (flag for routing to main before the gate)

- **[CONTRACT: sdk] `packages/sdk/src/review-markers.ts`** is the shared on-disk codec and the canonical marker parser. The lane brief calls it "codev-core's marker parser"; it now lives in `@cluesmith/codev-sdk`.
- **[artifact-canvas public API, architect:vscode's surface, not main's] `packages/artifact-canvas/src/types.ts`**: an additive spec-945 contract amendment. It adds an optional `resolved` field to `ReviewMarker` and an optional `onToggleResolved` prop.
- **No `codev-types` change.**

## Proposed Change

### A. Codec (`packages/sdk/src/review-markers.ts`) [CONTRACT: sdk, APPROVED by main with five conditions, folded in below as C1–C5]

- **C4: attribute grammar, pinned in the module doc comment.** The full paren contents are `@author` followed by `(, attr)*`:
  - **Author:** `@` up to the first comma or the close paren, trimmed. GitHub logins cannot contain a comma, so the first-comma split is safe. Bodies come after the colon, so commas in a body are unaffected.
  - **Attributes:** the remainder, split on commas and trimmed. Each one is either a bare flag (`resolved`) or `key=value` (the reserved `id=…`).
  - **Unknown attributes** are preserved **verbatim** and re-emitted in their **original order**, to minimize diffs.
  - The grammar is defined now, so a later `id=` never needs another format break.
- **Regex.** Keep the tag and shape. Capture group 2 (the paren contents) is split per C4 into `author` and `attrs: string[]` (the verbatim tokens, in order).
- **`ReviewMarker`** gains `resolved: boolean`: true iff some attr equals `resolved` (trimmed, case-insensitive). The `author` field is the **parsed** author only.
- **C3: `serializeReviewMarker(author, body, indent = '', attrs: string[] = [])`.**
  - The no-attrs path must be **byte-identical to v1**: exactly `<!-- REVIEW(@author): body -->`.
  - With attrs, the output is `<!-- REVIEW(@author, a1, a2): body -->`.
- **C2: `rewriteReviewMarkerBody`** carries the parsed author **and every attr** (`resolved` plus unknowns, verbatim, in order) through to `serializeReviewMarker`. A body edit never drops state.
- **New `setReviewMarkerResolved(lineText, resolved): string | null`.**
  - Adds the canonical `resolved` attr (appended after the existing attrs) or removes every `resolved` token.
  - It preserves the author, indent, other attrs (verbatim, in order) and the body *verbatim*: no re-normalization, so a hand-authored body is not reflowed by a toggle.
  - It returns `null` for a non-marker line, and it is idempotent.
- **C1: `matchesExpectedMarker`** compares `expectedAuthor` against the **parsed** author, not the raw paren capture.
  - Today it does `m[2] !== expectedAuthor`. Once `m[2]` is `amr, resolved`, a new-parser surface passing `expectedAuthor='amr'` would falsely mismatch, refuse the write, and wrongly report the file changed. This is the edit/delete correctness seam.
- **C5: purity.** `review-markers.ts` stays pure: no new imports, no `node:*`, no DOM. The sdk environment-agnostic boundary tests must stay green.
- **Lockstep (main's note + architect:vscode's ruling).** The sdk `ReviewMarker` and the artifact-canvas `ReviewMarker` are structurally coupled by convention. Both gain `resolved` **in the same phase and the same commit series** (sections A and D land together, never a phase apart).
- **Why the same tag degrades safely in both directions on an older parser** (main's reasoning, on record):
  - The current regex captures `(@[^)]+)` as the author, so an old parser reads `author='amr, resolved'`. That is cosmetic only.
  - Its edit/delete still work. `matchesExpectedMarker` sees `expectedAuthor='amr, resolved' == m[2]`. `rewriteReviewMarkerBody` reads `author='amr, resolved'` and re-serializes it, so the `resolved` attr **survives an old-parser body edit by construction**.
  - A separate tag or an out-of-paren attribute would lose either the byte-identical property or this graceful degradation.
- **Tests:**
  - **C1:** a resolved marker edits *and* deletes cleanly through `matchesExpectedMarker` with `expectedAuthor` set to the bare author. A mismatched author still refuses.
  - **C2:** editing a resolved marker's body leaves it still resolved. Editing a marker that carries an unknown attr (e.g. `id=abc`) retains the attr verbatim and in its original position.
  - **C3:** parse→serialize of a v1 marker is **byte-identical**. Parse→serialize of a resolved marker is stable and idempotent (serializing twice gives identical bytes).
  - **C4:** grammar cases:
    - `@a,resolved` (no space), `@a, resolved, id=x`, and `@a, id=x, resolved` all keep their order.
    - A body containing commas and parens is unaffected.
    - Whitespace tolerance.
  - **C5:** the existing sdk boundary tests stay green, and no import is added.
  - A toggle preserves the body byte-for-byte and is idempotent. Unresolve removes only the `resolved` token.
  - **A pinned "old-host" test** runs the *pre-change* regex (copied as a fixture) against a resolved marker. It asserts:
    - (a) the line still matches as a REVIEW marker;
    - (b) the old `rewriteReviewMarkerBody` logic preserves `, resolved`;
    - (c) the old `matchesExpectedMarker` logic accepts `expectedAuthor='amr, resolved'`.

    This makes the cross-host claim executable.

### B. Editor Comments-API (`apps/vscode/src/comments/plan-review.ts`)

- **Delete the local `REVIEW_COMMENT_PATTERN`** (`:67`) and build threads from `parseReviewMarkers(text)`, anchoring each thread at `markerLine`.
  - A single source of truth: with the local regex left in place, the author would display as `amr, resolved`.
  - The delete guard (`:283`) switches to `isReviewMarkerLine`.
- **Threads:**
  - Set `thread.state = vscode.CommentThreadState.Resolved | Unresolved` from `marker.resolved`. Engine `^1.128` has the API.
  - Set `thread.contextValue = 'inline-review-resolved' | 'inline-review-unresolved'`.
- **New commands** `codev.resolveReviewComment` / `codev.unresolveReviewComment`. They rewrite the anchor line via `setReviewMarkerResolved` after re-confirming that the line is a marker, the same guard as save/delete.
- **`package.json`:**
  - Command entries.
  - `comments/commentThread/title` menu items gated on the new contextValues.
  - Existing `commentThread == inline-review` `when` clauses become `commentThread =~ /^inline-review/` so delete keeps showing.
  - This touches only the commands + `comments/*` menu blocks, not pir-1566's `viewsContainers` block.
- Command registration lives inside `activateReviewComments`, so `extension.ts` needs no new hunk.

### C. Preview canvas host (`apps/vscode/src/markdown-preview/`)

- `messages.ts`: new `WebviewToHostMessage` variant `{ type: 'toggleResolved', markerLine, expectedAuthor, expectedBodyPrefix, resolved }`.
- `preview-provider.ts`:
  - Validate the payload at runtime, as for edit/delete.
  - New exported `toggleReviewMarkerResolved(...)` reuses `verifyReviewMarker` (the race → refresh + info message), then applies `setReviewMarkerResolved`.
- `webview/main.ts`: pass `onToggleResolved` through to `<ArtifactCanvas>` and post the message.

### D. Canvas package (`packages/artifact-canvas/`) [CONTRACT: artifact-canvas]

- **`types.ts`:**
  - `ReviewMarker.resolved?: boolean` (optional, so read-only hosts are unaffected).
  - `ArtifactCanvasProps.onToggleResolved?(markerLine, expectedAuthor, expectedBodyPrefix, resolved)`.
  - A contract-amendment note in the header comment, matching the #1053/#1055 precedent.
- **`ArtifactCanvas.tsx` `buildMarkerCards`:**
  - A resolved card gets `codev-canvas-marker-card--resolved` and a "Resolved" label (text, not color alone, for a11y).
  - When `onToggleResolved` is supplied and `markerLine` is known, a resolve/unresolve action button is added beside edit/delete, routed through the existing delegated `data-action` handler.
- **`MarkerMinimap.tsx`:** resolved dots get `codev-canvas-minimap-dot--resolved`, and the tooltip is prefixed with "(resolved)".
- **`styles/default-theme.css`:** dimmed card and dot styles, via a new `--codev-canvas-marker-resolved-opacity` token documented with the others.
- The card ordering and anchoring logic is unchanged.

### E. Builder workflow docs (both `codev/` and `codev-skeleton/`, kept byte-identical)

- **`roles/builder.md`:** new section **"Review markers"** (~12 lines):
  - Reviewers leave `<!-- REVIEW(@who): … -->` lines in your spec, plan and review files, and occasionally in code.
  - Find them with `grep -rn "REVIEW(@" codev/specs/<id>* codev/plans/<id>* codev/reviews/<id>*`.
  - Address each marker. When it is addressed, mark it resolved by changing `REVIEW(@who)` to `REVIEW(@who, resolved)`. Never delete a reviewer's marker, and never edit its body.
  - If you can't or won't address one, leave it unresolved and say why in your thread and in your gate message.
  - Resolved is a claim the architect verifies at the gate, so list what you resolved.
- **`protocols/pir/prompts/plan.md`** ("Handling Feedback"): add a step to check the plan file for REVIEW markers, address them, and resolve or explain each.
- **`protocols/pir/prompts/implement.md`:**
  - Resumption step 2 "Check for feedback": add a REVIEW-marker grep.
  - Process §1 "Re-Read the Plan": address outstanding markers on the plan and spec.
  - §7 gate summary: list the resolved markers and any left unresolved.
- **`protocols/{spir,aspir}/prompts/implement.md`, `protocols/air/prompts/implement.md`:** the same one-step addition in their re-read or feedback step.
- **`roles/architect.md`:** one line on spot-checking resolved markers at gates (Decision 4, optional).
- Because the role doc covers *how to resolve*, the prompts stay short and point back to it. This is inlined content, not an instruction to fetch a path.

### F. Docs

- `apps/vscode/README.md:201`: "Inline threads" line mentions resolve/unresolve.
- `packages/artifact-canvas/README.md`: document `resolved` and `onToggleResolved`.
- `codev/resources/arch.md`: the #859 entry's invariant (1) gains one sentence on the attribute grammar and the old-host degradation guarantee.
- No CHANGELOG entries (they are the architect's, post-merge).

## Files to Change

- `packages/sdk/src/review-markers.ts` (whole module: regex split, `resolved`, attrs, `setReviewMarkerResolved`) **[CONTRACT]**
- `packages/sdk/src/__tests__/review-markers.test.ts` (new cases: C1–C5, plus the pinned old-regex compat test)
- `packages/artifact-canvas/src/types.ts:38-56, 66-126` (`resolved?`, `onToggleResolved?`, amendment note) **[CONTRACT]**
- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx:133-245` (card class, label, toggle action) and the delegated click handler
- `packages/artifact-canvas/src/overlays/MarkerMinimap.tsx:75-90` (resolved dot class, tooltip)
- `packages/artifact-canvas/src/styles/default-theme.css` (~`:361`, ~`:673`: resolved styles + token)
- `packages/artifact-canvas/src/components/__tests__/marker-card-resolve.test.tsx` (new), `overlays/__tests__/marker-minimap.test.tsx` (extend)
- `apps/vscode/src/comments/plan-review.ts:67, 92-126, 283` (codec-driven threads, `state`, `contextValue`, resolve commands)
- `apps/vscode/src/markdown-preview/messages.ts` (`toggleResolved` variant)
- `apps/vscode/src/markdown-preview/preview-provider.ts:193-215` (handler) plus the new `toggleReviewMarkerResolved` near `:282`
- `apps/vscode/src/markdown-preview/webview/main.ts` (wire `onToggleResolved`)
- `apps/vscode/package.json` (two commands, `comments/commentThread/title` menu items, `when`-clause regex)
- `apps/vscode/src/__tests__/plan-review-resolve.test.ts` (new), `apps/vscode/src/__tests__/preview-edit-delete.test.ts` (extend with toggle + race)
- `codev/roles/builder.md` and `codev-skeleton/roles/builder.md` (new "Review markers" section, byte-identical)
- `codev/roles/architect.md` and `codev-skeleton/roles/architect.md` (one line, optional per Decision 4, byte-identical)
- Protocol prompts. Each pair is edited byte-identically, and the twins are verified with `diff -q` before commit:
  - `codev/protocols/pir/prompts/plan.md` and `codev-skeleton/protocols/pir/prompts/plan.md`
  - `codev/protocols/pir/prompts/implement.md` and `codev-skeleton/protocols/pir/prompts/implement.md`
  - `codev/protocols/spir/prompts/implement.md` and `codev-skeleton/protocols/spir/prompts/implement.md`
  - `codev/protocols/aspir/prompts/implement.md` and `codev-skeleton/protocols/aspir/prompts/implement.md`
  - `codev/protocols/air/prompts/implement.md` and `codev-skeleton/protocols/air/prompts/implement.md`
- `apps/vscode/README.md:201`, `packages/artifact-canvas/README.md`, `codev/resources/arch.md` (#859 entry)
- `codev/state/pir-1131_thread.md` (builder thread)

**Not touched (lane fences):** `review-queue/*` (#1562/#1559), `comments/builder-review.ts` (#1560), `command-relay.ts`/`commands/diff-nav.ts` (#1546), and pir-1566's views/`viewsContainers`. `extension.ts` needs no change.

## Risks & Alternatives Considered

- **Risk: an old extension displays the author as `amr, resolved`.** This is accepted and documented as cosmetic degradation (still legible). It is the price of not hiding comments from old hosts (option 1) and not breaking their anchoring (option 2).
- **Risk: an old extension's *edit* of a resolved marker.** It re-serializes the captured `amr, resolved` verbatim, so the state is preserved. This is covered by the pinned old-regex test reasoning.
- **Risk: hand-authored variants** (`REVIEW(@amr,resolved)`, `REVIEW(@amr, Resolved )`). The parser trims tokens and matches `resolved` case-insensitively. The serializer always writes the canonical `, resolved`.
- **Risk: a builder over-claims resolved.** Decision 4: the role doc says it is a claim, the gate summary lists the claims, and the architect spot-checks them.
- **Risk: an extension.ts or package.json merge with sibling lanes.** No `extension.ts` hunk; the `package.json` edits are confined to command and comment-menu entries. I will merge main before the PR.
- **Risk: switching the editor path to the codec changes thread anchoring.** `markerLine` is the same physical line the old regex anchored at (`positionAt(match.index)` on a single-line marker), so behavior is equivalent. The existing `plan-review-*` tests must stay green unchanged.
- Alternatives 1, 2 and 3 are analyzed in Decision 1's table.
- **Alternative: summary "unresolved only" filter.** Deferred, because #860 is unbuilt. When #860 lands it reads `marker.resolved` from the same codec at no extra cost.

## Deferred / out of scope

- #860 summary filter (no summary exists yet).
- Diff-comment (review-queue) resolve state: #1562's lane (see Decision 5's proposal).
- Stable marker ids: not required by anything in scope. The attribute slot is reserved (Decision 1).
- Canvas remote-command verbs (spec 1401) for resolve.

## Test Plan

**Unit / automated (run from the worktree):**
- `packages/sdk`:
  - Main's conditions C1–C5, as listed in section A's Tests: parsed-author concurrency; attrs survive a body edit; byte-identical v1 round-trip plus idempotent resolved round-trip; grammar cases; purity.
  - `resolved` parse; toggle idempotent and body-verbatim.
  - The pinned pre-change-regex compat test.
  - Lockstep check: the canvas `ReviewMarker` type accepts the sdk `ReviewMarker` (a compile-time assignability assertion in the vscode host, where both meet).
- `packages/artifact-canvas`: a resolved card gets the dim class + "Resolved" label; the toggle button appears only with `onToggleResolved` + `markerLine`; a click emits the right payload; minimap dots get the resolved class; read-only hosts are unchanged.
- `apps/vscode`: threads built from the codec carry the correct `state`/`contextValue` and a clean author; the resolve/unresolve commands rewrite the line and refuse a non-marker line; the preview `toggleResolved` race path refreshes instead of writing; the existing `plan-review-edit`, `plan-review-append` and `preview-edit-delete` suites still pass.
- `pnpm build` + `check-types` across the touched packages, not just vitest.

**Manual (dev-approval gate, the full loop):**
1. Open this worktree's `codev/plans/…` file in the editor. Add a comment via the gutter `+`. It appears as an **Unresolved** thread, and the on-disk line is plain v1 `<!-- REVIEW(@you): … -->`.
2. Click **Resolve** in the thread title. The line becomes `<!-- REVIEW(@you, resolved): … -->`, and VS Code shows the thread as Resolved. Click **Unresolve** to revert it.
3. "Reopen With… Codev Markdown Preview". The resolved card renders dimmed with a "Resolved" label, and its minimap dot is dimmed. Toggle from the card and watch the editor thread follow.
4. Race: edit the marker line by hand in the editor, then click toggle on the stale card. You get the "changed since you opened it" refresh, with no write.
5. Workflow: in a scratch PIR builder (or by reading the rendered prompt via `porch next`), confirm the plan/implement prompts and the role doc instruct finding, resolving and explaining markers, and that a builder's resolve edit (`, resolved`) renders as resolved.
6. Cross-host spot check: open a file with a resolved marker in the **currently released** extension. The comment still renders, with the author shown as `you, resolved`, and edit/delete still work.
