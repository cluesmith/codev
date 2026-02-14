## Disputed: No concrete testing strategy defined in spec

Codex requests explicit test requirements (unit + integration/UI tests) in the spec document.

In SPIR protocol, the spec defines WHAT to build (requirements, acceptance criteria), while the plan defines HOW to build (phases, files to modify, test strategy). The success criteria in the spec are concrete and testable — the plan phase is where specific test requirements (unit tests for nonce store, integration tests for callback handling, CLI alias tests, etc.) are defined alongside the implementation phases.

The existing Claude reviewer (iteration 2) explicitly agrees: "this is a spec review, not a plan review. The success criteria are concrete enough that a builder can derive tests from them."

This is a false positive — the testing strategy belongs in the plan, not the spec.
