# Plan 1401 — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES.

Both REQUEST_CHANGES reviews were code-verified and correct. I re-verified every load-bearing
claim against the worktree before acting rather than trusting the summaries, and all six held.
The plan was restructured accordingly (5 phases became 6). Nothing is contested; one item is
accepted with a different remedy than the reviewer proposed, and one surfaced a factual error
in the approved spec that I am flagging rather than silently papering over.

## Verified before acting

| Claim | Verified |
|---|---|
| `packages/codev` cannot runtime-import `codev-types` | Yes: `command-relay.ts:24-29` documents it and re-declares `COMMAND_ROUTE` for exactly this reason |
| `supportsMultipleEditorsPerDocument: false` | Yes: `apps/vscode/src/extension.ts:1404` |
| `MarkdownPreviewProvider` built without `ConnectionManager` | Yes: `extension.ts:1401` |
| A guard under `packages/types/src/` would ship | Yes: `include: ["src/**/*"]`, `rootDir: ./src`, `files: ["src","dist"]` |
| `webview/` excluded from the extension typecheck | Yes: `apps/vscode/tsconfig.json:11` |
| Webview `markerAdapter.add` is a no-op | Yes: `webview/main.ts`, "Never called from the webview" |

## Claude (REQUEST_CHANGES)

**1. (Blocker) The runtime traversal classification is unimportable by both consumers.**
Accepted, and it was the right catch: the plan asserted a shared runtime helper that could not
have compiled in either place. `TraversalCommand` is now a **type-level** classification, and
each consumer declares its own `const` list bound to it with `satisfies`, so drift is a compile
error rather than a shared import that cannot exist. Phase 4 now also states that Tower
re-declares the route and event literals locally, matching `command-relay.ts`.

**2. (Blocker) Phase 2's "pure extraction" framing hid ~6 commands of new work, and two files
were missing.** Accepted, with a stronger remedy than proposed. The reviewer suggested
splitting the deliverable; I split the **phase**, because the plan template requires each phase
to be a single atomic commit and "extraction and new work must not share a commit" cannot hold
inside one phase. Phase 2 is now pure extraction with the unmodified test suite as its oracle;
Phase 3 newly authors `block-next/prev`, `reading-mode-toggle`, and the composer submit/cancel
seam. `CommentComposer.tsx` and `ReadingModeToggle.tsx` are in the Phase 3 file list, and the
column-paging note about geometry work is recorded in Phase 2.

**3. The type-test file would be published.** Accepted. It moves to
`packages/types/type-tests/` with its own tsconfig and `check-types:tests` script, plus an
acceptance criterion that it is absent from `dist/` after a build. An `exclude` was explicitly
rejected for the reason given: it would drop the guard from the check it exists to perform.

**4. The cursor duplicates `activeLine` without saying so.** Accepted. Phase 3 now states the
cursor is deliberately separate state and documents the distinction at both declarations:
`activeLine` is hover-driven and cleared on mouseleave because it positions the "+" affordance;
the cursor is focus-derived and persistent because it is the navigation origin.

**5. The `count` criterion was unfalsifiable ("ignored or rejected").** Accepted. The canvas
ignores; Tower rejects. Tower is the validator per the spec, and a command reaching the canvas
has already passed validation.

**6. Phase 6 `check-types` covers nothing in the webview.** Accepted. Stated plainly in the
test plan, with the manual pass named as load-bearing evidence for that file rather than a
formality. Adding the webview to the typecheck was considered and rejected as scope creep on a
pre-existing exclusion.

**7. The `MarkerAdapter` wording would send a builder to the wrong file.** Accepted; the
acceptance criterion now names the real path (`onAddComment` intent → `postMessage` → host
write-back) and says so explicitly.

## Codex (REQUEST_CHANGES)

Items 1, 2, 6 and 7 overlap with the above (runtime-versus-type-only classification, the
composer seam and its missing file, the typed SSE event payload now added as
`CanvasCommandEvent` in Phase 1, and sdk transport semantics). The remainder:

**3. `supportsMultipleEditorsPerDocument: false` contradicts the two-panels-same-document
scenario.** Accepted, and this one reaches back into the approved spec, whose criterion cites
"(e.g. split editor)". Verified: VS Code cannot open two canvas panels for one document. Of the
two remedies offered I took the second, scoping the scenario rather than flipping the flag,
because flipping it changes user-visible editor behavior far outside this issue. The MRU rule
is unaffected and still load-bearing (two files in one workspace, two hosts once #1386 lands,
and registry-level defensive behavior); only the venue changes, from a manual VS Code pass to
Tower-layer tests in Phase 4 that register two views over HTTP directly. Recorded as a
ground-truth note in the plan and raised with the architect, since it corrects an example in an
approved artifact.

**4. VS Code wiring is incomplete: no `ConnectionManager`, and reconnect behavior undefined.**
Accepted. `apps/vscode/src/extension.ts` is now in the Phase 6 file list with the reason, and
re-registration after Tower restart (and after an unknown-view heartbeat) is both a deliverable
and an acceptance criterion. The stranded-panel case is in the risk table.

**5. Canonicalization wording conflated file identity with view identity.** Accepted; the
wording was genuinely ambiguous. Canonicalization now explicitly merges the **file identity
used for matching**, while two panels on the same canonical file remain two views with distinct
`viewId`s, and the acceptance criterion asserts both halves.

**7. `Promise<CanvasCommandResult>` has no transport-failure variant.** Accepted, resolved by
rejecting the promise on transport or malformed-response failures so a resolved promise always
carries a Tower verdict. The alternative, adding a code such as `unreachable`, would widen a
closed union the spec fixed and the streamdeck architect approved. This is a deliberate
departure from `sendCommand`'s non-throwing style, documented as such in Phase 5 and flagged to
the architect so the streamdeck stakeholder can veto it.

## Gemini (APPROVE)

No issues raised; no changes required.
