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
