# Rebuttal — Phase 5 (Re-orientation assembly), iteration 6

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

**Accepted in full.** Two APPROVEs would have shipped this. The dissenter is right, and the finding is a
real defect on a live path — not a repeat of the iteration-5 dispute, which was about a field that does
not exist on `TemplateContext` at all.

---

## Codex — REQUEST_CHANGES

### Issue 1: "`input_description` is reconstructed incorrectly for issue-driven protocols"

**Accepted.** Verified before acting, field by field:

1. **`input_description` *is* on `TemplateContext`** — unlike `artifact_name` in iteration 5. This is the
   distinction that makes the two findings different in kind, and it is why this one stands.
2. **Every spawn entry point populates it, with four distinct values**:
   - `spawn.ts:455` — `the feature specified in ${specRelPath}` (spec-driven)
   - `spawn.ts:543` — `an ad-hoc task`, plus `task_text` (`--task`)
   - `spawn.ts:607` — `running the ${PROTOCOL} protocol` (protocol-only)
   - `spawn.ts:837` — `work for GitHub Issue #${issueNumber}` (issue-driven)
3. **Live templates render it**: `{{input_description}}` is line 3 — the *first content line* — of
   `bugfix`, `air`, `aspir` and `spir` `builder-prompt.md`.

My implementation produced **two** of those four. A BUGFIX or AIR lane has no spec, so it fell through to
the fallback and a reset builder was told it was *"running the BUGFIX protocol"* instead of *"work for
GitHub Issue #1288"*. On exactly the lanes where the issue body **is** the spec, the opening line of the
prompt dropped the one thing identifying what the builder is working on.

A second, quieter defect in the same expression: my fallback read `the ${PROTOCOL} protocol`, where spawn
writes `running the ${PROTOCOL} protocol`. Even the branch I did implement was not spawn-equivalent.

**Changed** — `buildInputDescription()` now mirrors all four spawn entry points, with each branch
annotated by the `spawn.ts` line it reproduces.

**One thing Codex did not flag, found while fixing it.** The obvious branch order is wrong. A `--task`
builder gets a porch project keyed on its *builder id*, and `context.ts` falls back to
`issueNumber: issueNumber ?? porch?.projectId` — so `issueNumber` is populated for task builders too.
Testing `issueNumber` before `taskText` would route every task builder down the issue-driven branch and
announce a GitHub issue that does not exist. The order is spec → task → issue → protocol-only, and it is
documented as load-bearing at the function so a later reader does not "tidy" it. Reconstructing the task
lane at all required carrying `taskText` (already persisted as `builders.task_text`) through
`ResolvedBuilderContext`.

### Issue 2: "The tests do not cover that drift"

**Accepted — and this is the fourth time in this phase that my tests validated what the code did rather
than what the spec required.** The existing forwarding test asserted `protocol`, `mode`, `spec`, `plan`
and `issue`, and stopped exactly where the bug was.

**Changed** — five tests, one per spawn entry point plus a negative:

- spec-driven → the literal `spawn.ts:455` string
- issue-driven → `work for GitHub Issue #1288` on a spec-less BUGFIX lane (this is the regression test
  for the reported bug; it fails against the previous implementation)
- ad-hoc task → `an ad-hoc task` **and** `task_text` forwarded, on a context that also carries an
  `issueNumber`, so the branch-order trap is pinned rather than merely commented
- protocol-only → `running the ASPIR protocol`, pinning the dropped `running the`
- `task_text` absent on every non-task lane

They assert spawn's **literal strings**, so if spawn's wording changes the tests fail here instead of the
two surfaces drifting apart silently.

---

## Gemini — APPROVE · Claude — APPROVE

No issues raised. Recorded plainly: both reviewed the same code and missed a defect on the first content
line of four protocols' builder prompts. **A majority APPROVE is not consensus** — the same lesson phase 2
produced, now with the majority on the wrong side twice in one project.

---

## Note on the iteration count

Six rounds. Every defect found by the same reviewer, and every one an instance of a single pattern:
**hand-rolled reconstruction of a spawn structure drifting from what spawn actually emits.** The marker
list that omitted project/issue, the restated resume notice that dropped its `porch init` fallback, the
identity assertions that matched the weaker string, the completeness check that matched labels instead of
values, and now the input framing that covered half the entry points.

The structural answer landed in iteration 5 — typing the port against the canonical `TemplateContext` —
and it is worth being honest that **it would not have caught this one**. `input_description` was always
present and always type-correct; it was merely *wrong*. Types close the "field went missing" class, not
the "field carries the wrong value" class, and the second class needs tests pinned to the literal strings
spawn produces. That is now the case for this field.

---

## Net effect

Issue-driven and ad-hoc-task lanes now receive the same opening framing a fresh spawn delivers; the
protocol-only lane matches spawn's wording exactly. `taskText` threaded through the resolved context.
Tests 46 → 51.
