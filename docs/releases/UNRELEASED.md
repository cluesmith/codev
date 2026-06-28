# Unreleased

<!--
  TEMPLATE — copy to docs/releases/UNRELEASED.md at the start of each release cycle:

      cp docs/releases/UNRELEASED.template.md docs/releases/UNRELEASED.md

  Edit UNRELEASED.md across the cycle (the working copy). NEVER edit this
  template directly — it's the cold-start structure, untouched between cycles.

  Per-PR architect workflow (on the docs/vscode-changelog branch):
    1. cd worktrees/changelog                       # no fetch / no rebase — branches diverge by design
    2. Add the CHANGELOG entry to packages/vscode/CHANGELOG.md under [Unreleased]
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

## Builder worktree write-guard: deterministic protection against main-checkout pollution (#1018, PR #1098)

Strict-mode builders run in isolated git worktrees nested inside the main checkout. The `Write` / `Edit` tools require absolute paths, so the builder model must synthesize one; the current runtime sometimes anchors that path at the inferred canonical repo root instead of the worktree `cwd`, dropping the `.builders/<id>/` segment. The wrong path is a real writable directory (the main checkout's working tree), so the mis-write succeeds silently. Byte-identical trees at branch base mean wrong-rooted reads succeed silently too, so nothing corrects the model until a later `git add` in the worktree fails with a pathspec error. The polluted file just sits in main's working tree.

This is not a Codev regression; it is intrinsic path-synthesis drift in the builder runtime that moves across model and CLI upgrades. Instructions and per-agent memory do not hold across that drift. Only a deterministic guard does.

The guard ships as a per-worktree Claude Code `PreToolUse` settings hook. At spawn time, the harness generates `.claude/settings.local.json` plus a self-contained Node guard script (`.claude/hooks/worktree-write-guard.cjs`) inside the new worktree. The guard:

- Rejects any `Write` or `Edit` whose absolute path resolves outside the worktree root, naming the worktree root in the rejection message so the model re-roots on the next attempt. Silent main-checkout pollution becomes a loud, correctable failure.
- Allowlists scratch directories (`/tmp`, `/private/tmp`, `$HOME/.claude` for builder memory writes).
- Reads the worktree root from `CODEV_WORKTREE_ROOT` baked at spawn time (absolute), with `git rev-parse --show-toplevel` as the runtime fallback. Both are canonicalised through `realpath` so the macOS `/tmp` versus `/private/tmp` symlink difference is normalised.
- Resolves the longest-existing-ancestor before joining the tail, so paths to non-existent new files canonicalise correctly.
- Fails open on any error (bad JSON, unresolvable root, missing git). A safety net must never brick a builder; worst case reverts to today's unguarded behavior.

Coverage is deterministic across all Claude builder spawn modes: the harness installation runs in both `startBuilderSession` and `buildWorktreeLaunchScript`, in both the role-bearing and no-role branches. The `--resume` path is intentionally excluded, since it reuses an existing worktree already guarded at its original spawn. A throwaway-builder verification matrix at dev-approval confirmed: a Write to the main checkout blocks with a re-root message, a legitimate `/tmp` write passes, a worktree-rooted Write passes and lands in the worktree, a `~/.claude/...` memory write passes, and a genuine sibling-thread cross-checkout read still works (reads are unaffected by this issue).

A role-doc backstop in `roles/builder.md` and `codev-skeleton/roles/builder.md` names the failure mode so the model has a chance to self-correct even when the guard is removed or bypassed. Backstop only; instructions do not hold across model drift.

Scope decision recorded at the plan gate: builder-only. The consult sub-agent read surface (issue #1092) is the architectural cousin of this guard but is intentionally out of scope. The guard module is factored so its boundary logic can later back a consult-side hook without duplication. #1092 stays open as a separate, lower-severity issue (mostly self-healing: the SDK's not-found error includes a cwd note that lets the model re-root, asymmetric to the silent-success path #1018 addresses).

## Tower command relay: external controllers can drive the active VS Code editor (#1087 / #1088 / #1089, PR #1091)

A new Tower-side command channel lets external controllers (a Stream Deck device, a hosted page, a CLI script, anything that can POST to Tower) drive the active VS Code window with a canonical set of verbs. Codev's VS Code extension exposes an allowlist-gated provider that subscribes to a Tower SSE stream and dispatches a small set of verbs to existing commands. This is the substrate that the separate Codev Stream Deck integration sits on; Codev does not ship a Stream Deck client itself, just the protocol surface.

What ships in this PR:

- A new wire contract for `CommandRequest` carrying `{ verb, args, workspace? }`. The verb-map is the security allowlist: only declared verbs reach the provider. Live verb set as of this release includes the four palette-and-keyboard commands listed below plus `view-diff`, `spawn-builder`, `run-dev`, `workspace-dev-start`, and `workspace-dev-stop`.
- A Tower HTTP route `POST /api/command` that broadcasts the request as an SSE envelope to active providers. The route sits behind Tower's existing `isRequestAllowed` auth gate so it inherits Tower's posture rather than bypassing it.
- A VS Code-side provider (`command-relay.ts`) that subscribes to the SSE stream, gates on `vscode.window.state.focused` for single-active-provider semantics (the focused window wins; an unfocused window stays idle), applies workspace scoping (drops events whose `workspace` field doesn't match `getWorkspacePath()`), and dispatches to the existing command via `executeCommand`. The workspace filter mirrors the precedent set by `builder-spawned` cross-workspace handling in `builder-spawn-handler.ts`.
- Four new commands wired into the relay's allowlist plus the command palette plus keyboard surfaces: `codev.forwardCurrentFileToBuilder` (forwards the cursor's current file path to the active builder PTY), `codev.forwardCurrentHunkToBuilder` (forwards the cursor's current hunk), `codev.diffFirstFile` and `codev.diffFirstHunk` (jump to the first file or first hunk in a View Diff session, completing the existing keyboard walk shipped in PR #1067 and PR #1075).
- A shared SSE envelope deduplication helper (`sse-envelope.ts`) so multi-subscriber streams don't double-dispatch.

The workspace-scoping field is defensive infrastructure landed ahead of demand: no controller populates it today, so the focus-gate is the only filter in active use. As soon as a controller starts addressing specific workspaces, the provider already does the right thing without further extension-side code change. The privileged verbs (`spawn-builder`, `run-dev`, `workspace-dev-start`, `workspace-dev-stop`) are safe to ship today because the focus-gate prevents accidental cross-workspace dispatch, and the workspace field is ready when controller-side addressing lands.

CMAP-3 caught and the author addressed two findings at review time: the four new commands now appear in the manifest (so they're palette-discoverable and keybindable, not just relay-callable), and the workspace-scope filter was added as described above (originally the relay was focus-gate-only, which the reviewer flagged as insufficient for multi-workspace setups). The defensive workspace filter is the second-place issue from the reviewer's three-option recommendation, kept in scope because it's separable from controller-side scoping and prevents a real wrong-target risk on the privileged verbs.

## Activity hooks: VS Code publishes events to URLs you declare (PR #1105)

The outbound-direction sibling of the controller-agnostic command relay (#1091). The VS Code extension now publishes two abstract activity events to URL templates you declare in personal config: `window-focus` (fires when a Codev workspace's VS Code window gains focus) and `builder-active` (fires when you switch focus to a specific builder via terminal, sidebar selection, or its diff editor). Each event interpolates `{workspace}` and `{builder}` into the URL template (URL-encoded; absent keys collapse to empty) and asks the OS to open the result, so anything that can register a URL scheme — a hardware controller, a desktop companion app, a hosted control page, a webhook receiver — can react to which workspace and which builder you're focused on.

Example personal config (`~/.codev/config.json` to follow you across every workspace, or `.codev/config.local.json` to scope to one repo):

```jsonc
{
  "activityHooks": [
    { "on": ["window-focus", "builder-active"],
      "url": "<scheme>://...?workspace={workspace}&builder={builder}",
      "background": true }
  ]
}
```

Three security postures bake in by default:

- **Hooks resolve from personal config layers only.** `~/.codev/config.json` (global) and `.codev/config.local.json` (gitignored per-project) feed the hook resolver; the committed `.codev/config.json` is **excluded**. Hooks open URLs, so a hook URL committed in a malicious repo would be a zero-click execution surface on workspace open. Personal-layers-only closes that.
- **The extension is fully disabled in untrusted workspaces** (VS Code Restricted Mode). The `package.json` `untrustedWorkspaces` capability is intentionally omitted entirely (not set to `'limited'`) so VS Code's own trust gate covers every Codev surface, not just hooks — the committed `worktree.devCommand` (the runnable-worktree dev-server command) is a sibling attack surface that the same gate now also closes.
- **URL opens route through `vscode.env.openExternal`.** Hooks reach the *local* client when you're using remote dev (SSH / WSL / Codespaces), where the handler app actually lives, instead of running on the extension host. Cross-platform shell-quoting pitfalls (a Windows `cmd /c start "" url` treating an `&` in the URL as a command separator) go away in the same change.

Inert by default — no `activityHooks` declared means zero behaviour change. A url whose handler isn't registered fails fast and pauses hooks for the window after one warning, rather than relaunching a doomed process on every event. `builder-active` is de-duplicated across the three subscription sources (terminal focus, sidebar selection, diff focus) so rapid navigation within one builder doesn't relaunch the same URL repeatedly.

The shared codev-config-watcher (a rename of the earlier worktree-config-watcher, behaviour-preserving) carries the SSE event that signals an edit to `.codev/config(.local).json`, so an activity-hooks edit fans out the same `codev-config-updated` event the worktree-config view already reacts to — one watcher per workspace, not one per consumer.

## Agents view: a three-way group-by axis and conversational Add Architect (#1104, PR #1106)

The Builders tree is now called **Agents**, and its title-bar button cycles the grouping axis between three modes instead of toggling between two:

- **Stage** (the default action axis): groups by lifecycle stage — `SPECIFY → PLAN → IMPLEMENT → REVIEW → PR → VERIFIED` — for "where do I need to act?" triage. Row prefix carries the complementary `area/*` label.
- **Area** (the domain axis): groups by `area/*` label matching the Backlog view, for "what's happening in this subsystem?" triage. Row prefix carries the complementary lifecycle phase.
- **Architect** (the new ownership axis): groups by the architect that spawned each builder (`spawnedByArchitect`), `main` first then alphabetical. Row prefix carries the complementary lifecycle stage. Answers "who's running what?" — the question multi-architect workspaces couldn't answer at a glance before.

The cycling button's icon shows the axis you'll switch *to* on the next click (VS Code toolbar buttons have no pressed state, so the icon-as-next-target affordance keeps the cycle obvious without one): the area `$(tag)` icon visible in stage mode, a custom octopus icon visible in area mode, and the stage `$(milestone)` icon visible in architect mode. The octopus is the architect-axis glyph — one body with many arms representing one orchestrator spawning many builders — and renders as a theme-adapting monochrome SVG pair (light / dark) matching the codev-light / codev-dark convention.

In architect mode only architects that *own in-flight builders* appear as group headers — childless architects (like `REVIEWER` between assignments) don't clutter the work view. The full architect roster, including childless ones, remains in Workspace > Architects which is the canonical full-roster surface for launching architect terminals and adding new architects. The view-id renames `codev.builders` → `codev.agents` to match the new framing; setting keys (`codev.buildersAutoCollapse`, `codev.buildersFileViewAsTree`, `codev.buildersGroupBy`, `codev.buildersAutoReveal`) intentionally retain their `builders*` prefix — they're internal setting names and renaming them would force a user-facing migration with no behavioural benefit.

A separate but related change ships in the same PR: **Add Architect is now a conversation with main, not a direct CLI call**. The `Codev: Add Architect` action (and the `Cmd+K A` / `Ctrl+K A` keybinding from v3.2.1) no longer runs `afx workspace add-architect` directly. It now asks the `main` architect — the workspace orchestrator that owns backlog triage, release decisions, and architect-roster management — to create the new architect:

1. VS Code prompts for the architect name (validated against the same rule Tower enforces server-side, shared with the CLI for parity).
2. The extension dispatches `client.sendMessage('architect:main', 'Please add a <name> architect.')`.
3. Main receives the request, decides whether the specialisation makes sense (may push back, may ask for scope), runs `afx workspace add-architect --name <name>` from its own terminal, sends the brief as the new architect's first message, and updates its working memory.
4. The roster updates automatically via the existing `architects-updated` SSE — no extension-side refresh needed.

The rationale: architect creation is a workspace-orchestration event — it changes the roster, the specialisation matrix, and the conversation routing. Main is the workspace orchestrator; architect creation belongs in main's lane for the same reason cross-cutting work and release decisions do. Letting any developer create an unbriefed architect via direct CLI call leads to architect proliferation, missing briefs, and roster drift. The handler refuses with an informational modal pointing at `afx workspace start` (or the CLI fallback `afx workspace add-architect --name <name>`) when no main session is active — the action's contract is "ask main to add", so without main there's nothing to ask.

Originally the design was a nested architect tier (architect → area/phase → builder, with passive architects rendering as leaf rows). At the dev-approval gate the running tree showed three problems: it duplicated Workspace > Architects, the single-architect collapse rule introduced a layout shift on adding a second architect, and architect-tier headers competed with area/stage headers for visual hierarchy. The pivot to the flat 3-way axis resolves all three, with the honest trade that ownership becomes a button away rather than always visible per-row. The PR description and the issue body name the trade-off explicitly so it's not invisible at release time.

## Polish

<!-- Small vscode items as bullets:
       - **<Headline>** (#<issue>, PR #<pr>). <One short paragraph of context.>
     Move out to its own ## section if the entry grows past ~3 sentences. -->

## Other fixes (dashboard, porch, infrastructure)

<!-- Non-vscode work that ships in the npm release. Same bullet shape as Polish. -->

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
