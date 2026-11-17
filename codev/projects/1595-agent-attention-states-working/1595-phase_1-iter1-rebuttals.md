# Phase 1, iteration 1: rebuttal and disposition

Verdicts: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES. All points accepted.

- **Codex: needs-input detail is dropped when blocked or dead wins.** Accepted. The detail is a raw input. It now follows the raw `activity` on every served row, as the `ServedAgentState` doc comment already says, so blocked and dead rows carry it when the raw activity is `needs-input`. Tests cover the blocked, dead and served cases, and a detail never appears for another activity. This also resolves Claude's note that the comment and the code disagreed: the code now matches the comment.
- **Claude: `codev-types` is only a devDependency of core.** Accepted. Core's published `dist/agent-state.d.ts` references it, so it moved to `dependencies`, matching the sdk. The lockfile is updated.
