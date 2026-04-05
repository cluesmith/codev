# Specification: Mid-Protocol Checkpoint PRs

## Metadata
- **ID**: 653
- **Status**: draft (rewrite)
- **Created**: 2026-04-02
- **Rewritten**: 2026-04-05

## Clarifying Questions Asked

1. **Q: Is this about preventing premature PRs or supporting them?** A: Supporting them. Mid-protocol PRs at gates are a desired workflow. The architect explicitly asks builders to create checkpoint PRs so specs/plans can be shared with external reviewers. Example: Builder 591 created PR #654 with just the spec at the spec-approval gate so the team could review it.

2. **Q: What does the checkpoint PR lifecycle look like?** A: Builder creates a PR at a gate (e.g., spec-approval). The PR starts with just the spec. The architect shares the PR URL with external team members. Feedback comes back. The builder revises the artifact. As the builder continues through subsequent phases, new commits land on the same branch and the PR accumulates all the work. It becomes the final PR.

3. **Q: How does the builder know feedback has arrived?** A: Today, the architect sends feedback via `afx send`. The builder receives the message and can act on it. But porch doesn't model this — when a gate is pending, `porch next` just says "STOP and wait." There's no mechanism for revisions while waiting at a gate.

4. **Q: Does porch already have infrastructure for this?** A: Partially. The `ProjectState` type has `awaiting_input`, `awaiting_input_output`, and `awaiting_input_hash` fields — defined in types.ts but never implemented. The `context` field (`Record<string, string>`) is used to pass user answers to builders via prompts. These provide a foundation but need to be activated and extended.

## Problem Statement

Protocol gates (spec-approval, plan-approval) are the natural points where builders pause and the architect reviews artifacts. In practice, the architect often wants to share these artifacts with external team members — product reviewers, domain experts, other engineers — before approving the gate. The most natural way to share is via a pull request.

Today, there is no support for this workflow:
- Porch doesn't model the concept of "waiting for external review at a gate"
- Builders have no prompt guidance for creating checkpoint PRs at gates
- When a builder creates a PR mid-protocol, porch doesn't know about it
- The `pr_exists` check in the review phase accidentally passes on a stale checkpoint PR
- There's no way to pass external feedback back to the builder through porch
- When feedback requires spec/plan revisions, there's no clean revision flow at a gate

The result: architects work around porch instead of with it, manually coordinating PR creation, feedback collection, and builder resumption.

## Current State

### Gates Are a Hard Stop

When a builder reaches a gate (e.g., spec-approval):
1. `porch done` → marks build_complete
2. `porch next` → emits consultation tasks (3-way review)
3. Consultations complete → `porch next` → gate becomes pending
4. `porch next` → returns `gate_pending` with "STOP and wait for human approval"
5. Architect runs `porch approve` → gate becomes approved
6. `porch next` → advances to next phase

The gate is binary: pending or approved. There's no state for "waiting for external review" or "feedback received, needs revision."

### No Checkpoint PR Concept

- Builder prompts don't mention creating PRs at gates
- Porch has no awareness of PR existence during early phases
- The `pr_exists` check uses `--state all` — a checkpoint PR created at spec-approval would accidentally satisfy this check during the review phase, even if no new PR was created
- There's no guidance for what the checkpoint PR should contain (title, body, labels)

### Unused Infrastructure

The `ProjectState` type already has fields that could support this workflow:
- `awaiting_input?: boolean` — defined but never implemented
- `awaiting_input_output?: string` — defined but never implemented
- `context?: Record<string, string>` — used for `user_answers` only
- `GateStatus` only tracks `pending`/`approved` — no sub-state for "external review in progress"

### Feedback Has No Channel

When external feedback arrives (via PR comments, Slack, email), the architect must:
1. Read the feedback
2. Manually send it to the builder via `afx send`
3. The builder revises the artifact outside porch's knowledge
4. The architect approves the gate
5. Porch advances, unaware that revisions happened

Revisions at gates bypass porch's build→verify cycle, so they don't get 3-way consultation.

## Desired State

### Checkpoint PRs as a First-Class Feature

When a builder reaches a gate, porch should offer to create a checkpoint PR. The PR:
- Contains the current artifact (spec or plan) plus any implementation done so far
- Has a title and body that make it clear this is a checkpoint for review, not a final PR
- Stays open as the builder continues — subsequent phases add commits to the same branch
- Becomes the final PR during the review phase (no separate PR needed)

### Gate Sub-States for External Review

Gates should support a richer state model:
- `pending` → waiting for architect to decide
- `external_review` → architect has requested external review; checkpoint PR created
- `feedback_received` → external feedback is available; builder should revise
- `approved` → gate approved, proceed

### Feedback Integration

External feedback (from PR comments, architect input, etc.) should be capturable in porch state and delivered to the builder via prompts. When the builder gets revision tasks, the feedback is included as context.

### Revision Flow at Gates

When feedback requires changes to the artifact:
1. Architect passes feedback to porch (e.g., `porch feedback <id> "..."` or `porch feedback <id> --from-pr`)
2. Porch transitions gate to `feedback_received`
3. `porch next` emits revision tasks with feedback context
4. Builder revises the artifact
5. Builder runs `porch done` → consultation runs on revised artifact
6. If consultants approve → gate returns to `pending` (or architect can directly approve)
7. Architect approves gate

This preserves porch's build→verify discipline even for revisions at gates.

## Stakeholders
- **Primary Users**: Architects who want to share artifacts for external review
- **Secondary Users**: Builder AI agents that create checkpoint PRs and revise artifacts
- **Tertiary Users**: External team members who review checkpoint PRs
- **Technical Team**: Codev maintainers

## Success Criteria

- [ ] Porch prompts builder to create a checkpoint PR when a gate becomes pending
- [ ] Checkpoint PR is created with appropriate title/body indicating it's a checkpoint for review
- [ ] Gate state model supports `external_review` and `feedback_received` sub-states
- [ ] `porch feedback <id> "text"` command passes external feedback into porch state
- [ ] `porch next` emits revision tasks with feedback context when gate is in `feedback_received` state
- [ ] Revised artifacts go through consultation (build→verify cycle) before gate returns to pending
- [ ] Checkpoint PR accumulates commits as builder continues through subsequent phases
- [ ] The checkpoint PR satisfies the `pr_exists` check in the review phase (no separate final PR needed)
- [ ] `pr-exists` forge scripts tightened to exclude CLOSED-not-merged PRs (correctness fix independent of checkpoint PR feature)
- [ ] Unit tests cover checkpoint PR creation, gate sub-states, feedback flow, and revision cycle
- [ ] Builder prompts updated to guide checkpoint PR creation at gates

## Constraints

### Technical Constraints
- Must use the existing **forge concept layer** for PR operations (`executeForgeCommand`), not raw `gh` calls
- Must maintain backward compatibility — gates without external review should work exactly as before
- Must work across all protocols with gates (SPIR, ASPIR, TICK; BUGFIX/AIR have no spec/plan gates)
- Porch is a per-invocation CLI — no in-memory state between invocations; all state in status.yaml

### Design Constraints
- Checkpoint PR creation should be opt-in, not automatic — the architect decides when external review is needed
- Feedback should be storable in status.yaml (not just ephemeral `afx send` messages)
- Revision at gates should reuse the existing build→verify cycle, not create a parallel path
- Must not add mandatory latency to gates that don't use external review

## Assumptions
- External feedback arrives asynchronously (could be hours or days)
- The architect mediates feedback — they decide when enough feedback has arrived
- Checkpoint PRs use the same branch as the builder's worktree (no separate branch)
- A single checkpoint PR persists through the entire protocol lifecycle
- `afx send` remains the real-time communication channel; porch state captures persistent feedback

## Solution Approach

### Component 1: Checkpoint PR at Gates

When a gate becomes pending, `porch next` includes a task to create a checkpoint PR (if one doesn't already exist on the branch). The task:
- Tells the builder to create a PR with `gh pr create` (via forge concept)
- Provides a template title: `[Checkpoint] Spec 653: Better handling of builders...`
- Provides a template body explaining this is a checkpoint PR for external review
- The PR is created as a draft (if the forge supports it) to signal it's not ready for merge

If a PR already exists on the branch, the task is skipped (idempotent).

### Component 2: Gate Sub-State Model

Extend `GateStatus` in `types.ts`:

```typescript
export interface GateStatus {
  status: 'pending' | 'external_review' | 'feedback_received' | 'approved';
  requested_at?: string;
  approved_at?: string;
  checkpoint_pr?: number;        // PR number of the checkpoint PR
  feedback?: string;             // External feedback text
  feedback_at?: string;          // When feedback was received
}
```

New porch commands:
- `porch review <id>` — Architect signals external review is in progress. Transitions gate from `pending` → `external_review`. Records checkpoint PR number.
- `porch feedback <id> "text"` — Architect passes feedback. Transitions gate from `external_review` → `feedback_received`. Stores feedback text.
- `porch feedback <id> --from-pr` — Pulls feedback from PR comments automatically (via forge concept).

### Component 3: Revision Flow

When gate is in `feedback_received` state:
1. `porch next` detects `feedback_received` and emits revision tasks
2. Revision tasks include the feedback text as context
3. Builder revises the artifact (spec or plan)
4. Builder runs `porch done` → porch resets `build_complete` to false, increments iteration
5. `porch next` emits consultation tasks (3-way review of revised artifact)
6. If consultants approve → gate transitions back to `pending`
7. Architect can approve the gate or request another round of external review

This reuses the existing build→verify cycle. No new verification infrastructure needed.

### Component 4: Tighten `pr-exists` Check

Independent correctness fix: Change `pr-exists` forge scripts to only return `true` for OPEN or MERGED PRs. CLOSED-not-merged PRs are excluded. This ensures:
- A checkpoint PR that was abandoned (closed without merging) doesn't accidentally satisfy the review phase check
- The existing bugfix #568 scenario (merged PRs) continues to work

### Component 5: Prompt Updates

Update builder prompts to guide checkpoint PR creation at gates:
- Gate-pending tasks should mention "If the architect asks, create a checkpoint PR for external review"
- Review phase prompts should note "If a checkpoint PR already exists, use it — don't create a second PR"
- Builder role should mention checkpoint PRs as a legitimate workflow

## Traps to Avoid

1. **Don't make checkpoint PRs automatic**: The architect decides when external review is needed. Not every gate needs a PR.
2. **Don't create a separate PR for review phase**: The checkpoint PR accumulates all work and becomes the final PR. Creating a second PR wastes the review history.
3. **Don't model feedback as a simple string**: Future iterations may want structured feedback (per-section comments, priority levels). But for v1, a string is fine — don't over-engineer.
4. **Don't skip consultation on revisions**: Revised artifacts should go through the build→verify cycle. This is the whole point of porch's discipline.
5. **Don't break gates that don't use external review**: The new sub-states (`external_review`, `feedback_received`) are opt-in. A gate that goes directly from `pending` → `approved` should work exactly as before.
6. **Don't hardcode `gh` CLI calls**: Use the forge concept layer for PR creation and detection.

## Open Questions

### Critical (Blocks Progress)
- [x] Should checkpoint PR creation be automatic or opt-in? — **Opt-in**. The architect triggers it, not porch.

### Important (Affects Design)
- [x] Should the checkpoint PR be a draft? — **Yes, if the forge supports it.** This signals it's not ready for merge.
- [x] Should `porch feedback --from-pr` pull all PR comments or just new ones? — **All comments** for v1. Filtering can be added later.
- [x] Can the architect approve a gate directly from `external_review` (skip `feedback_received`)? — **Yes**. If the external review is positive with no changes needed, the architect can approve directly.

### Nice-to-Know (Optimization)
- [ ] Should porch auto-detect PR comments as feedback? — Defer to follow-up. Manual `porch feedback` is sufficient for v1.

## Performance Requirements
- No mandatory latency added to gates without external review
- `porch feedback --from-pr` may take 2-5 seconds to fetch PR comments (acceptable, rare operation)
- Checkpoint PR creation is a one-time operation per gate

## Security Considerations
- PR creation and comment fetching use existing forge auth (GitHub tokens, etc.)
- Feedback stored in status.yaml is plaintext — no sensitive data expected
- No new credentials or permissions needed

## Test Scenarios

### Functional Tests — Checkpoint PRs
1. **Happy path (no checkpoint)**: Builder reaches gate, architect approves directly — works as before
2. **Checkpoint PR at spec-approval**: Builder creates checkpoint PR with spec, architect shares for review
3. **Checkpoint PR at plan-approval**: Same flow for plan gate
4. **Checkpoint PR accumulates commits**: After gate approval, subsequent phase commits appear on the same PR
5. **Checkpoint PR becomes final PR**: In review phase, `pr_exists` check passes because checkpoint PR exists
6. **Idempotent**: If checkpoint PR already exists, skip creation task

### Functional Tests — Gate Sub-States
7. **pending → external_review**: `porch review <id>` transitions state, records PR number
8. **external_review → feedback_received**: `porch feedback <id> "text"` stores feedback
9. **external_review → approved**: Direct approval without feedback (positive review)
10. **feedback_received → revision cycle**: `porch next` emits revision tasks with feedback
11. **Revision → consultation → pending**: Revised artifact goes through 3-way review
12. **Multiple feedback rounds**: feedback_received → revise → verify → pending → external_review → feedback → revise...
13. **Backward compatibility**: Existing `pending → approved` flow unchanged

### Functional Tests — Feedback
14. **Manual feedback**: `porch feedback <id> "Change section X to..."` stores text
15. **PR-sourced feedback**: `porch feedback <id> --from-pr` pulls comments from checkpoint PR
16. **Feedback in builder prompt**: Revision tasks include feedback text as context

### Functional Tests — `pr-exists` Tightening
17. **OPEN PR satisfies `pr-exists`**: Existing behavior preserved
18. **MERGED PR satisfies `pr-exists`**: Existing behavior preserved
19. **CLOSED PR does NOT satisfy `pr-exists`**: New behavior — abandoned PRs excluded

### Non-Functional Tests
20. **No latency for simple gates**: Gates without external review have zero additional overhead
21. **Forge abstraction**: All PR operations use forge concepts, not raw CLI calls

## Dependencies
- **Forge concept layer** (`packages/codev/src/lib/forge.ts`): For PR creation, detection, comment fetching
- **Forge PR scripts** (`packages/codev/scripts/forge/{github,gitlab,gitea}/pr-exists.sh`): Tighten to exclude CLOSED PRs
- **Porch state types** (`packages/codev/src/commands/porch/types.ts`): Extend GateStatus
- **Porch commands** (`packages/codev/src/commands/porch/index.ts`): New `review` and `feedback` subcommands
- **Porch next** (`packages/codev/src/commands/porch/next.ts`): Handle new gate sub-states, emit checkpoint PR tasks and revision tasks
- **Builder prompts** (`codev-skeleton/protocols/spir/prompts/*.md`): Guide checkpoint PR workflow
- **Builder role** (`codev/roles/builder.md`, `codev-skeleton/roles/builder.md`): Document checkpoint PR as legitimate workflow

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Gate sub-states add complexity | Medium | Medium | Opt-in design — simple gates work exactly as before |
| Feedback desync (stale feedback) | Low | Low | Feedback is timestamped; architect controls when to send it |
| Checkpoint PR confuses external reviewers | Low | Low | Clear title/body template indicating checkpoint status |
| `pr-exists` tightening breaks workflow | Low | Medium | Only excludes CLOSED PRs; no known workflow depends on them |
| Builder creates checkpoint PR without architect asking | Low | Low | Not harmful — PR can be closed or reused |

## Notes

This spec reframes the original issue (#653). The original framing treated mid-protocol PRs as a bug to prevent. The correct framing: mid-protocol checkpoint PRs at gates are a valuable workflow for collecting external feedback. The feature makes this workflow a first-class citizen of porch, with proper state modeling, feedback integration, and revision cycles.

The `pr-exists` tightening (Component 4) is a standalone correctness fix that benefits the codebase regardless of the checkpoint PR feature.
