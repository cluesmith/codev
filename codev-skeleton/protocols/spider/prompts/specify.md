# SPECIFY Phase Prompt

You are executing the **SPECIFY** phase of the SPIDER protocol.

## Your Goal

Create a comprehensive specification document that thoroughly explores the problem space and proposed solution.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{project_id}}-{{title}}.md`

## CRITICAL: Multi-Agent Consultation is MANDATORY

The SPIDER protocol **requires** consultation with GPT-5 Codex AND Gemini Pro at specific checkpoints. This is BLOCKING - you cannot proceed without completing consultations.

## Process

### 1. Clarifying Questions (ALWAYS START HERE)

Before writing anything, ask clarifying questions to understand:
- What problem is being solved?
- Who are the stakeholders?
- What are the constraints?
- What's in scope vs out of scope?
- What does success look like?

If this is your first iteration, ask these questions now and wait for answers.

**On subsequent iterations**: If questions were already answered, acknowledge the answers and proceed to the next step.

### 2. Problem Analysis

Once you have answers, document:
- The problem being solved (clearly articulated)
- Current state vs desired state
- Stakeholders and their needs
- Assumptions and constraints

### 3. Solution Exploration

Generate multiple solution approaches. For each:
- Technical design overview
- Trade-offs (pros/cons)
- Complexity assessment
- Risk assessment

### 4. Open Questions

List uncertainties categorized as:
- **Critical** - blocks progress
- **Important** - affects design
- **Nice-to-know** - optimization

### 5. Success Criteria

Define measurable acceptance criteria:
- Functional requirements (MUST, SHOULD, COULD)
- Non-functional requirements (performance, security)
- Test scenarios

### 6. MANDATORY: First Consultation (After Draft)

After completing the initial spec draft:

```bash
# Run consultations in parallel (REQUIRED)
consult --model gemini spec {{project_id}} &
consult --model codex spec {{project_id}} &
wait
```

- Review ALL feedback from both models
- Update the spec with incorporated feedback
- Add a **Consultation Log** section documenting:
  - Key feedback received
  - Changes made in response
  - Any feedback intentionally not incorporated (with reasoning)

### 7. Human Review

After consultation feedback is incorporated:
- Present the spec for human review
- Wait for approval or change requests
- If changes requested, make them and proceed to Step 8

### 8. MANDATORY: Second Consultation (After Human Feedback)

After incorporating human feedback:

```bash
# Run consultations again (REQUIRED)
consult --model gemini spec {{project_id}} &
consult --model codex spec {{project_id}} &
wait
```

- Update Consultation Log with new feedback
- Incorporate changes
- Prepare final spec for approval

## Output

Create or update the specification file at `codev/specs/{{project_id}}-{{title}}.md`.

**IMPORTANT**: Keep spec/plan/review filenames in sync:
- Spec: `codev/specs/{{project_id}}-{{title}}.md`
- Plan: `codev/plans/{{project_id}}-{{title}}.md`
- Review: `codev/reviews/{{project_id}}-{{title}}.md`

Include a **Consultation Log** section in the spec documenting all consultation feedback.

## Signals

Emit appropriate signals based on your progress:

- When waiting for clarifying question answers, **include your questions in the signal**:
  ```
  <signal type=AWAITING_INPUT>
  Please answer these questions:
  1. What should the primary use case be - internal tooling or customer-facing?
  2. What are the key constraints we should consider?
  3. Who are the main stakeholders?
  </signal>
  ```

  The content inside the signal tag is displayed prominently to the user.

- After completing the initial spec draft:
  ```
  <signal>SPEC_DRAFTED</signal>
  ```

- After incorporating consultation feedback:
  ```
  <signal>CONSULTATION_INCORPORATED</signal>
  ```

- After final spec is ready for human approval:
  ```
  <signal>SPEC_READY_FOR_APPROVAL</signal>
  ```

## Commit Cadence

Make commits at these milestones:
1. `[Spec {{project_id}}] Initial specification draft`
2. `[Spec {{project_id}}] Specification with multi-agent review`
3. `[Spec {{project_id}}] Specification with user feedback`
4. `[Spec {{project_id}}] Final approved specification`

**CRITICAL**: Never use `git add .` or `git add -A`. Always stage specific files:
```bash
git add codev/specs/{{project_id}}-{{title}}.md
```

## Important Notes

1. **Consultation is MANDATORY** - Cannot skip GPT-5 + Gemini reviews
2. **Be thorough** - A good spec prevents implementation problems
3. **Be specific** - Vague specs lead to wrong implementations
4. **Include examples** - Concrete examples clarify intent
5. **Document consultations** - Maintain the Consultation Log section

## What NOT to Do

- Don't skip consultations (they are BLOCKING)
- Don't include implementation details (that's for the Plan phase)
- Don't estimate time (AI makes time estimates meaningless)
- Don't start coding (you're in Specify, not Implement)
- Don't use `git add .` or `git add -A` (security risk)
