# Specification: Mid-Protocol Checkpoint PRs and Post-Merge Verification

## Metadata
- **ID**: 653
- **Status**: draft (rewrite + extension, iter 2)
- **Created**: 2026-04-02
- **Rewritten**: 2026-04-05
- **Extended**: 2026-04-11 (added post-merge Verify phase and team-workflow framing)
- **Iter 2**: 2026-04-11 (incorporated Gemini/Codex/Claude feedback: opt-in flow fix, `porch review`→`porch checkpoint` rename, AI hallucination guard for Verify, forge concept list, v1 slicing)

## Clarifying Questions Asked

1. **Q: Is this about preventing premature PRs or supporting them?** A: Supporting them. Mid-protocol PRs at gates are a desired workflow. The architect (or any team member driving a project) explicitly asks builders to create checkpoint PRs so specs/plans can be shared with the rest of the team. Example: Builder 591 created PR #654 with just the spec at the spec-approval gate so the team could review it.

2. **Q: What does the checkpoint PR lifecycle look like?** A: Builder creates a PR at a gate (e.g., spec-approval). The PR starts with just the spec. The driving team member shares the PR URL with teammates. Feedback comes back. The builder revises the artifact. As the builder continues through subsequent phases, new commits land on the same branch and the PR accumulates all the work. It becomes the final PR.

3. **Q: How does the builder know feedback has arrived?** A: Today, the architect sends feedback via `afx send`. The builder receives the message and can act on it. But porch doesn't model this — when a gate is pending, `porch next` just says "STOP and wait." There's no mechanism for revisions while waiting at a gate.

4. **Q: Does porch already have infrastructure for this?** A: Partially. The `ProjectState` type has `awaiting_input`, `awaiting_input_output`, and `awaiting_input_hash` fields — defined in types.ts but never implemented. The `context` field (`Record<string, string>`) is used to pass user answers to builders via prompts. These provide a foundation but need to be activated and extended.

5. **Q: The protocol lifecycle currently ends at PR merge. Is that enough?** A: No. Merging a PR proves the code compiles, tests pass, and reviewers approved — but it does not prove the change actually *works* in the target environment. Did the newly installed CLI behave correctly? Did Tower restart cleanly? Is the feature reachable via the expected UI path? Can end-users observe the promised behavior? Today these checks happen informally, or not at all, and regressions slip in. We need a distinct **post-merge verification** stage so "integrated into the codebase" and "verified to work" are separate, explicit milestones.

6. **Q: How does Verify differ from the existing Review phase?** A: **Review is pre-merge code review**: builder writes a review document, 3-way consultation approves the code, the PR is merged. **Verify is post-merge environmental verification**: after merge, human team members install the merged change in their real environment and confirm observable behaviors. Review answers "is the code correct?"; Verify answers "does the deployed change actually work for users?" They are complementary, not overlapping.

## Problem Statement

Codev projects have three natural team-visibility stages — one before implementation, one before merge, and one after merge. Porch today only formally supports the middle one. This spec closes the two gaps on either side.

### Stage 1 — Spec/Plan Review (Gap)

Protocol gates (`spec-approval`, `plan-approval`) are the natural points where builders pause and the team reviews artifacts. In practice, the driving team member often wants to share these artifacts with teammates — product reviewers, domain experts, other engineers — before approving the gate. The most natural way to share is via a pull request.

Today, there is no support for this workflow:
- Porch doesn't model the concept of "waiting for team review at a gate"
- Builders have no prompt guidance for creating checkpoint PRs at gates
- When a builder creates a PR mid-protocol, porch doesn't know about it
- The `pr_exists` check in the review phase accidentally passes on a stale checkpoint PR
- There's no way to pass team feedback back to the builder through porch
- When feedback requires spec/plan revisions, there's no clean revision flow at a gate

The result: architects work around porch instead of with it, manually coordinating PR creation, feedback collection, and builder resumption.

### Stage 2 — Pre-Merge Code Review (Already Supported)

The existing `review` phase already gives teammates a final PR to review before merge. 3-way consultation runs on the code, checks run on the build/tests, and the `pr` gate blocks the merge until a human approves. This stage is in good shape and is unchanged by this spec.

### Stage 3 — Post-Merge Verification (Gap)

Today the protocol lifecycle ends when the PR merges. But merge is not the same as "the change actually works." Nothing in porch asks: did the installed CLI behave correctly? Did Tower restart cleanly? Is the feature reachable via the expected UI path? Do users observe the promised behavior?

This matters because:
- Green CI + approved reviews + clean merge is not proof that the deployed change works
- Bugs that only show up post-install (missing env vars, OS-specific paths, wrong binary shimming) slip through silently
- On a team, a single person verifying in one environment is not enough — different teammates run different stacks
- There is no durable record of "who verified what, where, and on which date" — so regressions are hard to attribute
- The informal step of "the architect tries it locally after merge" is easy to forget and even easier to skip

The project has no explicit "integrated" state. Once merged, a project disappears from porch's view, and whether it actually works in production is trusted on faith.

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

### No Post-Merge Verification Phase

The SPIR/ASPIR protocols today terminate at the `review` phase, and the `pr` gate's approval is the project's final milestone. After that:
- Porch regards the project as complete — there is no further phase to emit tasks for
- No artifact records what was verified, where, when, or by whom
- No teammate is explicitly prompted to try the merged change in their own environment
- There is no distinction between "code merged" and "change works in the real world"
- Regressions caught a week later have no in-protocol escalation path — they become new bugs with no linkage back to the originating project

The conceptual states `committed` (PR merged) and `integrated` (verified to work) are collapsed into a single terminal state, so the team loses the ability to reason about them separately.

## Desired State

### Three-Stage Team Visibility as a First-Class Concept

Codev should formally recognize that a team sees a project at three distinct stages, and porch should make each stage a supported, visible, revisable step in the lifecycle:

1. **Spec/plan stage (pre-implementation team review)** — Team reviews the spec and/or plan before the builder writes any code. Served by **checkpoint PRs at gates** (this spec).
2. **Implementation stage (pre-merge code review)** — Team reviews the code before it lands on `main`. Served by the **existing review phase and final PR** (unchanged).
3. **Verify stage (post-merge environmental verification)** — Teammates install and try the merged change in their own environments and confirm it works. Served by a **new post-merge Verify phase** (this spec).

These three stages are complementary: each surfaces a different class of issue (requirements gaps → code defects → deployment/environment mismatches) and each has a distinct reviewer population. The same checkpoint PR carries all three stages — it is born at stage 1, reviewed at stage 2, and verified against at stage 3.

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

### Post-Merge Verify Phase

After the PR is merged, porch should not mark the project "done." Instead, a new terminal phase — `verify` — should run. This phase:
- Emits tasks that guide a human teammate (or the architect) through verifying the merged change in a real environment
- Collects a **verify note** — a short, structured artifact recording what was tried, where, and the observed result
- Posts a summary **comment on the merged PR** so teammates watching the PR see the verification outcome in context
- Blocks on a new human-only gate, `verify-approval`, which marks the project as truly `integrated`
- Supports multiple verifiers (one entry per verifier in the verify note) so different teammates can each sign off on their own environment

Porch should track two distinct lifecycle states:
- `committed` — PR is merged; code is on main; CI is green. Reached when the `pr` gate is approved.
- `integrated` — Verified to work in the target environment by at least one human. Reached when the `verify-approval` gate is approved.

The difference matters: a project can be `committed` but not `integrated` if the merged change turns out to be broken in practice, and the protocol should have an explicit place for that fact to live rather than it being discovered ad-hoc.

## Stakeholders
- **Primary Users**: Architects and team leads driving codev projects who want team visibility at each stage (spec, code, and post-merge)
- **Secondary Users**: Builder AI agents that create checkpoint PRs, revise artifacts on feedback, and drive the verify phase
- **Tertiary Users**: Team members who review checkpoint PRs at the spec/plan stage, review code at merge time, and verify merged changes in their own environments
- **Technical Team**: Codev maintainers

## Success Criteria

### Checkpoint PRs and Feedback Flow
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

### Post-Merge Verify Phase
- [ ] SPIR and ASPIR `protocol.json` define a new terminal `verify` phase after `review`
- [ ] Porch runtime supports a new `once` phase type (single task batch → gate → terminate)
- [ ] New human-only gate `verify-approval` blocks the project until verification is confirmed, using the same guard as `spec-approval`/`plan-approval`
- [ ] Porch exposes an explicit `integrated` lifecycle state, reached only when `verify-approval` is approved
- [ ] Verify-phase task emission is **scaffolding only** for AI builders: copy template, pre-fill metadata, create verification PR, notify architect, exit. Tasks never instruct the AI to fill verifier entries or run the checklist.
- [ ] The `verify.md` prompt contains an explicit, bold rule: "You are an AI. You cannot verify deployed software. Do not sign off."
- [ ] Verify phase produces a **verify note** file at `codev/verifications/${PROJECT_TITLE}.md` with a standard template (environments tested, checks run, observed behavior, sign-off)
- [ ] Verify note is committed to `main` via a small verification PR (default) or direct commit (opt-out for repos without branch protection)
- [ ] `pr_is_merged` check (via forge concept) guards the review→verify transition; porch does not advance to verify until the checkpoint PR is actually merged
- [ ] `verify_note_has_pass` check enforces a machine-verifiable PASS signal (overall `Final verdict: PASS` or at least one verifier with `Result: PASS`), not just a section header
- [ ] After `verify-approval` is approved, porch posts a closing summary comment on the merged PR via forge concept `pr-comment`
- [ ] Verify note supports multiple verifier entries so more than one teammate can sign off on different environments; Sign-off block is updated in place on re-verification
- [ ] `porch verify <id> --fail "reason"` records failed verification, keeps project in `committed`, halts AI builder, emits a directive (not a task) for a human to file a followup
- [ ] `porch verify <id> --skip "reason"` records a waiver and transitions directly to `integrated` — first-class command, not hidden in a risk table
- [ ] `porch verify <id> --reset` clears `verify_failed` after a followup fix is merged and re-emits the verify scaffold
- [ ] Unit tests cover verify phase transition, verify-approval gate, verify note creation, the fail path, the skip path, the reset path, and the AI-scaffolding constraint
- [ ] `afx status` / workspace views surface `committed` vs `integrated` as distinct states and show an `Awaiting Verification` bucket
- [ ] Backward compatibility: existing projects pre-upgrade auto-inject a pre-approved verify-approval gate on load; mid-flight projects can migrate via `porch verify --skip "pre-upgrade project"`
- [ ] Required new forge concepts implemented per forge family: `pr-create`, `pr-comment`, `pr-is-merged`, `pr-comments`, `pr-current-branch`

## Constraints

### Technical Constraints
- Must use the existing **forge concept layer** for PR operations (`executeForgeCommand`), not raw `gh` calls — this applies to both checkpoint PR creation and verify-phase PR comment posting
- Must maintain backward compatibility — gates without external review should work exactly as before, and existing in-flight projects at the `review`/`pr` gate must not break on upgrade
- Must work across all protocols with gates (SPIR, ASPIR, TICK for checkpoint PRs; SPIR and ASPIR for the Verify phase; BUGFIX/AIR stay terminal at `pr`)
- Porch is a per-invocation CLI — no in-memory state between invocations; all state in status.yaml
- The `verify-approval` gate must use the same human-only guard as `spec-approval` and `plan-approval` — no AI-driven auto-approval path under any circumstance

### Design Constraints
- Checkpoint PR creation should be opt-in, not automatic — the architect decides when external review is needed
- Feedback should be storable in status.yaml (not just ephemeral `afx send` messages)
- Revision at gates should reuse the existing build→verify cycle, not create a parallel path
- Must not add mandatory latency to gates that don't use external review
- The Verify phase must not run 3-way consultation (verification is experiential, not analytical)
- Verify notes are **append-only** — failed verifications are preserved as durable records, and followup fixes append new verifier entries rather than overwriting
- The `committed → integrated` transition must remain a distinct, human-gated step; never collapsed into PR merge

## Assumptions
- External feedback arrives asynchronously (could be hours or days)
- The architect mediates feedback — they decide when enough feedback has arrived
- Checkpoint PRs use the same branch as the builder's worktree (no separate branch)
- A single checkpoint PR persists through the entire protocol lifecycle — from spec-stage checkpoint through code review through post-merge verification
- `afx send` remains the real-time communication channel; porch state captures persistent feedback
- Teammates running verification have local shell access, `gh` (or equivalent forge CLI), and the ability to install/test the merged change in their own environment
- A single-verifier PASS is sufficient sign-off for v1; teams that need multi-verifier policies can achieve them informally by delaying the `porch approve` call until multiple entries are present
- Verify-phase failure paths (bugfix, rollback, TICK amendment) are out of scope for this spec — the verify phase hands off cleanly to those existing protocols

## Solution Approach

### Component 1: Opt-In Checkpoint PR at Gates

**Key invariant**: Checkpoint PRs are **strictly opt-in**. `porch next` does **not** emit a "create checkpoint PR" task on its own when a gate becomes pending. The task is emitted **only after** a human driver explicitly opts in via `porch checkpoint <id>` (Component 2). This removes the contradiction where an AI builder would auto-create a PR every time it hit a gate.

Default flow (no external review): gate becomes `pending` → architect reviews the artifact in-place → `porch approve <id> <gate>` → done. Zero change from today's behavior.

Opt-in flow (external review wanted):
1. Builder reaches a gate → gate enters `pending`
2. Architect decides external review is warranted → runs `porch checkpoint <id>` (this is the opt-in; no flag or `afx send` needed)
3. Porch transitions the gate from `pending` → `external_review` and records the request
4. On the next `porch next`, porch emits a task for the builder to create the checkpoint PR (via forge concept `pr-create`), providing:
   - A template title: `[Checkpoint] Spec ${ID}: ${TITLE} — review at ${PHASE} gate`
   - A template body explaining this is a checkpoint PR for team review, with a link back to the spec/plan artifact
   - A directive to create the PR as a **draft** (if the forge supports it) so it is visually marked as not-ready-for-merge
5. Builder creates the PR, records the PR number via `porch checkpoint <id> --pr <n>` (or porch auto-detects via forge concept `pr-current-branch`)
6. Builder runs `porch done` → gate stays in `external_review`, idempotent — no further tasks emitted until feedback is received or the gate is approved

If a PR already exists on the branch when `porch checkpoint` is run, creation is skipped and the existing PR number is recorded (idempotent).

### Component 2: Gate Sub-State Model and `porch checkpoint` Command

**Naming note**: The command is `porch checkpoint`, not `porch review`. The name `review` is already used for the implementation-review phase, so reusing it as a command name is confusing. `porch checkpoint` makes the opt-in-for-external-review semantics explicit.

Extend `GateStatus` in `types.ts`:

```typescript
export interface GateStatus {
  status: 'pending' | 'external_review' | 'feedback_received' | 'approved';
  requested_at?: string;
  approved_at?: string;
  checkpoint_pr?: number;        // PR number of the checkpoint PR
  checkpoint_requested_at?: string; // When porch checkpoint was first invoked
  feedback_history?: Array<{       // Append-only log of feedback rounds
    at: string;
    source: 'manual' | 'pr-comments';
    text: string;
  }>;
  feedback?: string;             // Most-recent feedback text (for prompt context)
  feedback_at?: string;          // When most-recent feedback was received
}
```

New porch commands (command surface):

- `porch checkpoint <id> [--pr <n>]` — Architect opts a gate into external review.
  - With no `--pr`: transitions gate `pending` → `external_review`, records `checkpoint_requested_at`. Next `porch next` will emit a "create checkpoint PR" task.
  - With `--pr <n>`: same transition, but also records the PR number directly (used when the PR was created manually or pre-exists on the branch).
  - Idempotent: running it a second time with an already-recorded PR is a no-op.
- `porch feedback <id> "text"` — Architect passes feedback.
  - Transitions gate from `external_review` → `feedback_received`.
  - Appends to `feedback_history`, sets `feedback` to the new text.
  - **Resets `build_complete = false` and increments `iteration`** — this is what wakes the build→verify cycle, not `porch done`.
  - Builder must be signalled separately via `afx send <builder-id> "feedback available, run porch next"` (explicit wake-up; porch is a CLI, it cannot push to a running builder).
- `porch feedback <id> --from-pr` — Pulls feedback from PR comments automatically (via forge concept `pr-comments`). Same state transition as above.

### Component 3: Revision Flow

Triggered when gate is in `feedback_received` state and `build_complete == false`:

1. Architect runs `porch feedback <id> "..."` (or `--from-pr`) → gate is `feedback_received`, `build_complete=false`, `iteration` incremented.
2. Architect sends `afx send <builder-id> "feedback stored, run porch next"` to wake the builder.
3. Builder runs `porch next` → porch detects `feedback_received` + `!build_complete` and emits revision tasks. Revision tasks carry the current `feedback` text as prompt context.
4. Builder revises the artifact (spec or plan) in-place.
5. Builder runs `porch done` → sets `build_complete=true` (standard semantics — this step **does not** reset anything).
6. Builder runs `porch next` → porch detects `build_complete=true` with no prior verify at the new iteration → emits 3-way consultation tasks for the revised artifact.
7. Consultation results land. If unanimous APPROVE → porch transitions gate back to `pending`. If any REQUEST_CHANGES → porch re-emits a further build iteration (standard build→verify loop).
8. Architect either runs `porch approve <id> <gate>` to approve, or runs `porch checkpoint <id>` again (with no `--pr`, since the checkpoint PR is already recorded) to request another round of external review — which re-transitions to `external_review` without creating a new PR.

This reuses the existing build→verify cycle unchanged. The only new mechanics are: (a) `porch feedback` resets `build_complete` and increments iteration (the wake-up trigger), and (b) gate sub-states gate-keep which tasks `porch next` emits. No parallel pipeline.

**Note on `max_iterations=1`**: The current SPIR spec/plan phases set `max_iterations: 1`. This is a hard limit on the *initial* build→verify loop. Feedback-driven revisions happen *after* the gate is approved once, so they run as fresh iterations against the same limit — each `porch feedback` call starts a new 1-iteration loop. The implementation plan (Phase 2 of this spec) will need to confirm this is how porch's iteration counter behaves; if not, the plan must raise or rename `max_iterations` for feedback-driven revisions.

### Component 4: Tighten `pr-exists` Check

Independent correctness fix: Change `pr-exists` forge scripts to only return `true` for OPEN or MERGED PRs. CLOSED-not-merged PRs are excluded. This ensures:
- A checkpoint PR that was abandoned (closed without merging) doesn't accidentally satisfy the review phase check
- The existing bugfix #568 scenario (merged PRs) continues to work

Ships **independently** of the rest of this spec (see Implementation Ordering below).

### Component 5: Prompt Updates

Update builder prompts to guide checkpoint PR creation at gates and post-merge verification:
- Gate-pending tasks should mention "If the architect runs `porch checkpoint`, you will be asked to create a checkpoint PR for team review"
- Review phase prompts should note "If a checkpoint PR already exists (recorded as `checkpoint_pr` in status.yaml), use it — don't create a second PR"
- A new `verify.md` prompt drives the post-merge verification workflow — **scaffolding only**; see the critical AI-hallucination constraint in Component 6
- Builder role (`codev/roles/builder.md`, `codev-skeleton/roles/builder.md`) should document both checkpoint PRs and the verify phase as legitimate workflows, including the explicit rule that AI builders may not sign off on verify-approval

### Component 6: Post-Merge Verify Phase

Add a new terminal phase after `review` in SPIR and ASPIR, making post-merge verification an explicit, porch-tracked step.

#### 6a. Protocol Definition

In `codev-skeleton/protocols/spir/protocol.json` and `codev-skeleton/protocols/aspir/protocol.json` (and their source copies under `codev/protocols/`), add a new phase after `review`:

```json
{
  "id": "verify",
  "name": "Verify",
  "description": "Post-merge environmental verification by a human team member",
  "type": "once",
  "build": {
    "prompt": "verify.md",
    "artifact": "codev/verifications/${PROJECT_TITLE}.md"
  },
  "max_iterations": 1,
  "on_complete": {
    "commit": true,
    "push": true
  },
  "checks": {
    "verify_note_exists": "test -f codev/verifications/${PROJECT_TITLE}.md",
    "verify_note_has_pass": "grep -qE '^Final verdict:.*PASS' codev/verifications/${PROJECT_TITLE}.md || grep -qE '^- \\*\\*Result\\*\\*:.*PASS' codev/verifications/${PROJECT_TITLE}.md",
    "pr_is_merged": "forge pr-is-merged ${CHECKPOINT_PR}"
  },
  "gate": "verify-approval",
  "next": null
}
```

Review phase's `next` field changes from `null` to `"verify"`, and its `gate` stays as `"pr"`.

**New phase type**: `once` is a new phase type that does not exist in the current porch runtime. Today porch supports `build_verify` and `per_plan_phase`. This spec introduces `once` for phases that emit a single batch of tasks, run checks, hit a gate, and terminate — no build→verify loop, no 3-way consultation. The implementation plan must include the runtime support (`packages/codev/src/commands/porch/next.ts`) for handling `type: 'once'` phases. This is an explicit new-infrastructure item, not a re-use of existing machinery.

Verify is `once`-type (not `build_verify`) — it does **not** run 3-way consultation. Environmental verification is experiential, not analytical; asking Gemini/Codex/Claude whether Tower restarts cleanly is a category error. The artifact's quality is validated by check scripts and human sign-off, not LLM review.

**Check strengthening**: The `verify_note_has_pass` check looks for either an overall `Final verdict: PASS` in the sign-off block or at least one verifier entry with `Result: PASS`. A section-header-only check (`^## Sign-off`) is too weak — it would pass on an unfilled template. The plan phase must confirm the exact regex works against the rendered template.

**Forge invocation**: The `pr_is_merged` check uses `forge pr-is-merged <pr>` — this is a new forge concept (see Component 6d below). Raw `gh pr view` is forbidden.

#### 6b. Verify Note Artifact

Location: `codev/verifications/${PROJECT_TITLE}.md`

Template (stored at `codev-skeleton/protocols/spir/templates/verify-note.md` and copied into the worktree when the verify phase begins):

```markdown
# Verification: ${PROJECT_TITLE}

## Metadata
- **Project ID**: ${PROJECT_ID}
- **PR**: #${PR_NUMBER}
- **Merged at**: <timestamp>

## Verification Checklist

- [ ] Installed the merged build in the target environment
- [ ] Expected entry point is reachable (CLI flag / UI path / endpoint)
- [ ] Expected behavior is observable (what does the user see?)
- [ ] No regressions in adjacent features (list them)
- [ ] Tower / services restart cleanly (if applicable)
- [ ] Acceptance criteria from the spec are all satisfied

## Verifiers

### Verifier 1
- **Name**:
- **Environment**: <OS, shell, relevant versions>
- **Date**: <YYYY-MM-DD>
- **Result**: PASS | FAIL | PARTIAL
- **Notes**:

<!-- Additional verifiers append further entries below -->

## Sign-off

Final verdict: <PASS | FAIL>
Summary: <one-paragraph summary of what was verified and observed>
```

Multiple verifiers append entries. `verify-approval` is gated on a **machine-verifiable PASS signal** (see the `verify_note_has_pass` check above) — not a section-header-only match. The Sign-off block is set once at the time the human runs `porch approve verify-approval`; on re-verification after a subsequent fix, the existing Sign-off block is *updated in place* to reflect the new overall verdict while the prior verifier entries remain. This reconciles "append-only verifier entries" with "single overall sign-off": entries are append-only, the sign-off block is the current rollup.

**Verify note commit mechanics**: The verify note is a single markdown file with no code risk. It must land on `main` to be visible to the team. The realistic flow, given most repos enforce branch protection:

1. The AI builder (during the verify phase) creates/updates the verify note on a new branch `verify/${PROJECT_TITLE}` forked from latest `main`, commits the copied template plus any metadata it can fill from status.yaml (PR number, merge timestamp, project title), and opens a small verification PR titled `[Verify] ${PROJECT_TITLE}`.
2. The AI builder does **not** fill in verifier entries. It pushes the scaffolding, posts `afx send architect "Verify note scaffold ready at <PR URL>. Please verify in your environment and fill in the verifier entry."`, and exits.
3. A human verifier clones the branch (or edits via the forge UI), completes the checklist, appends their verifier entry, and updates the Sign-off block.
4. The verification PR is merged via normal review (no 3-way consultation — same reason as the phase type).
5. After the verification PR merges, the human runs `porch approve <id> verify-approval`. Porch confirms the verify note is on main (`git show main:codev/verifications/${PROJECT_TITLE}.md` exists and passes `verify_note_has_pass`) before transitioning the gate to `approved`.

This flow keeps the mechanics simple: the verify note lives on main (auditable), the verification PR is the "hand-off surface" between the AI scaffolding step and the human verification step, and `porch approve verify-approval` is the final human-only gate.

For single-developer repos or repos without branch protection, step 1-4 can collapse into a direct commit to main — the implementation plan should support both paths, but the PR path is the documented default.

#### 6c. Porch Commands and State

New command surface on porch:

- `porch next <id>` — after the `pr` gate is approved, emits verify-phase **scaffolding** tasks for the AI builder:
  1. Copy `codev-skeleton/protocols/spir/templates/verify-note.md` to `codev/verifications/${PROJECT_TITLE}.md`
  2. Fill in known metadata fields from status.yaml (project ID, PR number, merge SHA, merge timestamp)
  3. Create a verification PR (branch `verify/${PROJECT_TITLE}`) via forge concept `pr-create`
  4. Send `afx send architect "Verify scaffold ready: <PR URL>. Please verify and sign off."`
  5. Exit and wait — the builder may not proceed further on its own

  **The AI builder may not fill in verifier entries, may not mark checklist items complete, and may not call `porch approve verify-approval`**. These are human-only actions. The verify.md prompt must reinforce this constraint in bold, unambiguous language at the top of the prompt.

- `porch done <id>` — as today, signals the builder's scaffold-creation step is complete. Transitions the phase to "awaiting verification" (the gate-pending state for `verify-approval`).
- `porch approve <id> verify-approval` — **human-only**, guarded by the same mechanism that protects `spec-approval` and `plan-approval`. Marks the project as `integrated`. After approval, porch emits the closing PR comment (see 6d). This is the project's true terminal state.
- `porch verify <id> --fail "reason"` — records a failed verification. Appends a `Result: FAIL` Verifier entry with the reason (if the human hasn't already), keeps project in `committed` state, sets a `verify_failed` flag. Halts any running AI builder for this project. Emits a directive in the `porch next` output: *"Verification failed. A human must file a bugfix or TICK amendment. AI builder: stop."* — this is a directive **for the human**, not an auto-executable task.
- `porch verify <id> --skip "reason"` — records a **waiver** for projects where environmental verification is not applicable (e.g. doc-only PRs, internal refactors with no observable surface). Appends a `Result: N/A` entry with the reason, transitions directly to `integrated`. Still human-only. This was previously buried in the risk table and is now a first-class command.

State model additions:
- `ProjectState.lifecycle_state` (new, optional): `'in_progress' | 'committed' | 'integrated'`. Derived lazily from phase+gates so existing status.yaml files still parse. Consumers (`afx status`, workspace views) read this derived state.
- `GateStatus` gains no new fields for `verify-approval` beyond Component 2 — it uses the plain `pending | approved` model. The richer `external_review` / `feedback_received` sub-states from Component 2 are reserved for spec/plan gates where checkpoint PRs live.

**`pr` gate semantics clarification**: In current porch, `porch approve <id> pr` marks the PR-review gate approved — it does not itself perform the merge. The merge is a separate human action. To prevent the verify phase from starting on an unmerged PR, porch's transition from review phase (`pr` gate approved) to verify phase must be conditioned on `forge pr-is-merged <checkpoint_pr>` returning true. If the PR gate is approved but the PR is not yet merged, porch emits a "merge the PR first" task and stays in place. Only when the merge is confirmed does porch advance to the verify phase and the project enters the `committed` state.

The `verify-approval` gate's approval then marks the project as `integrated`. Until `verify-approval` is approved, the project remains visible in `afx status` and `porch pending` as a committed-but-not-integrated project, so it cannot silently fall off the radar.

#### 6d. PR Comment Emission (post-approval, not mid-phase)

**Timing correction**: The PR comment is emitted **after** `verify-approval` is approved, not during verify-phase task execution. It is a closing action, fired by `porch approve <id> verify-approval` itself, once the gate transitions to `approved` and the project reaches `integrated` state.

Comment body:

```
✅ Verified via codev/verifications/${PROJECT_TITLE}.md

Result: PASS
Verifier(s): <names from the verify note>
Environment(s): <one-line summary>

See the verify note for the full checklist and observations.
```

PR comment posting uses the **forge concept layer** — a new forge script `pr-comment.sh` per-forge (github/gitlab/gitea), exposed as the `pr-comment` concept. This joins the required new forge concepts inventoried in Component 6g below. Under no circumstance should porch or the builder call `gh pr comment` directly.

#### 6e. Failure Path

If verification fails, the project must not silently close. The failure path is:

1. Human verifier records the failure in the verify note (`Result: FAIL`, Sign-off verdict: FAIL) via the verification PR
2. Human driver runs `porch verify <id> --fail "one-line reason"`
3. Porch keeps project in `committed` state, sets `verify_failed: true`, and halts the AI builder
4. `porch next` on this project returns a `blocked` status with message: *"Verification failed — reason: <reason>. A human must file a bugfix (`afx spawn N --protocol bugfix`) or TICK amendment. AI builder: stop."* — the AI builder must not auto-create the followup project
5. The verify note stays in the repo as a durable record of what was tried and what broke
6. Once the followup fix is merged, a human re-runs `porch verify <id> --reset` to clear `verify_failed` and re-emit the verify scaffold (same project, new verifier entry referencing the new merge SHA)

#### 6f. Integration with afx and Workspace Views

`afx status` and the workspace Work view gain a new badge/column distinguishing `committed` from `integrated`. Projects in `committed` state are called out so the team can see what's waiting on verification. The existing `Active Builders / PRs / Backlog` bucketing is preserved; a new `Awaiting Verification` bucket is added.

#### 6g. Required New Forge Concepts

Inventory of forge concepts introduced by this spec. Each requires a script per forge family (`github`, `gitlab`, `gitea`) under `packages/codev/scripts/forge/<family>/`:

| Concept | Purpose | Used by |
|---------|---------|---------|
| `pr-create` | Create a PR on the current branch with title/body/draft flag | Component 1 (checkpoint), Component 6b (verification PR) |
| `pr-comment` | Post a comment on a specific PR number | Component 6d (closing comment) |
| `pr-comments` | Fetch all comments from a specific PR (for `porch feedback --from-pr`) | Component 2 |
| `pr-is-merged` | Return 0 if PR is in MERGED state, non-zero otherwise | Component 6a (check), 6c (state transition guard) |
| `pr-current-branch` | Return the PR number (if any) for the current branch's HEAD | Component 1 (idempotent checkpoint detection) |

Existing concepts reused (no changes needed): `pr-exists` (tightened in Component 4).

All concepts are invoked through the existing `executeForgeCommand` wrapper. No raw `gh` / `glab` / `tea` calls anywhere in the codev runtime or builder prompts.

## Implementation Ordering (v1 Slicing)

The scope of this spec is large. It is intentionally one umbrella spec because the pieces share architectural context (gate state model, forge concept layer, builder prompts), but the pieces are **independently shippable** and should be implemented and merged as separate PRs to keep review burden manageable:

### Slice A — `pr-exists` tightening (Component 4 only)
- Standalone correctness fix
- ~5-line change per forge script + unit test
- Ships on its own, unblocks nothing, blocks nothing
- **Ship first**: gives an early win and derisks forge script changes

### Slice B — Checkpoint PRs and feedback flow (Components 1, 2, 3, 5)
- Depends on forge concepts `pr-create`, `pr-comments`, `pr-current-branch`
- Introduces gate sub-states (`external_review`, `feedback_received`), `porch checkpoint` and `porch feedback` commands, revision flow
- Does **not** depend on Slice C
- Ship as a single PR after Slice A
- Unit tests cover every state transition and the `--from-pr` happy path

### Slice C — Post-Merge Verify phase (Component 6)
- Depends on forge concepts `pr-comment`, `pr-is-merged`
- Introduces new `once` phase type in porch runtime
- Introduces `verify` phase, `verify-approval` gate, `integrated` lifecycle state
- Introduces `porch verify` command with `--fail`, `--skip`, `--reset` flags
- Ship after Slice B (needs the `verify.md` prompt scaffolding pattern from Component 5)
- Migration shim for in-flight projects (Component 6 backward compat) ships in the same PR

### Cross-cutting updates (ship with the corresponding slice)
- `afx status` / workspace view changes: in **Slice C** (when `committed` vs `integrated` becomes a distinction worth displaying)
- Builder role and prompt updates: split — checkpoint PR guidance in **Slice B**, verify phase guidance in **Slice C**

If any slice proves too large in planning, it can be sub-sliced further — but no slice may be deferred without updating this spec, because the framing depends on the three-stage team visibility story being whole.

## Traps to Avoid

1. **⚠️ AI BUILDERS MUST NEVER SIGN OFF ON VERIFY**: The AI cannot physically verify deployed software. It cannot install a CLI in someone else's shell, watch a Tower restart, or see a button rendered in a browser. The AI's role in the verify phase is **scaffolding only** — copy template, create verification PR, notify architect, exit. Any verify.md prompt that instructs the AI to "run the checklist" or "fill in the verifier entry" is broken and must be rejected. The verify-approval gate uses the same human-only guard as spec-approval / plan-approval.
2. **Don't make checkpoint PRs automatic**: `porch next` must never emit a PR-creation task on its own when a gate becomes pending. The task is emitted only after `porch checkpoint <id>` is explicitly run. Without the opt-in, an AI builder would create a PR every gate, every time.
3. **Don't create a separate PR for review phase**: The checkpoint PR accumulates all work and becomes the final PR. Creating a second PR wastes the review history.
4. **Don't model feedback as a simple string (indefinitely)**: For v1, a string is fine — don't over-engineer. But `feedback_history` is an array so future iterations can add structured fields without breaking the schema.
5. **Don't skip consultation on revisions**: Revised artifacts must go through the build→verify cycle. This is the whole point of porch's discipline.
6. **Don't break gates that don't use external review**: The new sub-states (`external_review`, `feedback_received`) are opt-in via `porch checkpoint`. A gate that goes directly from `pending` → `approved` must work exactly as before.
7. **Don't hardcode `gh` CLI calls**: Use the forge concept layer for PR creation, detection, and comment posting. Inventory in Component 6g.
8. **Don't run 3-way consultation on the verify note**: Environmental verification is experiential, not analytical. LLMs cannot judge whether a CLI actually runs on a user's machine. The verify phase is a `once`-type phase, not `build_verify`.
9. **Don't collapse `committed` and `integrated`**: These are intentionally separate states. A project that is merged but broken must still be visible and reachable — not archived as "done."
10. **Don't lose the verify note on failure**: A failed verification is more valuable than a successful one — it is the record of what broke. Never delete a verify note; on re-verification, append a new verifier entry and update the Sign-off block in place.
11. **Don't advance to Verify on an unmerged PR**: The `pr` gate being approved doesn't mean the PR was merged. Porch must guard the review→verify transition with `forge pr-is-merged` and stay put if the PR is still open.
12. **Don't conflate `porch review` with the review phase**: The opt-in command is `porch checkpoint`, not `porch review`. Reusing the name `review` for both a phase and a command is confusing and was explicitly flagged in consultation.
13. **Don't reset `build_complete` inside `porch done`**: `porch done` always sets `build_complete=true`. The reset on feedback happens inside `porch feedback`, which also increments `iteration`. This is the semantic that wakes the build→verify loop for a revision pass.

## Open Questions

### Critical (Blocks Progress)
- [x] Should checkpoint PR creation be automatic or opt-in? — **Opt-in**. The architect triggers it, not porch.
- [x] What does the verify phase produce — a note in the repo, a PR comment, or both? — **Both.** The durable artifact is `codev/verifications/${PROJECT_TITLE}.md`; the PR comment is a short summary linking to it. The repo file is the source of truth; the PR comment is the notification.
- [x] Is a single PASS verifier enough for `verify-approval`, or should we require N? — **Single PASS is enough for v1.** Teams that want multi-verifier sign-off can add additional verifier entries and delay running `porch approve`. Enforcing N > 1 is a follow-up (tracked in Nice-to-Know).

### Important (Affects Design)
- [x] Should the checkpoint PR be a draft? — **Yes, if the forge supports it.** This signals it's not ready for merge.
- [x] Should `porch feedback --from-pr` pull all PR comments or just new ones? — **All comments** for v1. Filtering can be added later.
- [x] Can the architect approve a gate directly from `external_review` (skip `feedback_received`)? — **Yes**. If the external review is positive with no changes needed, the architect can approve directly.
- [x] Should the verify phase run 3-way consultation on the verify note? — **No.** Verification is experiential. The phase is `once`-type, not `build_verify`.
- [x] What happens if verify fails? — `porch verify <id> --fail "reason"` keeps the project in `committed`, preserves the verify note, and emits tasks to file a followup bugfix/TICK. The project is not allowed to silently auto-close.
- [x] Does the `pr` gate still end the project for BUGFIX/AIR protocols? — **Yes.** Verify phase is only added to SPIR and ASPIR. BUGFIX and AIR stay terminal at `pr`, since they target a single issue and usually don't justify a separate environmental verification step. A future spec could extend verify to them if needed.
- [x] Verify note commit path — direct-to-main or verification PR? — **Verification PR is the default**, direct-to-main is supported as an opt-out for single-developer or no-branch-protection repos. Documented in Component 6b.
- [x] Does the AI builder fill in verifier entries? — **No, absolutely not.** The AI creates scaffolding (template copy + verification PR) and stops. The human fills entries and signs off. Hallucination risk was flagged in consultation; guard is enforced via prompt and verify.md constraint.

### Nice-to-Know (Optimization)
- [ ] Should porch auto-detect PR comments as feedback? — Defer to follow-up. Manual `porch feedback` is sufficient for v1.
- [ ] Should `verify-approval` support a configurable N-verifier policy per project (`min_verifiers: 2`, `required_environments: [darwin, linux]`)? — Defer to follow-up. Single PASS is sufficient for v1.
- [ ] Should the verify note be optionally machine-readable (YAML/JSON fenced block)? — Defer to follow-up. Markdown with a standard template is sufficient for v1.

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
1. **Happy path (no checkpoint, no opt-in)**: Builder reaches gate, architect approves directly — works as before. `porch next` does **not** emit a PR-creation task on gate-pending alone.
2. **Opt-in at spec-approval**: Architect runs `porch checkpoint <id>`; next `porch next` emits PR-creation task; builder creates checkpoint PR with spec
3. **Opt-in at plan-approval**: Same flow for plan gate
4. **Opt-in with pre-existing PR**: Architect runs `porch checkpoint <id> --pr 42`; porch records PR number, emits no creation task
5. **Checkpoint PR accumulates commits**: After gate approval, subsequent phase commits appear on the same PR branch
6. **Checkpoint PR becomes final PR**: In review phase, `pr_exists` check passes because checkpoint PR exists
7. **Idempotent**: Running `porch checkpoint` twice is a no-op; running `porch next` again after creation does not re-emit the creation task

### Functional Tests — Gate Sub-States
8. **pending → external_review**: `porch checkpoint <id>` (with or without `--pr <n>`) transitions state, records PR number
9. **external_review → feedback_received**: `porch feedback <id> "text"` stores feedback, resets `build_complete=false`, increments iteration
10. **external_review → approved**: Direct approval without feedback (positive review)
11. **feedback_received → revision cycle**: `porch next` emits revision tasks with feedback text in prompt context
12. **Revision → consultation → pending**: Revised artifact goes through 3-way review (iteration N+1), reaches pending on unanimous APPROVE
13. **Multiple feedback rounds**: feedback_received → revise → verify → pending → external_review → feedback → revise (feedback_history accumulates)
14. **Backward compatibility**: Existing `pending → approved` flow unchanged — `porch approve` on a plain pending gate still works
15. **`porch done` does not reset build_complete**: Explicit test that calling `porch done` never sets build_complete=false (the reset is exclusive to `porch feedback`)

### Functional Tests — Feedback
16. **Manual feedback**: `porch feedback <id> "Change section X to..."` stores text and appends to history
17. **PR-sourced feedback**: `porch feedback <id> --from-pr` pulls comments from checkpoint PR via `pr-comments` forge concept
18. **Feedback in builder prompt**: Revision tasks include feedback text as context

### Functional Tests — `pr-exists` Tightening
19. **OPEN PR satisfies `pr-exists`**: Existing behavior preserved
20. **MERGED PR satisfies `pr-exists`**: Existing behavior preserved
21. **CLOSED PR does NOT satisfy `pr-exists`**: New behavior — abandoned PRs excluded

### Functional Tests — Post-Merge Verify Phase
22. **Verify phase follows review only after merge**: After the `pr` gate is approved **and** `forge pr-is-merged` returns true, `porch next` advances to the `verify` phase. If the PR is approved-but-not-merged, porch stays in review and emits a "merge the PR first" task.
23. **AI builder emits scaffolding only**: `porch next` in verify phase emits tasks to (a) copy template, (b) fill metadata from status.yaml, (c) create verification PR via `pr-create`, (d) `afx send` architect, (e) exit. Tasks must NOT instruct the AI to fill verifier entries or run the checklist.
24. **Verify.md prompt explicit constraint**: The verify prompt contains an explicit, bold directive: "You are an AI. You cannot verify deployed software. Do not fill verifier entries. Do not sign off. Create scaffolding, notify architect, and exit."
25. **Verify note template copy**: The template from `codev-skeleton/protocols/spir/templates/verify-note.md` is copied into `codev/verifications/${PROJECT_TITLE}.md` on first entry into the verify phase with metadata fields pre-filled
26. **Verify note check — exists**: `verify_note_exists` check passes when the note file is present
27. **Verify note check — has pass**: `verify_note_has_pass` check passes only when `Final verdict: PASS` or at least one verifier entry with `Result: PASS` is present. Fails on an unfilled template (hallucination-guard).
28. **PR must be merged check**: `pr_is_merged` check fails if the PR is not in MERGED state, preventing premature verification
29. **Verify-approval gate pending**: After verification PR is merged to main, porch transitions to `verify-approval` gate in `pending` state
30. **verify-approval is human-only**: `porch approve <id> verify-approval` works for humans; the same human-only guard used for `spec-approval`/`plan-approval` blocks any non-human invocation path
31. **Successful verify → integrated state**: After `verify-approval`, `porch status` shows the project as `integrated`, it disappears from `Awaiting Verification` bucket, and a closing PR comment is posted
32. **Failed verify — porch verify --fail**: `porch verify <id> --fail "Tower fails to restart"` records failure, keeps project in `committed`, halts AI builder, emits directive (not task) for human to file followup
33. **Failed verify preserves note**: The verify note file is NOT deleted on failure; it remains as durable record
34. **Re-verification after fix — porch verify --reset**: `porch verify <id> --reset` clears `verify_failed` and emits new scaffolding. A new verifier entry is appended to the existing note referencing the new merge SHA.
35. **Skipped verify — porch verify --skip**: `porch verify <id> --skip "doc-only PR, no observable runtime surface"` records a waiver, appends N/A verifier entry, transitions directly to `integrated`
36. **Multi-verifier append**: A second verifier entry can be appended to an existing verify note without creating a new file; Sign-off block is updated in place
37. **PR comment posted after approval**: PR comment is posted by `porch approve verify-approval` itself (post-gate), not during verify-phase task emission
38. **PR comment via forge concept**: The closing PR comment is posted via `forge pr-comment`, never raw `gh`
39. **Backward compat — pre-upgrade projects**: Projects whose status.yaml was written before the upgrade auto-inject a pre-approved verify-approval gate on load. Mid-flight projects accept `porch verify <id> --skip "pre-upgrade project"` as a clean migration.
40. **afx status visibility**: `afx status` shows a distinct `Awaiting Verification` bucket for committed-but-not-integrated projects
41. **BUGFIX/AIR unchanged**: Running BUGFIX or AIR projects terminate at `pr` gate as before (no verify phase injected)
42. **ASPIR has verify**: Verify phase applies equally to ASPIR (same phase definition in its protocol.json)
43. **`once` phase type runtime**: Porch runtime handles `type: 'once'` phases — emits a single batch of tasks, runs checks after `porch done`, transitions to gate

### Non-Functional Tests
44. **No latency for simple gates**: Gates without external review have zero additional overhead
45. **Forge abstraction**: All PR operations use forge concepts (`pr-create`, `pr-comment`, `pr-is-merged`, `pr-exists`, `pr-comments`, `pr-current-branch`); no raw CLI calls anywhere in codev runtime or builder prompts
46. **Opt-out path documented**: `porch verify <id> --skip "reason"` is documented in `porch --help` and in the protocol docs, not hidden in risk tables

## Dependencies

### Checkpoint PR feature
- **Forge concept layer** (`packages/codev/src/lib/forge.ts`): For PR creation, detection, comment fetching
- **Forge PR scripts** (`packages/codev/scripts/forge/{github,gitlab,gitea}/pr-exists.sh`): Tighten to exclude CLOSED PRs
- **Porch state types** (`packages/codev/src/commands/porch/types.ts`): Extend GateStatus with sub-states and checkpoint PR fields
- **Porch commands** (`packages/codev/src/commands/porch/index.ts`): New `checkpoint` and `feedback` subcommands
- **Porch next** (`packages/codev/src/commands/porch/next.ts`): Handle new gate sub-states, emit checkpoint PR tasks and revision tasks
- **Builder prompts** (`codev-skeleton/protocols/spir/prompts/*.md`): Guide checkpoint PR workflow
- **Builder role** (`codev/roles/builder.md`, `codev-skeleton/roles/builder.md`): Document checkpoint PR as legitimate workflow

### Post-Merge Verify Phase
- **Protocol definitions**: Update `codev/protocols/spir/protocol.json`, `codev/protocols/aspir/protocol.json`, `codev-skeleton/protocols/spir/protocol.json`, `codev-skeleton/protocols/aspir/protocol.json` to add the `verify` phase and update `review.next`
- **Protocol documents**: Update `codev/protocols/spir/protocol.md` and `codev/protocols/aspir/protocol.md` to describe the verify phase
- **Verify prompt**: New `codev-skeleton/protocols/spir/prompts/verify.md` (and aspir equivalent)
- **Verify note template**: New `codev-skeleton/protocols/spir/templates/verify-note.md`
- **Porch state types** (`packages/codev/src/commands/porch/types.ts`): Add optional `lifecycle_state` derivation; no breaking schema changes
- **Porch commands** (`packages/codev/src/commands/porch/index.ts`): New `verify` subcommand with `--fail` flag
- **Porch next** (`packages/codev/src/commands/porch/next.ts`): Handle the verify phase (emit tasks, check gate, transition to `integrated`)
- **Forge PR comment script**: New `packages/codev/scripts/forge/{github,gitlab,gitea}/pr-comment.sh` to post comments on a merged PR via forge concept
- **Forge concept layer** (`packages/codev/src/lib/forge.ts`): Expose `postPrComment(prNumber, body)` wrapper
- **Gate guards** (`packages/codev/src/commands/porch/approve.ts` or equivalent): Ensure `verify-approval` is human-only, same guard used for `spec-approval` and `plan-approval`
- **afx status / workspace views**: Add `Awaiting Verification` bucket and `committed` vs `integrated` distinction
- **Builder prompts and role**: Document the verify phase as a legitimate, required workflow for SPIR/ASPIR projects

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Gate sub-states add complexity | Medium | Medium | Opt-in design — simple gates work exactly as before |
| Feedback desync (stale feedback) | Low | Low | Feedback is timestamped; architect controls when to send it |
| Checkpoint PR confuses external reviewers | Low | Low | Clear title/body template indicating checkpoint status |
| `pr-exists` tightening breaks workflow | Low | Medium | Only excludes CLOSED PRs; no known workflow depends on them |
| Builder creates checkpoint PR without architect asking | Low | Low | Not harmful — PR can be closed or reused |
| Verify phase becomes tedious ritual, teammates skip it | Medium | Medium | Keep the template short; only require one verifier PASS; make `afx status` surface unverified projects so skipping is visible |
| Verify phase added to projects that don't need it | Low | Low | Allow "not applicable" verifier entry with written justification — the workflow does not hard-fail |
| Backward compat break on upgrade (existing review-terminal projects) | Medium | High | Migration path: on load, porch detects projects whose `review.gate=pr` is approved and whose protocol file has no `verify` phase (old format) vs. has `verify` phase (new format). For projects loaded before the upgrade, porch auto-injects a verify-approval gate pre-approved with `reason: "pre-upgrade project, no verification performed"`. For projects mid-flight at the upgrade moment, the human driver runs `porch verify <id> --skip "pre-upgrade project"` once to transition cleanly. Both paths are tested in migration unit tests. |
| `verify-approval` auto-approved by an AI agent | Low | High | Same human-only guard used by `spec-approval` / `plan-approval`; unit test asserts the guard rejects non-human approvers |
| Verify note becomes stale when a followup fix lands | Low | Medium | Verify notes are append-only; new entries reference the new merge SHA so history is explicit |

## Notes

This spec reframes and extends the original issue (#653). The original framing treated mid-protocol PRs as a bug to prevent. The correct framing is that codev projects need **three-stage team visibility**:

1. **Before implementation** — teammates review the spec/plan (served by checkpoint PRs at gates, Components 1–3, 5)
2. **Before merge** — teammates review the code (served by the existing review phase, unchanged)
3. **After merge** — teammates verify the change works in their own environments (served by the new Verify phase, Component 6)

Components 1–5 make stage 1 a first-class citizen of porch. Component 6 makes stage 3 a first-class citizen. Together they turn porch from a "ship the PR and forget it" machine into a lifecycle tracker that ends only when a human has confirmed the change actually works in the real world.

The `pr-exists` tightening (Component 4) is a standalone correctness fix that benefits the codebase regardless of the rest of this spec.

The explicit split between `committed` and `integrated` is the single most important conceptual change: merging ≠ done. Once this lands, porch will treat "PR merged" and "feature works" as distinct facts, and the team will have a durable record of both.
