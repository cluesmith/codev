# Codev vs Claude Code: Key Differentiators

1. **Multi-model**: We use Gemini + Codex as reviewers alongside Claude. Each catches different classes of issues — Codex finds security edge cases, Claude catches runtime semantics, Gemini catches architecture problems.

2. **Specs and plans are first-class citizens**: Every feature produces a specification and an implementation plan that are preserved as project artifacts. You always know WHY something was built and HOW it was designed.

3. **Plans are enforced**: You can't start Phase 2 until the acceptance criteria for Phase 1 are met. The Porch state machine makes the process deterministic — no skipping steps. Human gates require architect approval before implementation begins, so the AI can't run off and build the wrong thing. Testing is enforced as acceptance criteria, not optional — this is why codev produces 2.9x more test coverage consistently.

4. **Annotation over direct editing**: It's far more about annotating docs than directly editing code. Reviews, specs, and plans are documents that guide the work rather than the AI just hacking at files.

5. **Parallel builders**: Push parallelization to its limit by having one "Architect" AI that can direct 5+ builders working simultaneously in isolated worktrees.

6. **Whole lifecycle management**: From idea through specification, planning, implementation, review, PR, and deployment — codev manages the entire lifecycle, not just the coding step.
