# spir-1819 thread — Tower Decisions tab

## 2026-10-17 · Specify

- Baked decisions live in the architect's triage *comment* on #1819 (not the issue body); copied verbatim into the spec's Constraints. Owner's time-zone rule (comment, 12:11 am) also in Constraints.
- Survey: web dashboard (`apps/web`) does NOT depend on `@cluesmith/codev-artifact-canvas` today (only VS Code does) — reusing `MarkdownView` per baked decision 1 means adding that workspace dep.
- Conditional-tab precedent: Team tab via `teamEnabled` on the workspace state response.
- Change-detection precedent: annotator `open.html` polls `api/mtime` every 1s. Spec recommends polling (Approach 1) over a new fs.watch+SSE watcher.
- Spec takes positions on: explicit Submit button, re-ruling allowed (inserted above earlier ruling), per-item fingerprint refusal (stricter than baked #3), config key `dashboard.decisionsFile`, blank-line separation in the splice. All listed as Important open questions for the spec gate.

## 2026-10-17 · Specify iter 1 review (codex + claude: both REQUEST_CHANGES)

Addressed all points in the spec:
- Path containment now canonical (symlink-resolved) at every read/write; symlinked file keeps its link.
- One explicit structural grammar (CommonMark subset: fences, ATX headings w/ ≤3 spaces); comments with heading/fence/Your-word lines refused; plus a re-parse verification catch-all after every splice.
- Writes serialized per file inside Tower + atomic temp-file rename; success returns the re-parsed doc.
- Already-ruled items now READ-ONLY (reversed my earlier "allow re-ruling above"): keeps the file unambiguous and makes the second of two concurrent submits refuse cleanly.
- Duplicate-id items fully read-only; drafts on items that stop being writable are "held" (copyable + Discard).
- Timestamp zone table enumerated; DST gap/fold → unconverted; Intl offset probing, no date lib.
- Links: Decisions view opens http(s) in new tab, others inert; shared renderer untouched.
- Dropped the blank line between Your-word line and the word (word on the very next line) and the untestable "same bytes as hand-typed" criterion. main's scan contract is now Open Question 1 (Critical, confirm at gate).

## 2026-10-17 · Spec gate wait — Open Question 1 resolved

- Architect relayed the adopter hub's scan contract: everything after the **Your word:** line to end of item is the ruling; same-line text after the options is NOT read; no **Ruling:** line is appended; on a ruling the item leaves ## Open for a one-liner in ## Ruled. Folded into Assumptions; OQ1 marked resolved. Still waiting on the human spec-approval.

## 2026-10-17 · Spec addition — owner questions (Q&A thread)

- Owner's protocol addition (issue comment 6:15 am): owner may type a QUESTION in the comment box (no new write shape); main pastes `- **You asked (t):**` / `- **<Name>'s answer (t):**` pairs above the Your-word line; tab renders them as a thread, newest at bottom.
- Design point (read-only rule vs question round-trip) resolved by the hub: it REMOVES the question text (and any <!-- REVIEW --> comment) from under Your-word when it pastes the pair, so the item is unruled again. Read-only rule unchanged; recorded as an explicit dependency in Assumptions. Current ruling now shown verbatim (plain text) so a REVIEW comment is visible; read-only note made neutral (tab can't tell a ruling from a question).

## 2026-10-17 · Spec approved (human, relayed by architect) → Plan

- Ran `porch approve 1819 spec-approval` on the architect's relay of the human approval.
- Housekeeping: owner's global rules forbid Co-Authored-By / "Generated with" lines — none from here on (earlier spec commits keep theirs; architect said no rewrite).
- Owner ask at plan time: evaluate YAML/JSON/hybrid instead of markdown. Plan carries a "Format Evaluation" section; recommendation: KEEP MARKDOWN (owner hand-typeability, per-item failure vs whole-file failure in YAML/JSON, js-yaml can't round-trip so the byte-preserving splice doesn't get easier, cross-repo hub migration). The one real structured win — unambiguous stamps — is already available: the spec accepts numeric offsets, so the hub can write `12:10 am -07:00` with no tab change.
- Plan: 6 phases — read model (parser+stamp+types) → splice → routes (config, realpath containment, KeyedSerializer + atomic rename) → read-only tab → ruling UI/drafts → Playwright + docs.

## 2026-10-17 · Plan iter 1 review (codex + claude: both REQUEST_CHANGES) — all accepted

- useDecisions: skip-while-in-flight + generation counter (applyDocument bumps it) so a stale poll can't overwrite a write's document.
- E2E: explicit non-4100 TOWER_TEST_PORT required (precedent #1630); throwaway mkdtemp workspaces only — never the repo (codev/state/*.md is gitignored, a leftover would be invisible).
- Option tokenization: ` / ` starts an option only when followed by a backtick.
- Tab is conditional-then-sticky for the page session so "file disappears → not-found, held drafts visible" is reachable.
- decisionsEnabled: configured path memoized ≤5s for the state flag only (state polled every 1s); config errors → flag false, logged, never fail /api/state.
- Theme CSS imported from main.tsx; structure-changed reached via a pathological option word (`##`), no mocks.
- Old Phase 4 split → 7 phases total.

## 2026-10-17 · Phase 1 (read model) — approved by codex + claude at iteration 2

- Parser, grammar and stamp resolver landed with the wire types. Deliberate deviations, reviewed: the fingerprint is SHA-256 of heading → last non-blank line, so re-spacing between items is not an edit; two `## Open` sections → file problem `open-multiple`, every item read-only; an option description is only the text after `=`.

## 2026-10-17 · Phase 2 (splice) — implemented after a context refresh

- `spliceRuling(text, request)` in `servers/decisions/splice.ts`; pure, returns `{ ok, text }` or `{ ok: false, code, message }` and never text on refusal.
- Added refusal code `open-multiple` to `DecisionsRefusalCode`: phase 1 makes every item read-only when the file has two `## Open` sections, and none of the existing codes describes that. Phase 3 should map it to 409 with the other state refusals.
- Verification goes past the spec's comparison list in one way: every inserted line must also re-parse as plain, unfenced content. Without that, an option word like `` `####` `` (a level-4 heading inside the item) or `` `~~~` `` in the file's last item (an unclosed fence with nothing after it) passes the spec's checks. This is the same rule the comment checks apply, extended to the word.
- Comment line breaks: CRLF, CR and LF are all treated as breaks and rewritten in the file's own line ending, so a lone CR can't hide a heading on what other renderers treat as its own line.
- `**Your word:**` in the middle of a comment line is accepted: per the grammar, only a line that *starts* with the label is a Your-word line.
- Added the carried-forward `labelAt === -1` guard in `parseOptions`.

## 2026-10-17 · Phase 3 (routes) — implemented after a context refresh

- `servers/decisions/file.ts`: config key `dashboard.decisionsFile` (default kept as a constant, not in `DEFAULT_CONFIG`, so `getDefaultConfig()` starter configs don't change); canonical containment walks to the nearest existing ancestor, so `../missing/dir/x.md` is refused as outside rather than throwing; atomic write = temp file beside the canonical target (`wx`, target mode, fsync) + rename, temp removed on failure; one `KeyedSerializer` per canonical path.
- `servers/decisions/routes.ts`: GET answers `{ ok: true, document }` (plan said `{ document }`; `ok` added so both routes share one response shape, typed `DecisionsReadResponse`). Status map is exhaustive over `DecisionsRefusalCode`: input 400 (incl. `outside-workspace`), `not-found` 404, state 409 (incl. `open-multiple`), `structure-changed` 422, `config-error` 500.
- New refusal `not-utf8` (422): the route checks the file's bytes round-trip through UTF-8 before splicing; otherwise a stray invalid byte anywhere would be rewritten as U+FFFD, breaking "every pre-existing byte preserved".
- Handlers take Tower's `ctx.log` (plan signatures had none); `handleWorkspaceState` now takes `ctx` to log the flag's config error. That log is deduped per workspace so a broken config logs once, not once a second per dashboard.
- I/O failures during the write (e.g. rename EIO) are not refusals: they propagate to `handleRequest`'s generic 500; the test confirms the file is intact, no temp file is left, and the queue isn't wedged.

## 2026-10-17 · Phase 3 review (iter 1): codex COMMENT, claude APPROVE — porch advanced to phase_4

- Acted on two non-blocking points as a follow-up `[Phase: phase_3] fix` commit, because the client phases consume the route's contract:
  - An I/O failure while writing (ENOSPC/EACCES/EIO, or the file vanishing before the stat) is now a typed refusal `write-failed` (500, `{ ok: false, code, message }`) rather than escaping to `handleRequest`'s generic `{ error }` 500, so the card always has a message and keeps the draft. (claude)
  - An absolute `dashboard.decisionsFile` is a `config-error`, even when it points inside the workspace — the setting is defined as workspace-relative. (codex)
- Not acted on: logging the GET route's refusals (it is polled every couple of seconds while the tab is visible, so a misconfiguration would log on every poll; the state flag already logs a config error once per workspace). A directory at the configured path reads as `not-found` (nit, left as is).

## 2026-10-17 · Phase 4 (tab shell) — implemented after a context refresh

- `apps/web` now depends on `@cluesmith/codev-artifact-canvas` (workspace); its theme CSS is imported in `main.tsx`, before `index.css` so dashboard rules win. `pnpm add` also rewrote unrelated lockfile metadata (deprecation notes, a vitest/jsdom peer re-resolution); I trimmed the lockfile diff to the 3-line importer entry, and `pnpm install --frozen-lockfile` accepts it.
- `fetchDecisions()` never throws: `{ kind: 'document' | 'not-found' | 'error' }`. Any body without `ok` (the 401's plain text, a dispatcher `{ error }`, a malformed document) is an error.
- `useDecisions` is as planned: a 2 s poll while the tab is active and the page visible, skipping a tick while a fetch is in flight, and a generation counter bumped by each fetch start and by `applyDocument`. Mutation-checked: removing the guard fails the stale-poll test; removing the in-flight skip fails the overlap test. One deliberate deviation: the `error` state keeps the last document (`lastDocument`), so a transient failure (a tunnel blip) shows a banner over the last-read list instead of unmounting the cards under someone typing. `not-found` is the server's definitive answer and carries no document.
- Sticky tab: `useTabs` records "seen" with React's set-state-during-render pattern rather than a ref (same behaviour, no ref write during render). The tab sits after Team; `?tab=decisions` deep links work.
- Local environment, not this change: Node v26's built-in `localStorage` (undefined without `--localstorage-file`) shadows jsdom's, so 74 existing web tests fail locally (Terminal*, VirtualKeyboard, architect-toolbar). All 427 pass with `NODE_OPTIONS=--no-experimental-webstorage`, and CI runs Node 20. The new fetch test stubs localStorage like the other web tests do.
- Browser check (Playwright, throwaway Tower on 14819 with isolated `CODEV_AGENT_FARM_DIR`, socket dir and test DB; mkdtemp workspaces only): 15/15 — tab present on desktop and phone (no horizontal overflow at 390 px), items in file order, external write re-rendered in ~2.3 s, survives a tab switch, file removed → not-found with the tab kept, recovers when the file returns, no tab for a workspace without the file. Gotcha for phase 7: shellpers outlive a test Tower by design, so the harness must kill its own (match on its unique socket dir); my first run left two, verified as mine and killed by PID.

## 2026-10-17 · Phase 4 review (iter 1): codex APPROVE, claude APPROVE — porch advanced to phase_5

- No blocking issues. Not acted on, recorded for the review doc: a decisions file that first appears mid-session takes focus through `useTabs`' existing auto-switch to new tabs (the same as the Team and builder tabs); re-activating the tab while a read is in flight waits for the next 2 s tick; the file-problem notices get a `role` when phase 5 rewrites that area.

## 2026-10-17 · Phase 5 (read-only cards) — implemented after a context refresh

- `DecisionsView` now renders one `<article>` card per open item (named by its question): id, stamp, question, item notices, body via `MarkdownView`, the Q&A thread, the options (inert list, `Recommended` badge on the first), and the current ruling verbatim in a `<pre>` with the neutral note. `## Ruled` is an uncontrolled `<details>` (closed on load; React never sets `open`, so a poll re-render does not close it once the owner opens it).
- Deviation: the plan's stamp formula (`toLocaleString` with `dateStyle` + `timeStyle` + `timeZoneName`) throws in every engine — ECMA-402 refuses `timeZoneName` alongside the style shorthands. The view uses explicit fields (`year/month/day/hour/minute` + `timeZoneName: 'short'`), still in the viewer's locale and zone: e.g. "Oct 18, 2026, 12:38 AM EDT" for `2026-10-17 9:38 pm PT` viewed from New York. An unconverted stamp shows the raw text plus "Not converted: <reason>" in plain words (visible, not hover-only, so it reads on a phone).
- Links: one click handler on the view's root. Any click inside an `<a>` is `preventDefault`ed; only an `href` that is literally `http://` / `https://` (case-insensitive) is opened, via `window.open(href, '_blank', 'noopener')`. The raw attribute is tested, not the resolved `anchor.href`, so a repo-relative link (`[guide](codev/…)`) — which would resolve to the dashboard's own origin — stays inert rather than opening a dashboard URL in a new tab.
- Notices: file problems now carry `role="status"` (they can appear on a poll), item problems `role="note"` (the phase 4 review note).
- Canvas tokens are overridden on `.decisions-view .codev-artifact-canvas-rendered`, not on `.decisions-view`: the default theme declares them on the renderer's own root, so an ancestor override would lose.
- Cost noted: the dashboard bundle grows ~139 kB minified (1,125 → 1,264 kB) because `MarkdownView` brings markdown-it, linkify and DOMPurify — the price of baked decision 1 (reuse the canvas renderer). Lazy-loading the Decisions view would take it out of the main chunk; not done (not asked, and the chunk was already over Vite's 500 kB warning).
- Browser check (Playwright, throwaway Tower on 14819, mkdtemp workspace, viewer context `America/New_York`): 29/29. Cards in file order; PT, IANA (`Europe/London`) and `+05:30` stamps converted to EDT with the raw stamp in `title`; `IST` verbatim and marked; thread in order with one awaiting marker and the answer's continuation line; word + comment ruling and a REVIEW-comment ruling verbatim; missing-Your-word and duplicate notices; `## Ruled` closed on load, opens on click and stays open across polls; http links in a body and in `## Ruled` open a new page while the dashboard URL stays put; a repo-relative link is inert; at 390 px no page or card overflows. Desktop and phone screenshots checked by eye. First run was 28/29 only because my "no controls yet" check counted the dashboard's own textboxes page-wide; scoped to the view, it passes.
- Tests: `DecisionsView.test.tsx` rewritten for cards (39 tests), under `vi.stubEnv('TZ', 'America/New_York')` — the machine is PT, so a stamp test that passed by accident in the stamp's own zone is ruled out. Web suite 454 passed / 1 skipped (the pre-existing flaky Terminal test on main).

## 2026-10-17 · Phase 5 review (iter 1): codex APPROVE, claude APPROVE

- Acted on (follow-up `[Phase: phase_5] fix` commit): a heading with only an id rendered an empty `<h3>` and left the card with no accessible name (claude). The card is now named by its id when there is no question, and the empty heading is not rendered.
- Not acted on, deliberately: middle-click (`auxclick`) bypasses the view's click handler. The browser opens the link in a new tab, which never navigates the dashboard; for a repo-relative link that tab is a dashboard-origin URL — harmless, and the owner chose that click.
- Carried to phase 6 (claude): non-writable cards keep the inert option list; only `item.writable` cards get radios. Screenshots for the review doc are kept with the phase 5 browser script (scratchpad, not committed — binary).

## 2026-10-17 · Phase 6 (ruling from the tab) — implemented after a context refresh

- `postDecisionRuling(request)` → `{ kind: 'document' | 'refused' | 'error' }`, never throws. It shares one response interpreter with `fetchDecisions` (`requestDecisions`), so both treat anything without `ok` (the 401 text, a dispatcher `{ error }`) the same way.
- Writable cards (`item.writable`) get a `<fieldset>` radio group (accessible names like "accept Recommended merge as is"), a "Comment or question" textarea and Submit. Non-writable cards keep phase 5's inert option list (the phase 5 review note). Submit is disabled until a word is chosen or the comment is non-blank, and while that card's submit is in flight. During the flight, the radios are disabled and the textarea is read-only, so nothing typed is lost when success clears the draft.
- Added beyond the plan: a **Clear choice** button. A radio cannot be unchosen, and without it an owner who picked a word and then decided to ask a question instead would send `word` + question — which main reads as a ruling.
- Draft state lives in `DecisionsView` as one `RulingState` (drafts by item id, held drafts, in-flight ids). It is reconciled against the shown document during render (React's adjust-state-while-rendering pattern; `reconcile` returns the same object when nothing changes, so it reaches a fixpoint in one pass). Reconciling on every render, not only when a new document arrives, matters for one case. A draft whose submit is in flight is skipped. If a poll then shows the item ruled (by our own write, or by someone else's), it is not held mid-flight: success clears it; a refusal leaves it un-flighted, and the next render holds it. Mutation-checked: removing the in-flight skip fails both race tests.
- Held reasons: file gone (not-found), item left `## Open`, became a duplicate, text written under it from elsewhere, otherwise no longer writable. A held draft shows what the tab would have written (word, blank line, comment) in a selectable `<pre>`, stays until Discard (even if the item becomes writable again), and is shown in the not-found state. An empty draft is dropped, not held.
- Found in the browser, not by the tests: held drafts sit at the top of the tab, which is usually scrolled away from the card the owner was typing in. When the item still has a card (ruled elsewhere, duplicate, not writable), that card now says "An unsent draft for this item is held at the top of the tab." with a **Show it** button that scrolls the held draft into view.
- iOS: the comment box is 16px at phone width so focusing it does not zoom the page.
- Tests: new `DecisionsView.ruling.test.tsx` (33 tests; a stateful fake of `useDecisions` so tests push documents and `applyDocument` re-renders) and 10 `postDecisionRuling` cases in `fetchDecisions.test.ts`. One phase 5 test changed meaning: "options with no controls" is now about a read-only card. Web suite 498 passed / 1 skipped; `apps/web` build exit 0; `packages/codev` build exit 0; codev unit suite 6436 passed / 48 skipped.
- Browser check (Playwright, throwaway Tower on 14819, mkdtemp workspace): 34/34. Word + comment written as exactly the spliced bytes; card shows the ruling at once. An external write that adds an item at the top re-rendered in ~1.9 s with two cards' drafts intact. A draft held when main moved its item to `## Ruled`, then discarded. A ruled-elsewhere card points to its held draft and Show it scrolls it into view. An item-changed refusal (reads blocked while the item changed on disk) showed on the card with the file byte-identical and the draft kept; the resubmit after review was written. Question round-trip: question on the line after Your word → read-only → main pastes the pair and clears the question → writable with the thread → `keep` written. At 390 px: no overflow, 16px comment box, tap-choose + submit writes the word. Screenshots checked by eye.
- Seen, not changed (phase 4 text, outside this phase): the error banner reads "Could not reach Tower: Failed to fetch Showing the last version read." — a transport message has no closing period before the suffix.

## 2026-10-17 · Phase 6 review (iter 1): codex APPROVE, claude APPROVE

- Acted on (follow-up `[Phase: phase_6] fix` commit):
  - (claude) A throw from `postDecisionRuling` would have left the card stuck in "Submitting…" with its inputs read-only. The function is written never to throw, but `getAuthHeaders()` is evaluated before its guard. `onSubmit` now catches it and shows "The ruling could not be sent: …" on the card, keeping the draft. Tested.
  - (claude) The render reads the reconciled state rather than the pre-reconcile object, so it does not depend on React discarding that pass.
- Not acted on, deliberately: a `maxLength` on the comment box (claude, optional). It would silently truncate a long paste — the kind of silent loss this design avoids. The server refuses an over-long comment with a message, and the draft is kept.
- Informational (claude): the Node v26 `localStorage` shadowing locally — known since phase 4; the suite is green with `NODE_OPTIONS=--no-experimental-webstorage`, and CI runs Node 20.

## 2026-10-17 · Phase 7 (browser verification and documentation) — implemented after a context refresh

- `packages/codev/src/agent-farm/__tests__/e2e/decisions-tab.test.ts`, 8 tests: choose + comment + submit (exact bytes on disk, card shows the ruling, card read-only); external write re-renders while another card's draft survives; question round-trip (question written → main pastes the pair and clears it → thread shown → word written); a link opens a new page (served by a route, no network) and the dashboard URL stays put; file deleted → not-found, draft held with its reason and text; `.codev/config.json` `dashboard.decisionsFile` → the tab reads and writes that file, nothing appears at the default path; no file → no tab; phone width (390 px, touch) → no overflow, tap-choose + tap-submit writes the word.
- Isolation as planned: the file throws at load unless `TOWER_TEST_PORT` is set and isn't 4100 (checked both ways with a collect-only config that has no webServer or globalSetup, so nothing could reach a Tower); every workspace is `mkdtemp` in the OS temp dir (realpath'd, refused if inside the repo), driven through `/workspace/<base64url>/` with no activation — the first run confirmed none is needed — and removed in `afterAll`, which also checks the repo's own decisions file (if any) is byte-identical.
- "No tab" can't pass vacuously: it waits for the page title, which comes from the same `/api/state` response as the tab list. Mutation-checked: writing the file between the API check and the page load fails the tab assertion (Expected 0, Received 1).
- Run locally: 8/8 in ~12 s, twice, on a throwaway Tower (port 14819, isolated `CODEV_AGENT_FARM_DIR`, socket dir and test DB; `TOWER_ARCHITECT_CMD=bash`). The repo's global setup still activates the repo workspace on that Tower (pre-existing, whole-suite); its bash shellper was the only one, killed by socket-dir match. After the run: `git status --ignored codev/state/` unchanged, no temp workspaces left, no test DB in the tree.
- Local environment, not the change: `@playwright/test` 1.59.1 wants the chromium headless shell build 1217, and only 1243 is in the cache. Rather than download into the shared cache, the local runs used a scratchpad config that extends the repo's and sets `launchOptions.executablePath` (CI installs its own browser). `tsc` excludes `__tests__`, so the file was type-checked ad hoc: clean.
- Docs: a "Decisions tab" subsection under Configuration in both `agent-farm.md` trees (identical text; the two files already differ elsewhere), and a "Decisions View" entry beside Team View in `arch.md`, plus the two new files in its component tree. No hot-tier change.
- Screenshots (desktop 1280×720, phone 390×844) checked by eye; kept in the scratchpad, not committed (binary).

## 2026-10-17 · Phase 7 review (iter 1): codex REQUEST_CHANGES, claude COMMENT — all accepted

- (codex) The default config's global setup activates the repo workspace and starts an architect shell. With only `CODEV_AGENT_FARM_DIR` isolated (the minimum while the live Tower runs: the owner lock refuses a shared global.db), that shell's socket lands in `~/.codev/run`, the live Tower's socket dir — an orphan. Fix: `playwright.decisions.config.ts` (base config, `testMatch` the suite, no global setup); the default config `testIgnore`s the suite; a separate dashboard-e2e step runs it with its own `CODEV_AGENT_FARM_DIR`. Re-run: 8/8, **0** shellpers started. Collect-only: default 71 tests / 11 files without it; dedicated config exactly 8.
- (codex, claude) Screenshots committed at `codev/reviews/1819-tower-a-decisions-tab-a-ui-vie/` (85 KB + 73 KB) for the review doc to embed — reverses my earlier "binary, not committed".
- (claude) The "no tab" title wait accepts `<ws> on <tower name> overview`.
- (claude, informational) dashboard-e2e runs only on schedule/dispatch: dispatch it on this branch once pushed; record the result in the review.

## 2026-10-17 · Phase 7 review (iter 2): codex REQUEST_CHANGES, claude APPROVE — all accepted

- dashboard-e2e dispatched on the branch at `5a200fd24` (run 39058813921): success — Decisions step 8 passed (14.1 s, no retries); main step 71 tests, 67 passed, rest skipped.
- (codex) The test Tower still shared `~/.codev/run`: Tower probes/unlinks sockets there at startup and every 60 s, and its husk sweep judges shellpers against its own (empty) DB. My local script always isolated it; the documented command and CI didn't. Now enforced: `playwright.decisions.config.ts` throws before any Tower starts unless `TOWER_TEST_PORT` (≠ 4100), `CODEV_AGENT_FARM_DIR` and `SHELLPER_SOCKET_DIR` are all set. Each refusal checked collect-only; full run 8/8, 0 shellpers.
- (claude) The Decisions CI step moves to port 14101 so it can't reuse a lingering first-step Tower with a different state dir.

## 2026-10-17 · Phase 7 iteration 3 — the plan's annotator risk, now a test

- dashboard-e2e on `e20acb2a7` (run 39059250714, Decisions step on 14101 with its own state and socket dirs): success, 8/8.
- The plan's risk table says the atomic rename vs an annotator file tab open on the same file is "covered in the Phase 7 manual pass"; I had not done it. Added an e2e test instead: open a file tab on the decisions file, rule through `POST /api/decisions/rule` (temp file + rename), and the open viewer must show the new text. It does — the annotator polls mtime and re-reads by path.
- Its first run failed, and the cause is pre-existing and unrelated to the rename: the annotator takes its first mtime reading a second after it loads and adopts it as the baseline, so a write landing in that first second is never shown (until the next write). The test now writes after that first reading; 3/3 repeated, suite 9/9. Not changed (annotator, outside this spec) — goes in the review doc.

## 2026-10-17 · Phase 7 review (iter 3): codex APPROVE, claude APPROVE — porch advanced to review

- dashboard-e2e on `1c4a5a35a` (run 39059487181): success. Decisions step 9/9, no retries. Main step: 66 passed, 4 skipped, 1 flaky — `spec-823-builder-attribution.test.ts` "N=3 — attribution renders for three sibling architects" (pre-existing, untouched here, passed on retry): goes under Flaky Tests in the review.
- Not acted on (claude, minor): the state/socket-dir guards live only in `playwright.decisions.config.ts` (the port guard is also in the test file) — the config is the only way the suite runs (the default config ignores it), and it refuses before any Tower starts; the screenshots are copied from the run, so they can drift from the UI later — they are evidence for this change, dated by the run.

## 2026-10-17 · Review phase

- Merged main (42 commits behind) as `b0a84b0a0`. One conflict: `codev-skeleton/resources/commands/agent-farm.md`, where main added "Porch check overrides" at the same spot as the Decisions tab section. Kept both, Decisions first, the same order as the `codev/` copy; the Decisions sections in the two trees are still byte-identical. Main's `artifact-canvas` theme change (hover reading aid, #1802) is scoped to the composed `.codev-artifact-canvas` surface, so it doesn't affect `MarkdownView`.
- On the merged branch: build exit 0; codev unit 6451 passed / 48 skipped; web 499 passed / 1 skipped. dashboard-e2e dispatched on the merge (run 39060162578): Decisions 9/9, main 67 passed / 4 skipped, none flaky.
- Review written at `codev/reviews/1819-tower-a-decisions-tab-a-ui-vie.md` with both screenshots embedded. Six lessons routed to cold `lessons-learned.md` (Testing ×2, UI/UX ×3, Process ×1). No hot-tier change; the arch entry went in during phase 7.

## 2026-10-17 · PR #1820 review (iter 1): codex REQUEST_CHANGES, claude APPROVE

- PR #1820 opened; porch checks green. (Porch's `e2e_tests` check runs `vitest.e2e.config.ts`, not the Playwright suites, and its command ends in `|| echo …`, so it can't fail on its own; the browser evidence is the Decisions suite plus dashboard-e2e.)
- (codex) Links were inert only to a plain click; a middle-click or the context menu could still open a relative or `mailto:` link. This was claude's phase 5 `auxclick` note, which I had rebutted; the rebuttal is withdrawn. Fixed with a `DecisionsMarkdown` wrapper that removes `href` from non-http(s) anchors and gives http(s) anchors `target`/`rel`. Mutation-checked (4 tests fail without it).
- (codex) Added frontmatter to the spec and plan (`approved: 2026-10-17`, `validated: [codex, claude]`) and committed the three untracked `-context.md` files (main tracks 25 such files from other projects).
- (claude) `playwright.decisions.config.ts` declares its own `webServer` with `reuseExistingServer: false`. Watched it fail: with a server already on 14101, the run fails with "already used".
- Not changed, recorded as follow-ups: setext promotion of the Your-word line by a `---`/`===` comment in other viewers; a typed `read-failed` refusal. `--retries 3` kept (it mirrors the main step, and Playwright reports a retried pass as flaky).

## 2026-10-18 · PR gate: owner's inline-options change, then approval

- The human tried the tab and asked, through the architect, that bare words on a Your-word line (`raised` / `rotated` / `wait`) read with their meaning. The parser now fills a bare option's description from the body's **Options:** entry (`(a) \`w\` = …`, `(a) \`w\`: …`, `- \`w\` = …` list); the line's own `= …` wins, and a word with neither stays bare. Every option reads "word: description", with the Recommended badge after it. Spec Parsing section updated; parser tests for the three forms plus edge cases (fences, Q&A entries, text after the Your-word line, wrapped and blank-separated lists); a component test; the e2e fixture's ops-3 item has bare words. Commit `d6e1aae76`.
- jsdom's accessible-name computation puts a space after the `<code>` ("accept : …"), unlike a browser, so the component tests tolerate that space and the e2e suite checks the exact names in Chromium.
- Local browser runs were blocked for a while: the architect's hung `playwright install` left the shared Chromium cache incomplete. I installed a headless shell into my scratchpad instead (`PLAYWRIGHT_BROWSERS_PATH`), and moved my local port to 14819 so it couldn't collide with their run on 14101.
- dashboard-e2e run 39106067568 green (Decisions 9/9). The architect verified the change on a throwaway Tower and relayed the human's pr approval.

## 2026-10-18 · Verify: approved by the architect

- Merged with `--merge --admin` at 2c9e8ee23 after all 7 PR checks passed. The merge was blocked only for REVIEW_REQUIRED; the human authorized `--admin` for that case through the architect. Issue #1819 auto-closed.
- Post-merge, in this worktree with origin/main pulled in: build exit 0; codev decisions + tower-routes suites 329 passed; web decisions suites 118 passed. No local browser run: the shared Playwright `chromium-1217` was incomplete, and a scratchpad install stalled after the download.
- **Verify evidence (architect, live environment):** merged main built and installed locally; the production Tower on 4100, restarted after the install, reports `decisionsEnabled=true` for an adopter workspace whose real `pending-decisions.md` it serves; `GET api/decisions` answers `ok: true` with the new parser. Bare-word options resolved from the body on the architect's throwaway run of d6e1aae76. dashboard-e2e run 39106067568 covers the browser path.
