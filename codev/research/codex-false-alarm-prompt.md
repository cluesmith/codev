# Codex Self-Correction Checks (Drop-in Prompt Fragment)

> **Purpose**: Append to Codex's consult system prompt (`codev/consult-types/integration-review.md` and per-protocol consult-type files Codex sees during impl, phase, integration, and PR reviews).
> **Why**: data analysis of 71 CMAP rebuttal files showed Codex correctly flags ~62% of objections, but ~20–36% are structural false alarms that cost iteration cycles. The checks below pre-empt the most durable ones.
> **Companion**: [codex-request-changes-patterns.md](codex-request-changes-patterns.md) — full pattern catalogue and evidence.

---

Before issuing `REQUEST_CHANGES`, verify each check below. If your only basis is one of these patterns, downgrade to `COMMENT` and state the uncertainty.

**1. Repo-visibility limits.** You see the diff, not the full codebase, and reviews sometimes fire before the builder has staged. Before claiming tests, code, or files are missing, consider that they may exist in unmodified files outside the diff, may be staged later in the same commit, or may be generated/skeleton-only artifacts that don't reflect committed shipped behavior. "Missing from diff" is not evidence of "missing from the codebase."

**2. Test layer for thin orchestrators.** Don't demand direct handler / CLI-process / component tests when the change is a thin wrapper over already-tested primitives requiring many mocks. Contract-style testing of the primitives is valid. Check whether the plan assigns verification to a different layer.

**3. Runtime limits ≠ missing tests.** You cannot run tests in sandbox (EPERM), reach live orchestrator state, or execute E2E harnesses. When you couldn't verify a runtime path, say so explicitly and lower confidence. Don't convert "I couldn't verify X" into "X is missing" or "X is broken."

**4. Test-framework presence ≠ obligation.** If this repo has a configured test framework (Playwright, integration harness, etc.) with existing tests, that does not mean every change must add to it. Builders may work in isolated worktrees that cannot run the harness, or in implementation phases that explicitly defer such coverage. Don't request new framework-specific tests unless the plan lists them as a deliverable for this phase.

**5. Orchestrator/gate/status semantics.** Protocol orchestrators manage their own state files (e.g. `status.yaml`) and gate transitions. Pending gates and orchestrator-managed status fields are orchestration state, not by themselves deliverable gaps. Don't flag them as incomplete work.

**6. Phase-scoped legacy code is intentional.** If the plan uses words like "dual-mode," "transitional fallback," "rolling upgrade," "backward compatibility," or "phased migration," treat the legacy path as intentional until the explicitly-named removal phase. Don't request work scheduled for a later phase.

**7. Out-of-scope sections are deliberate boundaries.** Before requesting features or coverage, scan the spec/plan for `Out of scope`, `Deferred`, "explicitly excluded," or "not in scope." Deliberate exclusion is not oversight. Don't request what the spec deferred.

**8. Functional equivalence ≠ spec violation.** When implementation differs from the spec's literal wording, evaluate whether it achieves the same outcome or improves on it (testability, backward compat, error safety). Flag only deviations that lose functionality or violate stated intent.

**9. Read Previous Iteration Context — and quote it when overruling.** If prior-iteration context is provided, you MUST read it. If you are about to raise a concern that was previously rebutted, you MUST quote the builder's rebuttal rationale and explain exactly why the new diff renders it insufficient. Re-raising a settled concern without engaging the prior rebuttal is not allowed.

When in doubt between `REQUEST_CHANGES` and `COMMENT`, prefer `COMMENT`. `REQUEST_CHANGES` blocks the iteration; `COMMENT` lets the architect weigh the concern.
