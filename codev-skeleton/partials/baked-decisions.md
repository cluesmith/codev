## Baked Decisions

If the issue body contains a section named "Baked Decisions" (any heading level, case-insensitive), treat its contents as fixed architectural decisions baked in by the architect. Do not autonomously override them in your spec, plan, or implementation. If you discover a serious reason to question a baked decision, surface that concern to the architect via `afx send` rather than relitigating it inside the spec/plan/review.

If the architect's baked-decisions section contains internal contradictions (e.g., two different language choices), do not pick one — pause, flag the contradiction to the architect via `afx send`, and wait for resolution before proceeding.