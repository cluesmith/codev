# spir-843 thread — W3C-standard HTML annotator with inline JSON-LD storage

## 2026-05-24 — Specify phase: initial spec drafted

Wrote `codev/specs/843-w3c-standard-html-annotator-wi.md`.

Key architectural decisions baked into the draft:

- **Iframe sandbox preserved** as `sandbox="allow-scripts"` (null origin). Annotator JS runs *inside* the iframe via injection-into-srcdoc; parent <-> iframe communication via `postMessage`. Alternative (relaxing sandbox to `allow-same-origin`) is explicitly rejected on security grounds — that would let iframe scripts hit Codev's tower origin.
- **No new server endpoints.** Save reuses `POST /api/annotate/:tabId/save` — the JSON-LD block is part of the file. Single source of truth.
- **Apache Annotator pre-bundled** into `packages/codev/templates/vendor/apache-annotator.min.js`, same vendor pattern as marked/prism/purify. No build step on user's machine. License is Apache-2.0; NOTICE handling called out in Constraints.
- **Trigger**: NO new CLI flag or extension-routing change. HTML still opens in source-view annotate mode by default. The new prose annotator surfaces only after user clicks **Preview** then **Annotate prose** (new toggle). Zero regression on existing flows.
- **Orphan handling**: persist with `[orphaned]` badge + captured quote; never auto-delete.
- **Author**: pull from `git config user.name/email`, server-side, populate W3C `creator` field.

Open questions for architect (Q4-Q7 in spec): source-view auto-refresh after Preview save, nested-iframe handling, schemaVersion forward-compat, per-author highlight color (defer).

Next: run 3-way consult (gemini/codex/claude), revise, then commit and signal spec-approval gate.

## 2026-05-24 — 3-way consult complete, spec revised, spec-approval gate reached

Consultation verdicts:
- Gemini: REQUEST_CHANGES (3 findings, 2 critical)
- Codex: REQUEST_CHANGES (5 findings)
- Claude: COMMENT (9 findings, 1 deferred to plan)

Most important catches:
1. **Gemini #1 + Codex #1 + Claude #8** — Q3 originally claimed server-side `getAuthor()` resolution; in reality the save endpoint is a dumb pass-through and the existing line-based annotator hardcodes `(@architect)`. Switched to template substitution (`{{GIT_USER_NAME}}` / `{{GIT_USER_EMAIL}}` injected at render time in `tower-routes.ts:2480+`).
2. **Gemini #2** — Approach 1's iframe bridge would have leaked Codev's injected vendor `<script>` tags into saved files. Now requires string-splicing on a pristine source-HTML string instead of live-DOM serialization.
3. **Claude #7** — Apache Annotator pinned to non-existent `^0.3.0`. Corrected to `0.2.0`.

Spec gained 3 new structural sections (JSON-LD Contract with explicit `@context`, Save/Persistence Model, postMessage Protocol with 7-row message-type table) and 4 new Success Criteria. Q3/Q4/Q6 promoted from open questions to baked-in requirements. Q8 added (panel interaction in source view).

Commits: `46cdd72c` (initial draft) → `ed66a9f0` (revised after consult). Rebuttal at `codev/projects/843-w3c-standard-html-annotator-wi/843-specify-iter1-rebuttals.md`.

Now at spec-approval gate. Notifying architect; STRICT mode means I do not auto-approve.

## 2026-05-27 — Iter2: architect inline-comment review → spec rev-3

Architect added 4 inline `<!-- REVIEW(@architect): ... -->` comments on the rev-2 spec at the spec-approval gate:

1. **HTML preview should be the default mode** (was: source-view annotate).
2. **"Annotate prose" toggle should be on by default** (was: opt-in click).
3. **Unification concern** — less about prose-vs-line, more about a unified experience; ideally drop line annotations from markdown too.
4. **GitHub review concern** — how do reviewers see HTML annotations in GitHub PRs?

Spec rev-3 changes (in `codev/specs/843-w3c-standard-html-annotator-wi.md`):

- **Desired State** rewritten: `.html` files land in Preview mode with prose annotation on by default. Source view reachable via toolbar. Pre-existing line REVIEW comments stay readable in source view + panel — no migration, no breakage.
- **New subsection "Unification direction (HTML-now, Markdown-next)"**: HTML as headline now, markdown unification as an explicit follow-up. JSON-LD format is content-type-agnostic (selectors anchor to rendered DOM, not source lines), so the same storage shape can extend to markdown later without a contract change. Code keeps line annotations — code review is inherently line-anchored.
- **New section "GitHub Review Considerations"**: Documents PR-diff visibility — annotation JSON fields (`body.value`, `selector.exact`, `creator.name`, `created`) are plain-text-readable; `<mark>` overlays don't render; spatial context requires `gh pr checkout && afx open`. Two non-blocking future improvements listed.
- **Q1 resolution rewritten**: default-Preview, not opt-in.
- **Functional success criteria**: split into 3 bullets covering Preview-default landing, toggle-default-on, source-view-reachable-via-toolbar.
- **Test Coverage**: added E2E "default-mode regression" scenario.
- **Constraints "No regression"**: softened from "purely additive" to "no regression to *capabilities*" — default *mode* changes; all capabilities are reachable.
- **Notes**: rewritten to match rev-3 framing.
- **Expert Consultation**: structured into Iteration 1 (rev-2) and Iteration 2 (rev-3) sub-sections.

Re-running 3-way consult (gemini/codex/claude) on rev-3 to catch any regressions vs rev-2 baseline (especially malformed-block, script-leak, template-substitution invariants).

Outputs landing in `codev/projects/843-w3c-standard-html-annotator-wi/843-specify-iter2-{gemini,codex,claude}.txt`.

## 2026-05-27 — Iter-2 consult results

Verdicts:
- **Gemini**: COMMENT (4 findings — 2 critical: fileLines sync data loss, `</script>` injection escaping; 2 minor: async refactor signature, alleged hardcode misread)
- **Codex**: REQUEST_CHANGES (4 findings — version contradiction, malformed-block scope, line-panel-click in Preview, preview-save persistence)
- **Claude**: COMMENT (4 findings — version contradiction [overlap], missing `clientRect`, Q4 rationale wording, save-purity test gap)

12 distinct findings across reviewers; 11 incorporated into rev-3 spec, 1 rejected as factual misread (Gemini G4: claimed spec referenced `(@codev-skeleton/roles/architect.md)` — spec actually says `(@architect)`, verified via grep).

Most consequential additions to rev-3 from this consult round:
1. **`fileLines` sync requirement** on `content-changed` postMessage (Codex+Gemini, same root issue): parent MUST refresh both `currentContent` AND `fileLines = html.split('\n')` before `saveFile()`, otherwise `fileLines.join('\n')` writes stale source.
2. **`</script>` injection escaping** in Approach 1: pristine HTML embedded in the bridge script must escape `</script>` to `<\/script>`. New test scenario #11.
3. **Malformed-block invariant rescoped**: applies only to annotator-driven write paths, not to user-driven source-mode hand-repair.
4. **`clientRect` in `selection` payload**: iframe is null-origin; parent can't read selection geometry, so iframe must include it.
5. **Line-annotation panel-click semantics in Preview**: implicit mode-switch with "↩ source" iconographic hint.
6. **Apache Annotator version pin** consistent at `0.2.0` (Assumptions/Dependencies/Risks all aligned).
7. **Save-purity test scenario** (Functional Test #10): explicit assertion saved files contain no injected scripts/marks.

Full disposition in `codev/projects/843-w3c-standard-html-annotator-wi/843-specify-iter2-architect-rebuttal.md`.

Spec now ready for `spec-approval` gate signaling.

### afx send architect — NOT_FOUND from this worktree

Tried `afx send architect`, `afx send architect:main`, and `afx send codev:architect` — all return `NOT_FOUND`. From inside the worktree, `afx status` reports "Workspace: not active in tower" even though Tower itself is running with 4 active workspaces. The worktree cannot resolve its spawning architect via Tower's address book in this state. Did not `cd` to the main workspace root to retry (auto-mode classifier and the user's documented `afx-from-worktree` prohibition both correctly block that path).

**Architect discovery hints** (from the main workspace, the architect can find this rev-3 work via):
- `porch status 843` — confirms gate is still `spec-approval` / pending.
- `git log builder/spir-843` — rev-3 commit is `f88a5e03`.
- `cat .builders/spir-843/codev/state/spir-843_thread.md` — this thread, with both iterations.
- `cat .builders/spir-843/codev/projects/843-w3c-standard-html-annotator-wi/843-specify-iter2-architect-rebuttal.md` — full per-finding disposition.
- The four inline `<!-- REVIEW(@architect): ... -->` comments have all been removed from `codev/specs/843-w3c-standard-html-annotator-wi.md` and replaced with corresponding spec text changes.

If the architect was relying on `afx send` for the gate-ready notification, that channel is silent. Pending gate is visible via `porch pending` and via this thread.
