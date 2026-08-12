# Phase 5 (sdk canvas command and view registration) — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES.

One finding accepted and fixed. One **partially disputed**: the observation is factually correct,
but it describes a pre-existing property of the controller subpath rather than anything this
phase introduced, and the remedy would redesign a surface owned and already approved by another
stakeholder. Evidence below; raised with the architect rather than changed unilaterally.

## 1. (Accepted) `sendCanvasCommand` accepted any object containing `ok`

Real hole, and it defeats the point of the call. The guard was `'ok' in body`, so
`{ok: true}` with no `target` came back as a typed success and the caller would read
`target.viewId` off `undefined`; `{ok: false, code: 'bogus'}` came back as a typed failure
carrying a code outside the caller's union. My "unreadable body" test only covered a body with no
`ok` at all, so it passed while the interesting cases went through.

Fixed with `parseCanvasCommandResult`, which validates the complete shape: a success needs
`target.viewId` and `target.file` as strings, and a failure needs a `code` from the closed wire
union. Anything else is reported as `unreachable`, on the principle that a response we cannot
fully verify is not a verdict.

Two details worth noting. The runtime code list is pinned to `CanvasCommandErrorCode` with an
`AssertTrue` guard, so a code added to the contract cannot silently become unrecognized here —
without that, a future real verdict would be misreported as `unreachable`. And that guard
immediately earned its keep: the type name was missing from the import, which surfaced as the
assertion resolving to `false` rather than as a silent pass.

Coverage: nine malformed-response cases (missing target, partial target, non-string ids, unknown
code, missing code, non-object, null), plus a case for a valid code arriving without a message.

## 2. (Partially disputed) `controller.ts` re-exports `TowerClient`, so registration methods are reachable

The observation is true. The conclusion that phase 5 violates its own plan is not, and the
proposed remedy is out of scope for this phase.

**What the plan required**, and what was done: the registration methods are not re-exported
through `controller.ts`. They are not in its export list, and the doc comment records why
(controllers drive views; hosts own them).

**Why they are still reachable**: `controller.ts` exports the `TowerClient` class itself, and has
since before this issue. That class carries **39 public methods**, including `addArchitect`,
`removeArchitect`, `createTerminal`, `killTerminal`, `sweepHusks` and `activateWorkspace` — none
of which are controller concerns either. The subpath is a curated *namespace* of the types,
constants and client a controller needs; it has never been a capability boundary. My three
methods are no more reachable than the thirty-six that predate them.

**Why I did not "fix" it**: the only real remedy is a restricted client surface — a wrapper or a
narrowed interface on that subpath. That is a redesign of a published surface the streamdeck
architect owns and reviewed at design time, it is a breaking change for existing consumers, and
it has nothing to do with canvas commands specifically. Doing it inside a phase whose scope is
"add the sdk calls" would be exactly the kind of unilateral scope expansion the protocol asks a
builder to raise instead.

**What I did instead**: flagged it to the architect for the streamdeck stakeholder to decide. If
they want a hard boundary on that subpath it deserves its own issue, and it should cover all 39
methods rather than singling out the three added here.

## Gemini, Claude (APPROVE)

No blocking issues raised.

## Verification after the fix

- 98/98 sdk tests (9 new malformed-response cases).
- 63/63 streamdeck tests, boundary suite unchanged.
- `check-types` clean for the sdk and repo-wide.
