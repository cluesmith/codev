# Builder thread — spir-1401 (artifact-canvas remote command channel)

## 2026-08-11 — Specify phase started

Porch has me in `specify`. No pre-existing spec, so I'm authoring one from issue #1401.

Architect guidance received at spawn+specify:
- Command set mirrors keyboard vocabulary from #1237 (PR #1344) and #1380 (PR #1398) exactly; composer open/submit/cancel in scope, text entry out.
- Target rule for no-canvas-open / multiple-canvases-open must be decided IN the spec (explicit rule or explicit error; no silent no-op).
- Before requesting spec-approval, message main architect — they route the sdk-surface section to the streamdeck architect (same stakeholder arrangement as #1189).
- sdk constraints hard: environment-agnostic, zero runtime deps, imports only codev-types, CI boundary tests.
- Ride existing plumbing: canvas adapters (File/Marker/Theme) + the live-update channel the open page already holds; `afx open` serves the canvas via Tower.

Research in flight: two Explore agents mapping (a) the canvas keyboard action inventory + live-update channel, (b) Tower route conventions + sdk/controller structure.

## 2026-08-11 — Spec drafted

Ground-truth findings that shaped the spec:
- Canvas keyboard handling is inline (no action enum/names anywhere); block next/prev is native Tab over `tabindex=0`; reading-mode toggle has no key. The spec therefore DEFINES the canonical 14-command names.
- The canvas's only live host is the VS Code webview (postMessage); Tower's `afx open` page is the legacy open.html annotator, NOT the canvas — the migration is #1386 (open). The architect's "afx open serves the canvas via Tower" note resolves to that planned migration; the bridge is designed host-agnostic so the #1386 page becomes a second registrant with no protocol change.
- Existing `POST /api/command` relay is fire-and-forget broadcast — structurally cannot satisfy Requirement 4 (explicit no-canvas answer), so the spec recommends a canvas view registry in Tower + a targeted route, delivery as a viewId-addressed event on the existing SSE channel, `CommandAdapter` as the package seam (D-series pattern), and `sendCanvasCommand` on the sdk controller subpath.
- Target rule decided at spec time: zero matches → explicit `no-canvas` error; multiple → deliver to exactly one, most-recently-active (never broadcast — composer-submit would double-post).

Next: commit draft, message main architect (they route the sdk-surface section to the streamdeck architect BEFORE the spec-approval gate), then `porch done 1401` for the 3-way consultation.

## 2026-08-11 — Consultation + streamdeck review folded in

3-way verdicts: gemini APPROVE, codex REQUEST_CHANGES, claude REQUEST_CHANGES (high-quality, code-verified). Claude's two blocking findings were real and both landed on the parity rule:
1. Remote commands have no `e.target`, and the in-page handlers gate on DOM focus — literal parity would make 8/14 commands no-ops in the primary scenario. Fixed by redefining the rule as *effect parity with a defined remote origin*: a "current block" cursor (last-focused block → topmost visible block fallback), remote navigation moves within-document focus via the same path, composer submit/cancel are view-scoped not focus-scoped.
2. `block-next/prev` can't be native-Tab parity (Tab visits affordances/cards/toolbar/links). Redefined as flow-order `[data-line]` stepping, explicitly not Tab parity.
Also folded: Tower-minted viewId semantics, Tower-side path canonicalization, Tower-stamped `lastActiveAt`, security posture paragraph (inherits Tower trust boundary; composer-submit is the first relay-triggerable file write; selector keys never dereferenced as paths), closed HTTP error contract.

### Architect question during the gate: "are we tapping the same pipeline as other deck commands?"

Traced it in code. There IS one existing pipeline: deck → `sendCommand(verb,args,ws)` → `POST /api/command` → SSE broadcast → `apps/vscode/src/command-relay.ts` (workspace filter + focus gate + `VERB_COMMANDS` allowlist) → `vscode.commands.executeCommand`. Notably `open-spec` → `codev.viewSpecFile` → `vscode.openWith(uri, MarkdownPreviewProvider.viewType)`, so **the deck already opens the artifact canvas through that pipeline today**; #1400 navigates inside a canvas the deck itself opened.

We share the transport, controller posture, sdk subpath and receiving provider; we diverge on route/targeting/response because the broadcast relay returns `{ok:true}` unconditionally and cannot express Requirement 4. No collision with the existing `add-comment` verb: it operates on `vscode.window.activeTextEditor`, which is undefined when the canvas custom editor holds focus (it is the raw-source sibling, not a duplicate).

Streamdeck sdk-surface review: APPROVE (issue #1401 comment) with deltas, folded in: optional `count` (default 1) on the eight traversal/paging commands only; failure codes as a closed exported union in codev-types (`CanvasCommandErrorCode`); generic-relay exposure CLOSED as NO (open question removed, decision recorded); sdk presence query recorded as a named non-goal with an additive follow-up path. MRU + lastActiveAt-on-delivery + toggle-not-set explicitly endorsed.

## 2026-08-11 — spec-approval granted; plan drafted

Human approved spec-approval; porch advanced to `plan`. Plan written with 5 phases:
types contracts → canvas seam → Tower registry+route → sdk calls → VS Code host wiring.
Phases 2/3/4 each depend only on Phase 1, so they are independently verifiable.

Two spec-deferred decisions settled in the plan:
1. **Vocabulary ownership.** artifact-canvas has NO codev-types dep today (only dompurify +
   markdown-it). The union is a real wire contract and Tower/sdk cannot depend on a React
   package, so codev-types owns it and the canvas takes a type-only dependency (sdk precedent).
   The canvas import-boundary guard forbids vscode/node:*/fs/fetch only, so this is allowed;
   Phase 2 extends the guard to pin the import as type-only.
2. **Registration transport.** Per-view HTTP register/heartbeat/unregister with a lease, NOT
   SSE-connection-lifetime binding. Deciding case: one VS Code window holds a single SSE
   connection but can host several canvas panels, so connection-scoped registration cannot
   distinguish panels or drop one on close.

Also decided: sdk gains host-facing registration methods on TowerClient but does NOT re-export
them through controller.ts — controllers drive views, hosts register them, so the approved
controller surface stays exactly as reviewed.

## 2026-08-11 — Plan consultation: two blockers, plan restructured 5 → 6 phases

gemini APPROVE; codex + claude REQUEST_CHANGES, both code-verified and both right. I
re-verified all six load-bearing claims against the worktree before acting; all held.

Blockers:
1. **Runtime traversal classification was unimportable by BOTH intended consumers.**
   packages/codev has codev-types as a compile-time-only dep and runs unbundled from dist/, so
   a runtime value import does not resolve (command-relay.ts:24-29 documents this and
   re-declares COMMAND_ROUTE for the same reason); and the canvas import is type-only by my own
   Phase 2 rule. Fixed: classification is now type-level (`TraversalCommand`), each consumer
   declares a `satisfies`-bound const list. Tower also re-declares route/event literals.
2. **Phase 2 "pure extraction" hid ~6 commands of new work.** Only 6 of 14 commands have a
   handler to extract; block-next/prev (native Tab), reading-mode-toggle (ReadingModeToggle.tsx)
   and composer-submit/cancel (CommentComposer.tsx's own onKeyDown) are new. Split the PHASE
   rather than just the deliverable, because the template requires one atomic commit per phase.
   Now: Phase 2 = pure extraction (oracle: unmodified existing suite), Phase 3 = new actions +
   composer seam + cursor + CommandAdapter.

Notable: **`supportsMultipleEditorsPerDocument: false` (extension.ts:1404)** means VS Code
cannot open two canvas panels for one document, so the approved spec's "(e.g. split editor)"
example is factually wrong. MRU rule is unaffected and still needed (two files in one
workspace; two hosts once #1386 lands; registry-level defence) — only the verification venue
moves, to Tower-layer tests. Did NOT flip the flag (user-visible editor behavior, out of scope).
Raised with the architect since it corrects an approved artifact.

Other fixes: type-test moved out of src/ (would have been published: include src/**/*, files
[src,dist]); cursor documented as deliberately separate from hover-driven activeLine; count
ignored by canvas / rejected by Tower (was unfalsifiable "ignored or rejected"); extension.ts
added to Phase 6 (provider is constructed without ConnectionManager); re-registration on Tower
restart; canonicalization merges FILE identity, not view identity (two views keep distinct
viewIds); typed CanvasCommandEvent SSE payload; sdk transport failures reject rather than
widening the spec-fixed closed error union; webview/ is outside the extension typecheck so the
manual pass is load-bearing evidence, not a formality.

## 2026-08-11 — Rebased on main; two post-approval corrections folded in

Rebased builder/spir-1401 onto origin/main (27 commits behind → 0). Clean, no conflicts; porch
state intact at `plan`. NOTE: the branch was already pushed, so the remote is now diverged and
needs a force-push to match. Not done — waiting on the human, since it rewrites published
history.

Architect-authorized spec corrections (post spec-approval, substance unchanged; both recorded
in a revision note at the top of the spec):
1. **split-editor example was factually wrong.** extension.ts:1404 sets
   supportsMultipleEditorsPerDocument:false, so VS Code cannot open two canvas panels on one
   document. Example replaced (two hosts on one file, post-#1386); MRU requirement kept
   verbatim; verification venue moved to the Tower registry, which accepts two registrations
   for one file directly. Flag deliberately NOT flipped.
2. **Transport-failure delta: streamdeck stakeholder REJECTED my proposal.** I verified their
   claim myself at tower-client.ts:288-296: request() catches every transport error and returns
   {ok:false, status:0}, so the client holds a never-reject invariant and sendCanvasCommand must
   not be its sole exception. Binding resolution folded in: call stays NON-THROWING; the
   sdk-visible union gains `unreachable` as a CLIENT-SYNTHESIZED code (wire union stays two
   members — two separate types, so Tower cannot type a response it must never send);
   transport failures key off the existing status:0 signal.

Structural `source` field was my call: **declined**. The type-level split already carries the
distinction (Tower cannot express `unreachable`), the closed union gives TS consumers
exhaustiveness checking when it grows, and status:0 already signals the case one layer down. A
source field would be a third encoding of one fact.

Lesson worth keeping: my proposal was locally well-reasoned but violated a package-wide
invariant I had not checked. The stakeholder review caught it, exactly as the #1189 arrangement
is meant to.

## 2026-08-11 — plan-approval granted; implementing phase_1 (wire contracts)

Human approved plan-approval; porch advanced to `implement`, plan phase_1.

Written: packages/types/src/canvas-command.ts (14-command closed union, type-level
TraversalCommand/NonTraversalCommand, wire vs client error unions, request/result/registry/SSE
event shapes, three route/event constants), exported from index.ts; type-test guard at
packages/types/type-tests/ with its own tsconfig + `check-types:tests` script.

Guard design note: `Extract`/`Exclude` alone CANNOT catch drift — a newly added command silently
falls into the NonTraversal complement and `count` quietly stops applying to it. So the guard
carries an exhaustive `satisfies Record<CanvasCommand, ...>` classification map that must be
updated by hand, plus bidirectional Equal<> assertions that the map and the exported types
agree, and partition complete/disjoint checks. **Verified by hand** that adding an unclassified
command fails the guard with 3 errors, then reverted the probe.

Also dropped a `@ts-expect-error` approach for the "Tower cannot answer 'unreachable'" check:
the error surfaces on the object property line, not the declaration line, so the directive was
reported unused while the real error escaped. Replaced with pure type-level Extract<> assertions
(more robust, no line-position coupling).

Build hiccup, NOT mine: `npm run build` failed on a missing `@xterm/addon-serialize` in
packages/codev/src/terminal/session-screen.ts. Traced it to PIR #1354, which my rebase pulled in
from main; the dep is declared in packages/codev/package.json but the worktree's node_modules
predated it. My branch touches zero terminal files. Running pnpm install.

### phase_1 consultation: gemini APPROVE, codex APPROVE, claude REQUEST_CHANGES

Claude caught that **the exhaustiveness guard never runs in CI** — verified myself: test.yml
builds packages/types but nothing in any of the 5 workflows invokes check-types:tests, and
there is no recursive `pnpm -r check-types`. Since codev-types has no test runner, that guard
is phase_1's ENTIRE verification story, and living outside src/ (so it isn't published) is
exactly what keeps `pnpm build` from reaching it. Unwired it would have protected nothing while
looking like protection, and no later phase touches this package's CI. Added a
`check-types:tests` step to test.yml right after the types build, with a comment explaining why.

Worth remembering: everything was green locally and two of three reviewers approved. "Tests
pass" hid "the test can never fail."

### Porch wedge incident (worth knowing if it recurs)

`porch next 1401` hung for ~65 minutes with zero output. Root cause was NOT porch and NOT the
review: it had spawned `git push -u origin HEAD` which wedged. Diagnosis path: `pgrep -P <porch
pid>` showed the child was a git push; `git ls-remote` returned instantly (so network + auth
were fine); no hooks, no .lock files; the remote ref had not moved in an hour, so nothing was
mid-transfer. The wedged process was Xcode's git (/Applications/Xcode.app/.../git), most likely
stuck on a credential-helper prompt with no TTY to answer it. My own shell git is /usr/bin/git
and pushed the same commits instantly.

Recovery: SIGTERM the git child (porch stayed alive but idle with no children, so it was not
going to recover), SIGTERM porch, verify status.yaml intact, push manually with /usr/bin/git,
re-run `porch next`. porch resumed correctly at implement iteration 2 with no state loss.

Generalisable: a wait is a claim that a producer exists — check the CHILD process, not just the
parent. An hour of "still running" was one wedged subprocess the whole time.

## 2026-08-12 — phase_1 approved (3/3); phase_2 extraction done

phase_1 got unanimous APPROVE on iteration 2 (claude re-ran the CI step and confirmed the guard
fails a build when a command is unclassified). porch advanced to phase_2.

phase_2 (pure extraction) in ArtifactCanvas.tsx: 9 actions now live in one `canvasActions`
registry keyed by command name (comment-next/prev, heading-next/prev, doc-start/end,
column-forward/back, composer-open), with onBodyKeyDown reduced to key mapping + event guards.
Every event-shaped concern stayed in the handler (affordance/modifier guards, composer
exemption, innerScrollerCanConsume, preventDefault) because a remote command has no event.

Two ordering subtleties preserved deliberately:
- Enter/Space is handled BEFORE the modifier guard, so Ctrl+Enter on a block still opens the
  composer. Kept as-is rather than "fixed" — phase 2 is a refactor.
- Column paging must not preventDefault when geometry is unmeasurable, so `pageColumn` returns
  a boolean and the handler only prevents default when the action actually ran.

`lineFromEvent` was orphaned by the extraction (composer-open now does closest → Number → NaN
inline, identical logic) and was removed rather than left as dead code.

Verification: 150/150 vitest pass with NO test file edited (the phase's oracle), check-types
clean, 33/33 Playwright pass.

### HARNESS BUG worth an issue (not mine to fix in this phase)

`packages/artifact-canvas/playwright.config.ts` pins port 5199 with
`reuseExistingServer: !process.env.CI`. A sibling worktree (.builders/spir-1380) had its canvas
vite up on 5199 for ~1.5 days, so my first `test:browser` run silently executed against THAT
worktree's code and failed 33/33. The dangerous case is not this one: if the sibling's code
happens to be compatible, the run PASSES against the wrong worktree and nobody notices.
Worked around locally with a temporary isolated config on a free port (deleted, not committed);
did NOT touch the sibling builder's server. Reported to the architect.

### Architect response on the harness bug (2026-08-11)

Verified and actioned. The 5199 holder is a TRUE ORPHAN: vite pid 70738 whose cwd is the
*removed* spir-1380 worktree, serving deleted code from stale file handles for ~1.5 days. The
architect's kill was permission-blocked, so 5199 stays occupied until the human clears it.
Issue **#1407** (area/vscode) filed for the structural fix (per-worktree port, or
reuseExistingServer:false + dynamic port).

SANCTIONED for my remaining phases: keep verifying browser tests with a temporary isolated
config on a free port, uncommitted. **TODO for the review file's testing section: note the
workaround and cite #1407** so the pr-gate reviewer knows why the committed config was not used
locally. (Phases 3 and 6 both touch canvas behavior, so this will recur.)

### phase_2 consultation: codex APPROVE, claude APPROVE, gemini lane skipped (agy no output)

No blocking issues. Three advisories carried forward to phase_3:
1. **`canvasActions` is rebuilt every render.** The CommandAdapter subscription must dispatch
   through a REF, not a closure captured at subscribe time, or a remote command would run the
   first render's actions with stale `readingMode`/`composingLine`. This is the main correctness
   trap in phase_3 and is now on the checklist.
2. **Replace the local `CanvasActionName` with `Extract<CanvasCommand, ...>` from codev-types**
   and hoist to module scope. Names match exactly today, so this is drift prevention. Phase_3
   adds the codev-types dependency anyway, so it lands naturally there.
3. `pageColumn`'s `step <= 0 -> false` branch is untested (pre-existing gap); phase_3 adds
   adapter-level tests and can cover it cheaply.

## 2026-08-12 — phase_3 (canvas remote command seam) implemented

Registry widened from a local union to `Record<CanvasCommand, ...>` from codev-types, so TS now
enforces that all 14 commands have an implementation. Added the five that had no handler:
block-next/prev (flow-order [data-line] stepping, NOT Tab parity, Tab untouched),
composer-submit/cancel, reading-mode-toggle. Plus CommandAdapter (4th adapter, interface-only),
the commandAdapter prop, the focus-derived cursor, and count handling.

Advisories from phase_2 all actioned: dispatch reads through a ref (canvasActions is rebuilt per
render); CanvasActionName replaced by CanvasCommand from codev-types, TRAVERSAL_COMMANDS hoisted
to module scope with `satisfies` + an assertion for the missing-member direction.

**CORRECTION (phase_3 iter1 review):** that assertion as first written was INERT — a bare
conditional type alias constrains nothing, so an omitted command resolved to `never` and compiled.
Same defect class phase_1 was sent back for. Now wrapped in `Assert<T extends true>` and verified
by deleting a command from the list and watching check-types fail with TS2344.

Composer seam: CommentComposer is now forwardRef with a `submit()` handle. Only submit, because
submission needs the composer's own draft text; cancel needs nothing so it goes through the
parent's existing cancelComposer. Remote submit reports viaKeyboard:true so focus restoration
keeps its visible ring.

### Three test failures that were real code gaps, not test problems

1. **Clean-view navigation no-oped.** currentBlock fell back to viewportStartLine, which measures
   with getBoundingClientRect — useless in jsdom, and equally useless in a real browser when the
   canvas is display:none/detached/not yet laid out. Added a final fallback to the first block.
   My own success criterion ("every navigation command has an observable effect from a clean
   state") would have been false.
2. **count stopped after one step.** currentBlock relied on the focus event refreshing the cursor
   ref between iterations. Now it reads live DOM focus FIRST (precedence: live focus → cursor ref
   → topmost visible → first block), so each step sees where the previous one landed. Uncovered
   because jsdom lacks scrollIntoView: focusBlock threw, my try/catch swallowed it, and the loop
   truncated. Mocked scrollIntoView per the repo's existing pattern (marker-minimap.test.tsx).
3. **Double toggle landed back where it started.** Two commands delivered in ONE synchronous
   batch: the second read readingMode from a render closure that had not updated. Nothing in the
   CommandAdapter contract forbids a host delivering synchronously, so toggleReadingMode now
   reads/writes a readingModeRef mirror instead of assuming a re-render between calls. The
   pointer path cannot hit this; the remote path can.

Verification: 169/169 vitest (19 new), check-types clean, 33/33 playwright on the COMMITTED
config (5199 free again after the orphan was cleared), repo build + 4820 tests green.

### phase_3 consultation iter1: gemini APPROVE, codex + claude REQUEST_CHANGES

All points fixed. Two where the honest answer changed the TEST rather than the code:

1. **Vertical-mode column paging (codex).** Added the mode check (correct, defensive), but the
   described failure — a vertical layout scrolling sideways — does not reproduce: `overflow-x:
   auto` is scoped to `.codev-canvas-mode-horizontal` (default-theme.css:490-497), so in vertical
   mode the body is not a horizontal scroll container and `scrollLeft = 40` reads back 0. Test now
   asserts what is verifiable and records why the stronger scenario is unreachable, instead of
   passing vacuously.
2. **Remote doc-end doesn't scroll into view.** My own new test caught this and I nearly "fixed"
   the canvas. Probed the keyboard equivalent first: `End` behaves IDENTICALLY (line 1106,
   scrollLeft 0), because the fixture's last block is a table row whose scrollable ancestor is the
   table, not the body. Pre-existing, and reproducing it exactly IS the parity the spec asks for.
   Changing it would have breached the no-in-page-behavior-change non-goal. Test rewritten to
   mirror the keyboard suite's `n` case.

Also: made the dev examples page a real host implementing CommandAdapter over
`window.__canvasCommand`, so Playwright can drive the seam. That is the only way to assert column
paging at all (jsdom has no layout), and it closes codex's real-browser coverage gap.

Lesson worth carrying: when a new test fails, check whether the KEYBOARD path does the same thing
before touching the component. Twice now the diff between "my path is broken" and "this is how it
has always worked" was one probe away.

### Manual verification by the human (2026-08-12) — canvas half CONFIRMED WORKING

Ran the dev examples page (`pnpm --filter @cluesmith/codev-artifact-canvas dev:example`, :5173)
and drove the seam from the browser console via `window.__canvasCommand`. Human confirmed working.

Worth recording because it briefly looked broken and was not:
- the command returns `undefined` (void), which reads like a failure but is just the return value;
- on the default sample page the ONLY visible effect of navigation is the focus ring moving;
- the sample doc has exactly ONE marked block, so a second `comment-next` is a correct no-op
  (no wrap at the edges, same as the `n` key).
Trace captured: doc-start/comment-next -> line 2 Summary, heading-next -> line 6 Requirements,
block-next -> line 8, doc-end -> line 12.

For anyone testing later: `reading-mode-toggle` and `composer-open` give unmistakable visual
feedback; `?fixture=columns&mode=horizontal` is the page for column paging. Dev server stopped
after the session (deliberately, so it cannot become the kind of orphan behind #1407).

This is the first real-user-path confirmation for the canvas half. The Tower/sdk/VS Code path
still needs phases 4-6, and phase_6 carries the full human review loop as an acceptance criterion.
