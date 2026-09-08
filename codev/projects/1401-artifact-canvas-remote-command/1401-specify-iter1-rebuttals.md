# Spec 1401 — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES.
All REQUEST_CHANGES points were accepted and folded into the spec (commit `dde480550`),
alongside the streamdeck architect's design-review deltas (APPROVE with changes, issue #1401
comment). Nothing is contested; per-point disposition below.

## Claude (REQUEST_CHANGES)

**1. (Blocking) Remote commands have no `e.target`; literal keyboard parity makes 8/14
commands no-ops.** Accepted — this was the spec's central defect. The semantics rule is
rewritten from "behaves exactly as its keyboard equivalent" to **effect parity with a
defined remote origin**: relative navigation and `composer-open` operate on a *current
block* (most recently focused block by any modality, falling back to the topmost visible
block, i.e. the first block in an unscrolled document), so every command is well-defined on
a freshly opened view. The spec also now states that remote navigation moves within-document
focus via the same focus path (ring + scroll-into-view), that host-surface focus acquisition
is host policy (no cross-surface focus stealing), and that `composer-submit`/`cancel` are
view-scoped, not focus-scoped. New success criterion + test scenario 3 cover the clean-state
origin.

**2. (Blocking) `block-next`/`block-prev` cannot be native-Tab parity.** Accepted.
Redefined as flow-order `[data-line]` block stepping, explicitly *not* Tab parity (Tab also
visits affordances, card actions, toolbar, links). No Tab interception — the
no-keyboard-change constraint and the untouched keyboard tests stand. `reading-mode-toggle`
is now defined against its toolbar-button equivalent. Success criterion 1 reworded to "the
effect defined in the command table" with the 12-keyed / 2-equivalent split.

**3. `viewId` caller-visible but unusable.** Accepted. Now specified: Tower-minted at
registration, opaque, stable for the registration's lifetime, returned for observability
(it is what distinguishes two same-file views in results); not a selector today, admitting
it as one is a named additive follow-up.

**4. `file` matching normalization.** Accepted. Tower canonicalizes paths on both
registration and command (same resolution as the existing file-tab dedupe); scenario 6 now
asserts spelling variance cannot split the registry.

**5. `lastActiveAt` clock ownership.** Accepted. Tower stamps receipt time for activity
reports and command delivery; host clocks are never trusted. (Delivery advancing MRU was
also explicitly endorsed by the streamdeck review.)

**6. Security section.** Accepted. Added a security-posture paragraph: route inherits
Tower's existing trust boundary (localhost + host/origin gate; BRIDGE_MODE exposure noted);
`workspace`/`file` are registry lookup keys never dereferenced as filesystem paths; command
payload validated against the closed union; the composer-submit-triggers-a-file-write
consequence is stated explicitly (write path itself unchanged, host-side); Tower-minted
`viewId` prevents identity claims across registrants.

**7. Ranking nit (`canvas-*` verbs question marked Important, self-describes as
blocking).** Overtaken by events: the streamdeck design review closed the question as
**NO — targeted route only**. It is removed from Open Questions and recorded as a closed
decision so it is not reopened.

## Codex (REQUEST_CHANGES)

**1. Resolve the Stream Deck surface question before approval.** Done — the streamdeck
architect reviewed the sdk surface at design time and APPROVED with deltas, all folded in:
optional `count` (default 1) on the eight traversal/paging commands only (rejected as
`invalid-request` elsewhere), closed failure-code union, generic-relay exposure closed as
NO, presence query recorded as a named non-goal with an additive path.

**2. Exact HTTP status/body behavior and sdk normalization; open-ended `…` in the result
union.** Accepted. Error contract is now explicit: failure codes are a **closed exported
union in codev-types** (`CanvasCommandErrorCode = 'no-canvas' | 'invalid-request'`),
`no-canvas` → 404, `invalid-request` → 400, body always `{ok:false, code, error}`. The spec
fixes the observable sdk contract — the machine-readable `code` must survive to the caller
(the noted `request()` flattening is acknowledged; how the implementation composes with it
is plan detail, the contract is not).

**3. Command parity not always "exactly" equivalent (Tab traverses controls;
Escape/submit applicability focus-dependent).** Accepted — same substance as Claude's two
blocking points; resolved by the effect-parity rewrite, the non-Tab definition of
`block-*`, and view-scoped composer commands.

**4. Canonical workspace/file matching and server-authoritative MRU timestamps.**
Accepted — Tower canonicalization + Tower-stamped `lastActiveAt`, as above.

**5. Security requirements for registration and mutation.** Accepted — security paragraph
as above: Tower-minted view ids (uniqueness/ownership), registration/activity under the
same Tower auth as every route, runtime validation against the closed union, trust boundary
stated. Request-size limits are left to the plan as transport mechanics; the closed union
plus `invalid-request` give the behavioral contract.

## Gemini (APPROVE)

No issues raised; no changes required.
