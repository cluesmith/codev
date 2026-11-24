# Spec 1940 — responses to the third review round

Run by hand at the architect's instruction, on the third revision (owner items 1 to 6: #1605,
relay attestation, builder rule, stage 2 walkthrough, connections per owner, existing code).
Verdicts: codex REQUEST_CHANGES, claude COMMENT. Nothing was edited while either lane ran.
Every point was accepted. Nothing is rebutted.

## codex

| Point | Change |
|---|---|
| The attested statement has no unique id, so two legitimate statements could be identical | Added a statement id: 128 random bits from the cloud, covered by the MAC. Replay memory is keyed by it. |
| Only "accepted" statements were remembered, so a valid statement whose message was refused could be replayed | A statement is used up the moment it passes the MAC and freshness checks, before resolution, grants or limits, whatever the outcome. Test added. |
| "Zero-width characters" and similar sets were undefined | Replaced by an exact, fixed list of code points; line-ending handling stated first; the marker check now covers a line indented with spaces or tabs. The known cost (joiner and non-joiner are dropped from remote bodies) is stated. |

## claude

| Point | Change |
|---|---|
| Stage 1 refuses every `afx://` address, but Decision 1 allowed self-naming without the cloud | Self-naming is allowed from stage 2. In stage 1 every `afx://` address is refused, and the bullet says why. |
| Acceptance criteria depend on Open Question 4; nobody is named to file the follow-ups | Success Criteria now says approval with OQ4 as recommended makes the stage 1 checklist binding, and that the architect files the stage 2 and stage 3 issues. |
| Mail held for release has no stated lifetime | Stated: it never expires and is never auto-dismissed; the 50-message cap per peer is the intended backpressure; the indicator stays in its attention state and the sender is told. |
| The stage 2 walkthrough teaches `--all` | Steps 4 to 6 now use narrow grants naming one architect. `--all` is described underneath as the shortcut for own Towers. |
| No footer row for a builder receiving a remote message | Row added. |
| `afx peer show` against an offline peer | Refused, never held. Test added. |
| "Existing code" is plan-level material | Kept, retitled "Compatibility: existing code the design must not break", and introduced as constraints, not design. |
| Length; no summary | An "At a glance" table at the top: each matter, the recommendation, and the open question that asks for the owner's decision. |
