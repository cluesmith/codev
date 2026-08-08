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

## Polish

<!-- Small vscode items as bullets:
       - **<Headline>** (#<issue>, PR #<pr>). <One short paragraph of context.>
     Move out to its own ## section if the entry grows past ~3 sentences. -->

- **Annotation viewer: keyboard-first review** (#1237, PR #1344). Review a spec or plan entirely from the keyboard: Tab between blocks, Enter to comment, Cmd/Ctrl+Enter to submit, Esc to cancel, jump keys for commented blocks and headings, keyboard-reachable minimap, and a `?` keys legend.
- **Annotation viewer: steadier, larger add-comment button** (#1236, PR #1344). The "+" no longer disappears or jumps away while the mouse travels toward it, and it's sized to the document font with a comfortable click target.
- **Annotation viewer: arrow cursor over read-only content** (#1232, PR #1344). Content shows the standard arrow instead of the text-editing I-beam; comments are added via the "+" button, links keep the pointing hand, selection/copy unchanged.

## Other fixes (dashboard, porch, infrastructure)

<!-- Non-vscode work that ships in the npm release. Same bullet shape as Polish. -->

- **Builders survive crashes with their memory intact** (#1233, PR #1356). A crashed builder session (including macOS memory-pressure kills) previously restarted as a blank slate re-reading its original prompt; it now resumes its prior conversation with a re-orientation nudge and continues working. A deliberate quit still starts fresh; repeated fast failures fall back to the old behavior automatically.
- **Building from `packages/codev` no longer produces false TS errors** (#1352, PR #1355). After the sdk split, a package-level build could fail with convincing type errors (TS2339/TS2307) that actually meant "a workspace dependency isn't built". The build now derives and builds its dependency closure straight from the pnpm graph, replacing a hand-maintained (and already drifted) build chain; docs updated to match.
- **Terminal replay memory is now bounded — fixes multi-GB spikes when opening long-lived sessions** (#1205, PR #1353). A full-screen agent session's replay buffer grew without limit for the life of its background process (multi-GB observed in the field), and opening the session momentarily doubled that in one allocation — the cause of system memory-pressure kills, including VS Code windows dying with "The window terminated unexpectedly (code 9)". Retention and the open-time allocation are both capped now, with cuts aligned to escape-sequence boundaries so replays render cleanly. **Upgrade note: only sessions started after the upgrade benefit** — long-running pre-upgrade sessions keep their accumulated buffers until restarted (or reaped by the husk sweep); restart heavy long-lived sessions after upgrading.
- **`@cluesmith/codev-sdk`: new client SDK package** (#1189, PR #1346). The single client implementation of how anything talks to Tower — environment-agnostic (browser, Node, React Native), subpath exports, auth/transport injected. `codev-core` becomes server-only; CI-enforced boundary tests keep the two from ever importing each other. First npm publish rides this release; groundwork for the Stream Deck and mobile clients.


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
