# Spec 1313 — Rebuttal to iteration-1 spec consultation

**Verdicts**: Gemini APPROVE · Codex REQUEST_CHANGES · Claude COMMENT — all HIGH confidence.

All three reviewers agreed the spec is technically sound, feasible, and empirically well-grounded. The only
unanimous defect was a missing template heading. Every point below was **accepted and addressed**; nothing was
rejected. No baked decision was changed — all edits are clarification/completion. Changes committed in
`c483f88b [Spec 1313] Specification with multi-agent review`.

## Codex (REQUEST_CHANGES) — the gating review

1. **Missing `## Expert Consultation` section (required by the template).**
   **Accepted — fixed.** Added the `## Expert Consultation` section between `## Risks and Mitigation` and
   `## Approval`, in canonical template order. It records the models consulted, the three verdicts, and the
   list of sections updated (this iteration's consultation log).

2. **`afx inbox` scope/query surface + dismissal addressing semantics should be explicit if they are testable
   requirements rather than plan-level choices.**
   **Accepted — fixed.** They *are* testable requirements (Success Criteria 6 and Test Scenarios 14–15 depend
   on them), so I pinned them at spec level in Baked Decision 8: `afx inbox` is **workspace-scoped** — it lists
   every currently-held row in the workspace, across all recipient agents, each with its **row id** and
   **why-held reason** (`busy`/`no-profile`/`no-live-pty`), and **dismisses by row id**. Dismiss authorization
   is the workspace-human trust level of `afx send` itself (already stated in Security Considerations); any
   workspace operator may dismiss any held row, with no per-recipient ownership check. The one thing I
   deliberately kept plan-level is the *visual form* of the indicator's attention state (badge/color/styling) —
   flagged as such in-line so the spec/plan boundary stays clean.

## Gemini (APPROVE)

- **Missing `## Expert Consultation` heading.** Same item as Codex #1 — **fixed** (see above). This was the
  only issue Gemini raised; it otherwise approved.

## Claude (COMMENT) — non-blocking, all accepted

1. **Missing `## Expert Consultation` heading.** **Fixed** (as above).
2. **`afx inbox` dismiss authorization in multi-architect workspaces ("which human?").** **Fixed** — Decision 8
   now states any workspace operator may dismiss any held row (no per-recipient ownership check), which answers
   this directly.
3. **Whether non-cron senders can supply a supersede key is implicit.** **Fixed** — Decision 6 now states
   explicitly that supersede keys are **cron-only**; a non-cron send never supersedes another (each is an
   independent held row).
4. **"Attention state" visual contract unspecified (may be plan-level).** **Addressed** — Decision 8 now names
   this a plan-level UI decision explicitly, and fixes the spec-level requirement (a distinct, log-free attention
   state that clears when the row resolves). Keeping the exact visual to the plan is intentional (spec = WHAT).
5. **No dedicated test scenario for the escalation-age threshold.** **Fixed** — added Functional Test Scenario
   16: held past escalation age → broadcast fires + indicator attention state, **no delivery triggered** by the
   crossing; the row still delivers only on a later clean gate pass.

## Feasibility notes (reviewers verified independently; no change needed)

Codex and Claude both read the repo and confirmed the spec's own statements: `@xterm/headless` is not yet a
production dependency (spec flags "confirm/add"), the output ring buffer is the existing dashboard-reconnect
reconstruction path, and the `global.db` mailbox is an additive migration-on-boot table with no rows to migrate.
These matched the spec as written.
