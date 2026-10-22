### Iteration 1 Reviews
- gemini: APPROVE — Phase 1 cleanly implements the wire contract in codev-types and pure state projection in codev-core with exhaustive unit and type tests.
- codex: REQUEST_CHANGES — Projection largely matches Phase 1, but drops valid needs-input detail when blocked or dead takes precedence.
- claude: APPROVE — Phase 1 contract and projection are complete, faithful to the Contract Surface and Constraints 12-14, with exhaustive independently-scored tests; build, check-types and boundary tests green.

### Builder Response to Iteration 1
# Phase 1, iteration 1: rebuttal and disposition

Verdicts: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES. All points accepted.

- **Codex: needs-input detail is dropped when blocked or dead wins.** Accepted. The detail is a raw input. It now follows the raw `activity` on every served row, as the `ServedAgentState` doc comment already says, so blocked and dead rows carry it when the raw activity is `needs-input`. Tests cover the blocked, dead and served cases, and a detail never appears for another activity. This also resolves Claude's note that the comment and the code disagreed: the code now matches the comment.
- **Claude: `codev-types` is only a devDependency of core.** Accepted. Core's published `dist/agent-state.d.ts` references it, so it moved to `dependencies`, matching the sdk. The lockfile is updated.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
