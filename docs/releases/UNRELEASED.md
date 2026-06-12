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

## Foundational package for cross-surface markdown artifact review: `@cluesmith/codev-artifact-canvas` (#945, PR #1027)

A new internal workspace package ships at `packages/artifact-canvas/`: a host-agnostic React library for rendering and reviewing Codev markdown artifacts (specs, plans, reviews) across surfaces (VSCode, dashboard, future mobile). Standalone in v1 and not directly visible to end users in this release. Hosts wire it up by implementing three small adapter interfaces (`FileAdapter`, `MarkerAdapter`, `ThemeAdapter`); the VSCode and dashboard integrations land in follow-up cycles.

What's in it:

- **Markdown renderer** with `markdown-it` (`html: false`) plus DOMPurify sanitization. 0-based `data-line` attribution on block tokens enables per-line marker overlay positioning.
- **`ArtifactCanvas` component**: intent-only comment overlay (emits `onAddComment(line)`, never writes markers itself), minimal v1 marker rendering, adapter-driven data flow with request-versioning, warn-once out-of-range handling, and a no-watcher `refreshKey` refresh path. Keyboard-accessible (focusable blocks, Enter/Space, ARIA).
- **Adapter contracts**: three small host-implemented interfaces. `FileAdapter` (read + watch), `MarkerAdapter` (list/add), `ThemeAdapter` (JS-side, off the v1 render path).
- **CSS-variable theming**: 8 `--codev-canvas-*` tokens plus a `./default-theme.css` export. Hosts theme by overriding the tokens; no JS theming on the render path.
- **Dual-format build** (CJS + ESM + `.d.ts`) via `tsup`. React externalized as a peer (`^18 || ^19`).
- **Smoke-test host** under `packages/artifact-canvas/examples/` with a full e2e round-trip test (mouse and keyboard), a Vite dev page, and a comprehensive README.

What it enables in subsequent cycles (already filed):

- **#859** — add review comments from the markdown preview pane (the canvas-powered comment surface in VSCode).
- **#860** — review summary webview aggregating all REVIEW markers.
- **#863** — marker-aware features in the markdown preview.
- **#1036** — raw `<!-- REVIEW -->` HTML-comment rendering (deferred from this PR's visual review; stripping shifts `data-line` accounting and entangles with host serialization).
- **#1029** — package web/native layering decision (filed during review).

Also worth a note: **#1028** — systemic tracker filed during PR review for the "prefer render-time attributes over post-render effect DOM-mutation for anything tests or accessibility tools read synchronously" pattern, surfaced from two CI-only races on this PR (an e2e overlay race and a `tabindex` race). Not a fix in this release; a tracker capturing the principle so future packages and effects in the codebase avoid the same class of race.

End-user-facing release content for this release stays the same; the canvas itself becomes visible when the next cycle's surfaces land on top of it.

## Code-review feedback: codelens in the unified diff editor injects file / hunk references into the builder PTY (#789, PR #1023)

Architect-side review used to slow down at one specific point: you'd see something in the unified diff editor, want to give the builder targeted feedback about it, switch to the builder PTY, and type the file path and line range by hand into the prompt before adding your actual feedback. The file path was the typing bottleneck — error-prone, slow, and outside the diff editor where your attention already was.

The unified diff editor now carries inline codelens entries that close that gap. Above each file header, `> Send to builder PTY` injects `path/to/file.ts ` into the builder's prompt buffer. Above each hunk header, `> Send to builder PTY (lines N-M)` injects `path/to/file.ts:L42-L58 ` (the new-side line range parsed from the hunk). Enter is never pressed; you add the freeform feedback and submit when ready. The builder is taken from the diff's context, so there's no picker and no mode error.

The same action is bound to `Cmd/Ctrl+K B` for keyboard-first use and is available as a right-click menu entry on builder files in the file tree. Direct PTY write, no `afx send` wrapper — the inject reads as if you typed it. If the builder doesn't have an active terminal, the resolver falls through to the existing terminal-manager open-terminal flow before injecting.

Modelled on the established `codev.referenceIssueInArchitect` pattern that injects `#<id> ` into the architect's prompt on backlog row clicks, extended to the builder side with file and hunk awareness.

## Polish

<!-- Small vscode items as bullets:
       - **<Headline>** (#<issue>, PR #<pr>). <One short paragraph of context.>
     Move out to its own ## section if the entry grows past ~3 sentences. -->

- **PR sidebar sorts by ownership, with a `(draft)` badge** (#787, PR #1019). The Pull Requests view used to render PRs in arbitrary forge order with no fast scan-path to the ones you'd authored or were asked to review, and no way to distinguish drafts. It now groups into one flat list ordered mine → review-requested → others, newest-first within each bucket; drafts carry a `(draft)` suffix and a draft icon. Two new fields (`reviewRequests`, `isDraft`) flow end-to-end through the forge concept; github + gitlab fully populate, gitea safely defaults because `tea pulls list` doesn't expose the fields. When `gh` is unavailable the list falls back to plain createdAt-desc with no crash.
- **CLI preflight no longer triggers a false "Get started with Codev" walkthrough on slow environments** (#1024, PR #1026). The startup CLI version probe used to cap at 400ms, too tight against the realistic 500-3500ms cold-spawn budget on remote SSH, WSL, `nvm` / `fnm` / `volta` shims, AV-scanning Windows, and network filesystems. A timed-out probe wrongly decided the CLI was missing and re-opened the walkthrough on every startup, even though `codev --version` succeeded from a terminal in the same window. The cap is now 5000ms by default and overrideable via a new `codev.cliVersionTimeoutMs` setting (range 100-60000ms) for users on extra-slow infra. Timeouts log a `[Preflight]` line to the Codev Output channel so the failure mode is diagnosable.

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
