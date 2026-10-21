# Review (PR) iteration 1 — rebuttals

Reviews: codex REQUEST_CHANGES, claude APPROVE (four minor notes). All three codex points are
accepted and fixed. Of claude's notes, one is fixed and three are recorded as follow-ups or
explained below.

## codex 1 — non-http(s) links are not fully inert (accepted, fixed)

Codex is right. The view's click handler covered an ordinary click only. A middle-click, the
context menu's "Open link in new tab", or a keyboard shortcut could still open a relative,
fragment or `mailto:` link, because its `href` was still there. The spec says other links are
inert, so this did not meet it. claude raised the middle-click case in phase 5 and I rebutted it
as harmless; that rebuttal is withdrawn.

Fix (`apps/web/src/components/DecisionsView.tsx`): every `MarkdownView` in the view now renders
through a small `DecisionsMarkdown` wrapper. After each new render of the markdown, it applies the
rule to the anchors themselves:
- an `http(s)` anchor gets `target="_blank" rel="noopener noreferrer"`, so any way of opening it
  opens a new tab without an opener;
- every other anchor loses its `href`, so it is no longer a link (no `link` role, not focusable)
  and nothing can open it.

The click handler stays as it was, so a plain click still calls `window.open(href, '_blank',
'noopener')` and never navigates the dashboard. The shared renderer, which VS Code also uses, is
unchanged.

Tests (`apps/web/__tests__/DecisionsView.test.tsx`):
- the `http(s)` cases assert `target` and `rel`;
- the inert cases (repo-relative, `mailto:`, `#fragment`) assert there is no `href` and no `link`
  role;
- a new test re-renders with different markdown and checks the rule is applied again.

Mutation-checked: without the `removeAttribute`, four tests fail. Web suite green, type-check clean.

## codex 2 — the approved spec and plan lack frontmatter (accepted, fixed)

Both gates were approved by the human on 2026-10-17 (recorded in `status.yaml`). The spec and
plan now start with `approved: 2026-10-17` and `validated: [codex, claude]`, the form recent
projects use (e.g. 1470).

## codex 3 — untracked `-context.md` consultation files (accepted, fixed)

`codev/projects/` on main already tracks 25 such files from other projects. The three for this
project (`1819-phase_1-iter2-context.md`, `1819-phase_7-iter2-context.md`,
`1819-phase_7-iter3-context.md`) are committed with this round. The other untracked paths in the
worktree are builder scaffolding (`.builder-*`, `.claude/hooks/`). They are not project
artifacts, so they stay untracked.

## claude (minor) — `reuseExistingServer: true` inherited by the Decisions config (accepted, fixed)

The guards proved the environment variables were set, but not that the server already on the port
was started with them. `playwright.decisions.config.ts` now declares its own `webServer` with
`reuseExistingServer: false`, so a server already listening on the port (for example, a stale
test Tower started with other dirs) fails the run instead of being reused.

## claude (minor) — a comment starting with `---` or `===` can setext-promote the Your-word line in other viewers (follow-up)

This is true for strict CommonMark renderers such as the annotator preview or GitHub. The spec
declares setext non-structural on purpose, and neither the tab's grammar nor `main`'s scan is
affected, so the tab and the hub read the file correctly. Refusing those comment lines would add
a refusal the spec does not define. It is recorded as a follow-up in the review.

## claude (minor) — read-path I/O errors are not a typed refusal (follow-up)

Correct. EACCES, ELOOP and ENOTDIR on the read path reach the dispatcher's generic 500. The tab
shows "Unexpected response from Tower (HTTP 500)" over the last document, and nothing is lost.
Writes have `write-failed` because a write failure has a draft to protect. A symmetric
`read-failed` code is a small follow-up, recorded in the review.

## claude (minor) — `--retries 3` on the CI Decisions step (kept)

The step mirrors the existing Playwright step's `--retries 3`, so the two suites behave the same
on a slow runner. A retry does not hide flakiness: Playwright reports a test that passed on retry
as flaky in the run's summary, which is how the pre-existing `spec-823` flake was found in run
39059487181. Every Decisions run recorded in the review passed with no retries.
