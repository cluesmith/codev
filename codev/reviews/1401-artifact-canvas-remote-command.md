# Review: Artifact-Canvas Remote Command Channel (Tower relay + sdk route)

**Spec**: [codev/specs/1401-artifact-canvas-remote-command.md](../specs/1401-artifact-canvas-remote-command.md)
**Plan**: [codev/plans/1401-artifact-canvas-remote-command.md](../plans/1401-artifact-canvas-remote-command.md)
**Issue**: #1401 · **Branch**: `builder/spir-1401`

## What shipped

A generic bridge that lets anything outside the canvas drive an open artifact-canvas view, built
so the Stream Deck (#1400) is the first consumer rather than the only possible one.

| Layer | What it does |
|---|---|
| `codev-types` | The closed 14-command vocabulary, wire and client error unions, request/result/registry/event shapes, route and event names |
| `artifact-canvas` | One named implementation per action, a `CommandAdapter` seam, and a focus-derived cursor giving remote commands a defined origin |
| Tower | A registry of live canvas views plus a targeted `/api/canvas/*` route that resolves exactly one view and answers explicitly |
| sdk | `sendCanvasCommand` on the controller subpath, and host-side register/heartbeat/unregister |
| VS Code | Each canvas panel registers as a view, heartbeats, reports activity, and runs the commands addressed to it |

53 commits, 46 files, roughly +5400 lines.

## Requirements traceability

| Issue requirement | Where it landed |
|---|---|
| 1. Canvas command channel over existing plumbing | `CommandAdapter` + delivery over Tower's existing SSE stream; no new transport |
| 1a. Vocabulary mirrors the keyboard exactly | `Record<CanvasCommand, …>` registry; keyboard and remote run the same functions |
| 1b. Composer open/submit/cancel in, text entry out | All three commands present; bodies are still typed on the keyboard |
| 2. Tower surface accepting one command and relaying it | `POST /api/canvas/command`, addressed SSE delivery |
| 3. sdk route, reviewed by the streamdeck architect | `sendCanvasCommand`, reviewed at design time and again at phase 5 |
| 4. Target rule decided at spec time | Zero → `no-canvas` (404); many → single most-recently-active; never a silent no-op |

## What the reviews changed

Every phase went through a three-way consultation. Six findings were substantive enough to
change the design rather than the wording, and they are the honest story of this project.

**A guard that could not fail (phase 1, then again in phase 3).** The exhaustiveness guard for
the command vocabulary was written as a bare conditional type alias, which constrains nothing: an
omitted member resolved to `never` and compiled. It was caught in phase 1, and I reintroduced the
identical mistake in phase 3 while a comment claimed enforcement. Both are now
`Assert<T extends true>` and both were verified by deliberately breaking them. A guard is not a
guard until you have watched it fail.

**A test that never ran (phase 1).** The type-test guard lived outside `src/` so it would not be
published, which also meant `pnpm build` never compiled it and no CI job invoked it. It protected
nothing while looking like protection. Now wired into `test.yml`.

**Literal keyboard parity would have been a no-op (spec phase).** The in-page handlers derive
their origin from the DOM event, and a remote command has no event, so eight of fourteen commands
would have done nothing in the feature's primary scenario. The spec was rewritten to *effect*
parity with a defined origin: live focus, then the last focused block, then the topmost visible
block, then the first block.

**The lease renewed itself under traffic (phase 4).** Command delivery refreshed the liveness
stamp as well as the recency stamp, so a dead host's view stayed alive exactly as long as a
controller kept driving it. The guarantee the phase exists to provide silently inverted into
"always reports success at a canvas nobody can see". Delivery now advances recency only.

**A response shape accepted on faith (phase 5).** `sendCanvasCommand` checked only for an `ok`
field, so a success without a target, or a failure with a code outside the union, passed through
as a typed verdict. Now validated completely; anything unverifiable is reported as `unreachable`.

**`check-types` was red while everything I watched was green (phase 3).** I ran the typecheck
before adding a Playwright spec, then re-ran only the unit and browser suites, which pass without
project-wide type checking. The rule I now follow: run `check-types` after the last *file* is
added, not after the last logic change.

## Ground-truth corrections

Two things the issue and spec assumed turned out to be false, and both were corrected with
architect authorization rather than worked around:

- **`afx open` does not serve the canvas.** It serves the legacy `open.html` annotator; the canvas
  migration is #1386. The bridge was therefore designed host-agnostic, and #1386's page becomes a
  second registrant with no protocol change.
- **VS Code cannot open two canvas panels for one document** (`supportsMultipleEditorsPerDocument:
  false`), so the spec's "split editor" example was impossible. The MRU rule is unaffected and
  still needed; only the verification venue moved to the Tower registry. The flag was deliberately
  not flipped, since that would change user-visible editor behavior far outside this issue.

## Dispositions for the PR gate

- **Controller subpath exposure.** Codex asked that the new host-side registration methods be
  unreachable through `@cluesmith/codev-sdk/controller`. They are not re-exported, but the subpath
  exports the `TowerClient` class, which carries 39 public methods including `addArchitect`,
  `killTerminal` and `sweepHusks`. The three added here are no more reachable than the
  thirty-six that predate them, so this is a pre-existing property, not a regression.
  **Streamdeck stakeholder verdict: accept as-is for #1401.** The structural fix is tracked as
  **#1411** (restricted controller client), sequenced after this merge.
- **The `file?` selector is not speculative.** #1400 was revised on 2026-08-11 to file-qualified
  targeting: the deck will send both `workspace` and `file`, with MRU as the recorded fallback.
  How the deck discovers the artifact path is a #1400 question.
- **Playwright port collision (#1407).** The canvas browser config pins port 5199 and reuses any
  existing server, so an orphaned vite process from a since-removed worktree silently served
  deleted code to my first run. The orphan was cleared during this project and the suite now runs
  against the committed config. The structural fix (per-worktree port) is #1407.

## Testing

| Suite | Result |
|---|---|
| `codev-types` compile-time guards | Pass, and verified to fail on an unclassified command |
| artifact-canvas unit | 173 pass |
| artifact-canvas Playwright | 39 pass, including 5 new remote-command specs |
| Tower relay unit | 27 pass, lease expiry driven by an injected clock |
| Tower relay e2e | 5 pass against a real booted Tower |
| sdk | 98 pass, including 9 malformed-response cases |
| streamdeck boundary | 63 pass, unchanged |
| VS Code extension | 789 pass, including 12 new host-glue tests |
| Repo | 4847 pass, build green, repo-wide `check-types` clean |

**Human verification of the canvas half** (2026-08-12): the dev examples page was driven from the
browser console through `window.__canvasCommand` and confirmed working by the user. Three things
made it briefly look broken and are worth knowing: the call returns `undefined` because it is
void, the only visible effect of navigation is the focus ring moving, and the sample document has
exactly one commented block so a second `comment-next` is a correct no-op.

### Outstanding: the end-to-end VS Code pass

**This has not been performed, and it is the one criterion automation cannot cover here.** It
needs a real VS Code window with the extension loaded, a running Tower, and an open canvas panel.
Everything on either side of that seam is verified, but no automated test exercises the real
extension registering with the real Tower and a real command reaching the real webview.

*Correction to the plan.* The plan's phase 6 test plan claims the webview has no `check-types`
coverage, on the grounds that `apps/vscode/tsconfig.json` excludes
`src/markdown-preview/webview`. That is wrong, and the phase 6 review caught it: a second config,
`tsconfig.webview.json`, covers exactly that directory, and the package's `check-types` script
runs both (`tsc --noEmit && tsc --noEmit -p tsconfig.webview.json`). The webview adapter *is*
typechecked. The manual pass is still required, but for the ordinary reason — types do not prove
runtime behavior across three processes — not because the code is unchecked.

Suggested pass for the reviewer:

1. Open a spec in the Codev Markdown Preview with Tower running.
2. `curl -X POST localhost:4100/api/canvas/command -H 'Content-Type: application/json' -d '{"workspace":"<abs path>","command":"comment-next"}'` and watch focus move.
3. Close the panel, repeat, and confirm the response is `404 no-canvas` rather than a silent success.
4. Drive `composer-open`, type a body on the keyboard, then `composer-submit`, and confirm exactly one comment is written.

## Flaky Tests

None encountered.

## Follow-ups

- **#1411** — restricted controller client / capability surface (streamdeck architect, after this merge).
- **#1407** — per-worktree Playwright port for the canvas browser suite.
- **#1400** — the deck actions themselves, unblocked by this bridge.
- **#1386** — `afx open` onto the canvas; that page becomes a second registrant with no protocol change.
