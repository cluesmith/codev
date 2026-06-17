# PIR #1052 — CMAP iter-1 rebuttals

Single advisory pass (PIR `max_iterations: 1`). Verdicts: **Claude APPROVE**,
**Codex REQUEST_CHANGES**, **Gemini REQUEST_CHANGES (misfire — not a real verdict)**.
No reviewer requested a **code** change; the only actionable item was a stale doc artifact.

## Gemini — REQUEST_CHANGES (disregard: tooling misfire)

Gemini's output is not a review of this PR — it returned boilerplate about a `--sandbox`
flag and "what would you like to build," i.e. the `agy` CLI never received the prompt/diff.
Per CLAUDE.md, Gemini-via-`agy` "skips non-blockingly if missing/unauthenticated." Treated
as a non-verdict; no content to address. (Porch classifies any non-`APPROVE` as
REQUEST_CHANGES, hence the label.)

## Codex — REQUEST_CHANGES (addressed: stale plan; both points are the same root issue)

Codex explicitly said "the code looks coherent" — neither point is a code-logic critique.

**1. Stale plan artifact.** VALID — addressed. The plan still described the *defer-until-
sized* approach and an *automatic* refocus redraw, both superseded during `dev-approval`
(defer-until-sized was reverted for the replay buffer-and-flush; refocus shipped opt-in/
default-off after an architect A/B). Fix: added a prominent **"⚠️ SUPERSEDED DURING
IMPLEMENTATION"** banner at the top of `codev/plans/1052-*.md` summarizing what actually
shipped and pointing to the review, with the original plan-time reasoning kept verbatim
below as the historical record (commit `5afa0163`). Not a code change — the implementation
and review already documented the final approach accurately; the gap was only the plan.

**2. Refocus behavior doesn't match the plan's contract.** Same root cause as #1, and the
divergence is *intentional and architect-approved*: the A/B test at the `dev-approval` gate
showed the refocus redraw had no observable effect, so the architect directed it to ship
off-by-default behind `codev.terminal.repaintOnRefocus`. The superseded banner now records
this explicitly. No behavior change warranted — the off-by-default decision is the reviewed,
approved outcome.

**Frontmatter (sub-point).** Deliberately NOT added. Codex suggested approval frontmatter
(`approved:`/`validated:`). I did not fabricate `validated: [gemini, codex, claude]` because
PIR plans get **human-only** review at the `plan-approval` gate (no plan consult) — that
field would be false. The plan-approval gate in porch `status.yaml` is the accurate approval
record; a fabricated validation list would be worse than its absence.

## Claude — APPROVE (no action; one minor doc note flagged to the human)

Claude reviewed the code path-by-path (buffer-and-flush ordering, the four `forceRepaint`
guards, hold-state cleanup in `close`/`resetStreamState`, the 9 new tests) and found nothing
blocking. Its one minor note: `docs/releases/UNRELEASED.md` was listed in the plan's "Files
to Change" but not updated. Only `UNRELEASED.template.md` exists on `main`, and the
predecessor terminal PR (#1050) updated only `packages/vscode/CHANGELOG.md`, so I did not
unilaterally create the file. Flagged to the architect at the `pr` gate to confirm whether
the dual-accumulate release-notes convention applies here.

## Net disposition

No code defect was found by any reviewer. The single valid finding (stale plan) is a
documentation fix, applied in `5afa0163`. Two minor doc/process items (UNRELEASED.md,
frontmatter) are escalated to the human at the `pr` gate — PIR is single-pass, so these get
no independent AI re-review.
