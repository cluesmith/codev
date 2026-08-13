# Unreleased

<!--
  TEMPLATE — copy to docs/releases/UNRELEASED.md at the start of each release cycle:

      cp docs/releases/UNRELEASED.template.md docs/releases/UNRELEASED.md

  Edit UNRELEASED.md across the cycle (the working copy). NEVER edit this
  template directly — it's the cold-start structure, untouched between cycles.

  Per-PR architect workflow (on the docs/vscode-changelog branch):
    1. cd worktrees/changelog                       # no fetch / no rebase — branches diverge by design
    2. Add the CHANGELOG entry to apps/vscode/CHANGELOG.md under [Unreleased]
       (add the [Unreleased] heading if it's missing — post-release state removes it)
    3. Add the matching release-notes entry to UNRELEASED.md under the right section:
         substantive change → its own ## section
         small vscode item  → Polish
         non-vscode change  → Other fixes
    4. Commit both files together; plain `git push` (fast-forward, no force)

  Why no rebase, ever: main moves with code merges, docs/vscode-changelog moves
  with changelog/release-notes entries — neither branch touches the other's
  files, so they diverge by design and reconcile at release time via merge.
  Rebasing rewrites commit hashes and forces force-pushes for zero real benefit.

  At release time:
    1. Rename the title to `# vX.Y.Z <Codename>` and add `Released: YYYY-MM-DD`
    2. Replace this entire comment block with the release Summary paragraph
       (one paragraph framing what shipped — lead with the biggest story)
    3. Fill in the Contributors section at the bottom
    4. git mv docs/releases/UNRELEASED.md docs/releases/vX.Y.Z-<codename>.md
    5. Commit, plain push, merge to main alongside the version bump
    6. Re-cp the template back to UNRELEASED.md to start the next cycle
-->

## Stream Deck+: a two-zone builder cockpit (#1410, PR #1439)

The SD+ layout becomes a stable two-zone cockpit bound by one shared selection. The top row holds four builder keys — a live window onto the fleet that the Select dial scrolls when there are more than four, with the selected builder's key visibly accented. The bottom row is a fixed action palette that always acts on the selected builder: approve its pending gate (through the usual confirmation), run its dev server, send collected review feedback, and open its terminal. Review feedback now follows the workspace's delivery mode instead of guessing: in forward mode a dial press sends the file, hunk, or selection to the builder immediately, exactly as before; in comment mode the same press quietly stages it in the shared review queue — the Send Fb key shows how many chunks are waiting and flushes them as one composed review. The dial touchstrips name the live mode ("Files · queue" vs "Files · send") so a press is never a surprise, and selection stays coherent in both directions: pressing a builder key opens its artifact in VS Code, and focusing a builder's diff or spec/plan canvas in VS Code selects that builder on the deck.

## Review comments on builder diffs (#1037, PR #1382)

A structured review mode for builder diffs: compose comments in inline threads via codelens or context menu, collect them in a per-builder queue (persists across reloads), and submit the whole review as one batched message typed into the builder's prompt for a final read-and-Enter. The frictionless one-click PTY injection stays for quick reactions; an editor toggle chooses the default surface.

## Horizontal reading mode for spec and plan review (#1380, PR #1398)

The annotation viewer can now lay documents out in side-by-side columns — newspaper flow — turning a wide monitor into three or four pages of a spec at once. Wheel and keyboard navigation are column-aware, commenting and keyboard review work identically in both modes, and protected content (code, tables, comment cards, the composer) never splits across a column edge. Vertical stays the default; the preference is per-user. Ships with a real-browser regression suite (a new CI job) that caught and fixed a latent rendering gap (#1396) before launch.

## Polish

<!-- Small vscode items as bullets:
       - **<Headline>** (#<issue>, PR #<pr>). <One short paragraph of context.>
     Move out to its own ## section if the entry grows past ~3 sentences. -->

- **Recently Closed sorted by recency** (#1191, PR #1427). The sidebar's Recently Closed section now lists items most-recently-closed first instead of the forge search API's relevance order, which could render this morning's closure below yesterday's. Fixed once at the shared assembly layer, so ordering is correct for every forge (GitHub, GitLab, Gitea, Linear).
- **Click `#N` and `PR #N` references in the terminal** (#1412, PR #1418). Issue and PR numbers in any terminal's output are now Cmd/Ctrl+clickable: `#1354` opens the issue in the in-editor viewer, `PR #1402` opens the pull request in your browser, and a bare number that turns out to be a PR opens the PR page automatically. The setting `codev.terminalLinks.issueTarget` switches bare `#N` to open in the browser instead. Claiming the reference also stops VS Code's unhelpful fallback word-search.
- **One-step open issue or PR by number** (#1179, PR #1399). Typing a number (`1350`, `pr 1350`, `view issue 1350`) into the backlog search Quick Pick surfaces direct `View Issue #N` / `View PR #N` rows that open the target in the browser in a single gesture, and a new `Codev: Open PR by ID` command (`Cmd+K Shift+P` / `Ctrl+K Shift+P`) completes the keyboard family alongside `Cmd+K I` for issues. Works across GitHub, GitLab, and Gitea.
- **Annotation viewer: in-row add-comment button** (#1343, PR #1385). The "+" now renders inside the hovered row itself (the pattern code-review tools use), eliminating the disappearing-button class the previous release only damped. Full-bleed visual refresh on code blocks and quotes; text positions unchanged.
- **Annotation viewer: keyboard-first review** (#1237, PR #1344). Review a spec or plan entirely from the keyboard: Tab between blocks, Enter to comment, Cmd/Ctrl+Enter to submit, Esc to cancel, jump keys for commented blocks and headings, keyboard-reachable minimap, and a `?` keys legend.
- **Annotation viewer: steadier, larger add-comment button** (#1236, PR #1344). The "+" no longer disappears or jumps away while the mouse travels toward it, and it's sized to the document font with a comfortable click target.
- **Annotation viewer: arrow cursor over read-only content** (#1232, PR #1344). Content shows the standard arrow instead of the text-editing I-beam; comments are added via the "+" button, links keep the pointing hand, selection/copy unchanged.

## Other fixes (dashboard, porch, infrastructure)

<!-- Non-vscode work that ships in the npm release. Same bullet shape as Polish. -->

- **`@cluesmith/codev-sdk`: the `/controller` subpath is now a true capability surface** (#1411, PR #1430). A controller (the Stream Deck plugin, a companion app) built against `@cluesmith/codev-sdk/controller` now receives exactly the five capabilities a controller needs — read the overview, workspaces, and event stream; send commands and canvas commands — via the new `createControllerClient(...)` factory, with host and admin operations genuinely absent from the returned object at runtime. A pinned export-list test keeps the surface from widening by accident. **Breaking + migration**: `./controller` no longer exports `TowerClient`; hosts that need the full client import it from `@cluesmith/codev-sdk/tower-client`.
- **Builders survive crashes with their memory intact** (#1233, PR #1356). A crashed builder session (including macOS memory-pressure kills) previously restarted as a blank slate re-reading its original prompt; it now resumes its prior conversation with a re-orientation nudge and continues working. A deliberate quit still starts fresh; repeated fast failures fall back to the old behavior automatically.
- **Building from `packages/codev` no longer produces false TS errors** (#1352, PR #1355). After the sdk split, a package-level build could fail with convincing type errors (TS2339/TS2307) that actually meant "a workspace dependency isn't built". The build now derives and builds its dependency closure straight from the pnpm graph, replacing a hand-maintained (and already drifted) build chain; docs updated to match.
- **Terminal reconnects now replay the actual screen, instantly, for any session age** (#1354, PR #1402). Opening or reconnecting to a terminal previously replayed a capped tail of the raw output stream and relied on a repaint nudge to straighten out full-screen agent sessions; a weeks-old session shipped megabytes to render one screen. Tower now serves a serialized snapshot of the session's live screen state (plus recent scrollback): kilobytes instead of megabytes, correct on arrival with no repaint dependence, and it applies to *already-running* sessions the moment Tower upgrades — no session restart needed. Any snapshot failure falls back to the old replay automatically and logs the reason.
- **Terminal replay memory is now bounded — fixes multi-GB spikes when opening long-lived sessions** (#1205, PR #1353). A full-screen agent session's replay buffer grew without limit for the life of its background process (multi-GB observed in the field), and opening the session momentarily doubled that in one allocation — the cause of system memory-pressure kills, including VS Code windows dying with "The window terminated unexpectedly (code 9)". Retention and the open-time allocation are both capped now, with cuts aligned to escape-sequence boundaries so replays render cleanly. **Upgrade note: restarting heavy long-lived sessions after upgrading still helps their background processes' memory** — pre-upgrade sessions keep their accumulated buffers until restarted (or reaped by the husk sweep). What you *see* on reconnect no longer depends on this: the screen-snapshot replay above serves old sessions correctly either way.
- **`@cluesmith/codev-sdk`: new client SDK package** (#1189, PR #1346). The single client implementation of how anything talks to Tower — environment-agnostic (browser, Node, React Native), subpath exports, auth/transport injected. `codev-core` becomes server-only; CI-enforced boundary tests keep the two from ever importing each other. First npm publish rides this release; groundwork for the Stream Deck and mobile clients.
- **Stream Deck: the review dials now follow the builder's phase** (#1400, PR #1419). The Files and Changes dials become Headings and Blocks when the selected builder is writing its spec or plan: rotate steps through the document in the review canvas, pressing the dial opens the comment composer on the focused block, tapping the Blocks dial jumps between commented blocks, and tapping Headings returns to the top. The touchstrip always names what each dial currently does, and failures are spelled out on the strip ("Open artifact", "Tower offline") instead of silently doing nothing. Diff review on implementing builders is unchanged, and a fast dial spin arrives as one batched command instead of a burst.
- **Stream Deck: one smart key per builder** (#1404, PR #1415). Fleet Slot and Builder Action are merged into a single Builder Action key: a live tile showing the builder's issue and phase, whose press now does the right thing for that phase automatically — the spec opens while the builder specifies, the plan while it plans, the diff while it implements, with a terminal as the fallback. The press also selects the builder, so the dials and the dev-server key immediately act on the builder you pressed. Choosing a fixed verb in the key's settings still works and is never overridden. The bundled Stream Deck + profile is updated to match.
- **Stream Deck: the workspace dial skips dormant workspaces** (#1403, PR #1405). Rotating the Zoom Navigator previously cycled every workspace ever registered with Tower, including dormant ones with nothing to view or act on. The dial now walks only active workspaces, and if the selected workspace deactivates mid-session the selection snaps back to a valid one (showing an empty state when nothing is active) instead of pointing at a ghost.
- **Canvas commands: one press to open or submit a review comment** (#1420, PR #1424). The canvas command vocabulary gains `composer-open-or-submit`, resolved by the canvas against its own composer state: no composer open means open one at the focused block, an open composer means submit the draft. A stateless controller can now drive dictate-and-submit from a single control without guessing composer state — a wrong guess previously risked discarding a dictated comment — and an empty draft is never submitted and never lost. The Stream Deck dial mapping that consumes it is the tracked follow-on (rest of #1420).
- **Stream Deck: hands-free comment submit and cancel in review mode** (#1425, PR #1426). Pressing the Blocks dial now opens the comment composer at the focused block, and pressing it again submits the dictated draft; pressing the Headings dial cancels. The touchstrip names each press ("Blocks · Open/Submit", "Headings · Cancel") so the two dials read at a glance, and because the canvas decides between open and submit (the command above), a press can never submit an empty comment or discard a dictated draft. Completes the hands-free dictation flow started in #1420.
- **Stream Deck: builders awaiting verify-approval are no longer a dead end** (#1431, PR #1442). A builder blocked at the verify-approval gate showed as blocked on its key but pressing it opened a terminal instead of the work to review. The press now opens the diff, as it does for the other review gates — and the review dials, which followed the same resolver, come alive at that gate too instead of doing nothing.
- **Stream Deck: quieter presses and a cleaner Run Dev key** (#1437, PR #1438). Key presses no longer flash the green success checkmark — success is silent, and only failures alert in red. The dev key joins the composite-face family (green play glyph with a "Dev" label) and is now called **Run Dev** everywhere, matching the VS Code command vocabulary.
- **Stream Deck: builder keys get a legible, state-coded face** (#1428, PR #1432). The Builder Action and Gates keys are redrawn as composed faces instead of text stamped over an icon: the icon sits in its own zone, the issue number and phase get a clean text band, colour carries state (yellow blocked, green active), and the icon shape names the gate a builder is blocked on (matching the VS Code sidebar's vocabulary, so deck and sidebar tell one story). Labels are deliberately cased and sized ("Implement", "Dev Approval") and can no longer clip mid-word or collide with the artwork.
- **Stream Deck: the smart key's diff press lands dial-ready** (#1414, PR #1429). On an implementing builder, the Automatic press now opens the builder's first changed file in per-file diff mode with the navigation dials seeded to step from there, instead of the multi-file aggregate editor. The explicit View Diff option still opens the aggregate, and every failure path (no builder selected, no worktree, no changed files) shows a status-bar message instead of silently doing nothing.
- **Drive spec/plan review from an external controller** (#1401, PR #1413). Tower gained a canvas command channel: a live registry of open annotation-canvas views plus a targeted command route, so a controller (a Stream Deck, a companion app) can navigate a spec or plan, jump between commented blocks and headings, page columns, toggle reading mode, and open or submit a review comment — all on the exact view the reviewer is looking at, with an explicit answer when no canvas is open. Exposed as `sendCanvasCommand` on the sdk's controller subpath; the command vocabulary mirrors the canvas's own keyboard shortcuts. Groundwork for hands-on-deck review; the Stream Deck actions that consume it are a tracked follow-up.
- **Stream Deck plugin joins the monorepo as `apps/streamdeck`** (#1347, PR #1387). The Elgato Stream Deck plugin (gate approvals, builder-fleet monitoring, diff-review dials, and dev-server control from a physical deck) now lives in the workspace, version-locked with every release and built on `@cluesmith/codev-sdk` as the sdk's first outside-in consumer. It ships with a bundled Stream Deck + profile and a one-command packaging script; Elgato Marketplace submission is a tracked follow-up.


## Breaking changes

None.

## Install

```bash
npm install -g @cluesmith/codev@X.Y.Z
afx tower stop && afx tower start
```

The VS Code extension ships separately via the Marketplace — `Codev` extension by `cluesmith.codev`, version `X.Y.Z`.

## Contributors

<!-- Filled at release time. Use the topic-first voice from prior release notes:
       - **<Name> (@<handle>)** — <topic>: <what they did across which PRs>.
       - Builders working under AIR / BUGFIX / PIR / SPIR protocols across the PRs in this release.
     Source: git log v<prev>..HEAD --merges --pretty=format:"%h %an %s" -->
