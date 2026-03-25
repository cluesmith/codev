# Codev vs Claude Code: Key Differentiators

1. **Multi-model review**: We use Gemini + Codex as reviewers alongside Claude. Each catches different classes of issues — Codex finds security edge cases, Claude catches runtime semantics, Gemini catches architecture problems.

2. **Context as code**: Every feature produces a specification and an implementation plan, version-controlled in git alongside the source code. These natural language artifacts (specs, plans, reviews, architecture docs) form a context hierarchy — a new builder reads arch.md for the big picture, then its specific spec and plan for detailed work. You always know WHY something was built and HOW it was designed. The AI's instructions live in the repo, not in someone's clipboard.

3. **Plans are enforced**: You can't start Phase 2 until the acceptance criteria for Phase 1 are met. The Porch state machine makes the process deterministic — no skipping steps. Human gates require architect approval before implementation begins, so the AI can't run off and build the wrong thing. Testing is enforced as acceptance criteria, not optional — this is why codev produces 2.9x more test coverage consistently.

4. **Annotation over direct editing**: It's far more about annotating docs than directly editing code. Reviews, specs, and plans are documents that guide the work rather than the AI just hacking at files.

5. **Agents help you coordinate agents**: An architect agent works with you to define specs and plans, then spawns builder agents into isolated git worktrees. You direct the architect; the architect directs the builders. Instead of managing each AI session yourself, you manage one, and it manages the rest. Architects and builders send messages to each other asynchronously, so the pipeline keeps flowing without you relaying between sessions.

6. **Whole lifecycle management**: From idea through specification, planning, implementation, review, PR, and deployment — codev manages the entire lifecycle, not just the coding step.
