# Builder thread: spir-1216

- Started in strict SPIR mode for issue #1216.
- Read the builder role, protocol, hot architecture/lessons context, and draft specification.
- Porch owns phase transitions and reviews; status files will not be edited manually.
- Architect directed all delivery to `fork`; configured `builder/spir-1216` to track `fork/builder/spir-1216` and pushed the initialized Porch branch there.
- Specify iteration 1: validated the draft against current gate, config-loader, and worktree setup behavior; added stakeholders, constraints, non-functional requirements, open questions, and a consultation log without changing the baked decisions.
- Specify consultation completed: Gemini and Claude approved; Codex requested two minor clarifications. Before human approval, updated the spec to protect main-workspace personal config from builder-side mutation and to require explicit fresh-spawn plus `afx setup`/idempotency coverage.
- Human approved the specification. Pushed the approval and plan-transition Porch commits to `fork` after Porch's hard-coded `origin` push failed, then entered Plan iteration 1.
- Plan decision: implement the builder personal layer as an atomically refreshed managed copy, not a symlink, so builder edits cannot write through to the main workspace. Split delivery into producer toggle, safe worktree snapshot, and documentation/end-to-end verification phases.
- Plan consultation completed: Gemini and Claude approved; Codex requested minor clarity on builder-cwd integration verification and canonical documentation placement. Updated the plan accordingly and made snapshot insertion order explicit.
