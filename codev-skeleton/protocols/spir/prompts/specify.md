# SPECIFY Phase Prompt

You are executing the **SPECIFY** phase of the SPIR protocol.

## Your Goal

Create a comprehensive specification document that thoroughly explores the problem space and proposed solution.

## Context

- **Project ID**: {{project_id}}
- **Project Title**: {{title}}
- **Current State**: {{current_state}}
- **Spec File**: `codev/specs/{{project_id}}-{{title}}.md`

## Process

### 0. Check for Existing Spec (ALWAYS DO THIS FIRST)

**Before asking ANY questions**, check if a spec already exists:

```bash
ls codev/specs/{{project_id}}-*.md
```

**If a spec file exists:**
1. READ IT COMPLETELY - the answers to your questions are already there
2. The spec author has already made the key decisions
3. DO NOT ask clarifying questions - proceed directly to consultation
4. Your job is to REVIEW and IMPROVE the existing spec, not rewrite it from scratch

**If no spec exists:** Proceed to Step 1 below.

### 1. Clarifying Questions (ONLY IF NO SPEC EXISTS)

Before writing anything, ask clarifying questions to understand:
- What problem is being solved?
- Who are the stakeholders?
- What are the constraints?
- What's in scope vs out of scope?
- What does success look like?

If this is your first iteration AND no spec exists, ask these questions now and wait for answers.

**CRITICAL**: Do NOT ask questions if a spec already exists. The spec IS the answer.

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

### 6. Finalize

After completing the spec draft, signal completion. Porch will run 3-way consultation (Gemini, Codex, Claude) automatically via the verify step. If reviewers request changes, you'll be respawned with their feedback.

## Output

Create or update the specification file at `codev/specs/{{project_id}}-{{title}}.md`.

**IMPORTANT**: Keep spec/plan/review filenames in sync:
- Spec: `codev/specs/{{project_id}}-{{title}}.md`
- Plan: `codev/plans/{{project_id}}-{{title}}.md`
- Review: `codev/reviews/{{project_id}}-{{title}}.md`

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

1. **Be thorough** - A good spec prevents implementation problems
3. **Be specific** - Vague specs lead to wrong implementations
4. **Include examples** - Concrete examples clarify intent

## What NOT to Do

- Don't run `consult` commands yourself (porch handles consultations)
- Don't include implementation details (that's for the Plan phase)
- Don't estimate time (AI makes time estimates meaningless)
- Don't start coding (you're in Specify, not Implement)
- Don't use `git add .` or `git add -A` (security risk)
