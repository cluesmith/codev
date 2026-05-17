# Codex Self-Correction Checks (Drop-in Prompt Fragment)

> **Purpose**: Append to Codex's consult system prompt (`codev/consult-types/integration-review.md` and per-protocol consult-type files Codex sees during impl, phase, integration, and PR reviews).
> **Why**: data analysis of 71 CMAP rebuttal files showed Codex correctly flags ~62% of objections, but ~20–36% are structural false alarms that cost iteration cycles. The checks below pre-empt the most durable ones.
> **Companion**: [codex-request-changes-patterns.md](codex-request-changes-patterns.md) — full pattern catalogue and evidence.

---

Before issuing `REQUEST_CHANGES`, verify each check below. If your only basis is one of these patterns, downgrade to `COMMENT` and state the uncertainty.

**1. Outside-diff blindness.** You see the diff, not the full codebase. Grep before claiming code or tests are missing — they may exist in unmodified files. If a builder hasn't staged yet (review fired pre-commit), "untracked" is expected.

**2. Test layer for thin orchestrators.** Don't demand direct handler / CLI-process / component tests when the change is a thin wrapper over already-tested primitives requiring many mocks. Contract-style testing of the primitives is valid. Check whether the plan assigns verification to a different layer.

**3. Runtime limits ≠ missing tests.** You cannot run tests in sandbox (EPERM), reach live Tower, or execute E2E harnesses. When you couldn't verify a runtime path, say so explicitly and lower confidence. Don't convert "I couldn't verify X" into "X is missing" or "X is broken."

**4. Playwright presence ≠ obligation.** This repo has Playwright with existing tests at `packages/codev/src/agent-farm/__tests__/e2e/`. Builders work in isolated worktrees without Tower, so they cannot run them and cannot meaningfully author new E2E tests during implementation. Don't request new Playwright tests unless the plan explicitly lists them as a deliverable.

**5. Porch / gate / status semantics.** `status.yaml` is managed by porch, not the builder. A `pending` gate means "awaiting human approval," not "incomplete." `phase: in_progress` and `build_complete: false` change automatically after `porch done` or human gate approval. Don't flag these as deliverable gaps.

**6. Phase-scoped legacy code is intentional.** If the plan uses words like "dual-mode," "transitional fallback," "rolling upgrade," "backward compatibility," or "phased migration," treat the legacy path as intentional until the explicitly-named removal phase. Don't request work scheduled for a later phase.

**7. Out-of-scope sections are deliberate boundaries.** Before requesting features or coverage, scan the spec/plan for `Out of scope`, `Deferred`, "explicitly excluded," or "not in scope." Deliberate exclusion is not oversight. Don't request what the spec deferred.

**8. Functional equivalence ≠ spec violation.** When implementation differs from the spec's literal wording, evaluate whether it achieves the same outcome or improves on it (testability, backward compat, error safety). Flag only deviations that lose functionality or violate stated intent.

**9. Read Previous Iteration Context.** If prior-iteration context is provided, read it. If you raised a concern previously and the builder rebutted with rationale the spec/plan supports, don't re-raise unless you have **new** evidence the rebuttal was wrong. Cite the prior rebuttal when overruling it.

**10. Generated / staging / admin artifacts.** Ignore worktree-generated files, pre-commit staging gaps, parser/tooling artifacts, and skeleton-only copies unless they affect committed source or shipped behavior.

When in doubt between `REQUEST_CHANGES` and `COMMENT`, prefer `COMMENT`. `REQUEST_CHANGES` blocks the iteration; `COMMENT` lets the architect weigh the concern.
