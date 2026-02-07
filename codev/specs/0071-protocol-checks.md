# Spec 0071: Declarative Protocol Checks (pcheck)

**Status**: Draft
**Protocol**: SPIR
**Priority**: High
**Created**: 2026-01-17

## Problem Statement

Protocol compliance currently relies on either:
1. **AI memory** - Claude is instructed to follow phases but can forget or skip steps
2. **Rigid pattern matching** - Checking for exact strings like "Status: Approved"

Neither approach is satisfactory:
- AI memory is not deterministic
- Rigid patterns require strict formatting that humans won't follow consistently

We need a way to:
1. Define protocol requirements declaratively
2. Evaluate them semantically (understanding intent, not just syntax)
3. Tell users what to do next based on current state
4. Work across all protocols (SPIR, TICK, BUGFIX, custom)

## Goals

### Must Have

1. **Declarative check definitions** - YAML format for defining protocol checks
   - File existence checks
   - Semantic content checks via LLM (Haiku)
   - Command execution checks
   - Composable gates from multiple checks

2. **`codev pcheck` command** - Evaluate protocol checks
   - `codev pcheck <gate> --project <id>` - Check if a gate passes
   - `codev pcheck --list` - List available checks and gates
   - Clear output showing which checks pass/fail

3. **`codev pcheck --next` guidance** - Tell user what to do next
   - Based on current check state, recommend next action
   - Human-readable guidance, not just check IDs

4. **Protocol-agnostic design** - Works with any protocol
   - Each protocol defines its own `checks.yaml`
   - No hardcoded protocol knowledge in the evaluator

### Should Have

5. **Integration points** - Other tools can use pcheck
   - `af spawn` calls pcheck before spawning
   - Could be used by CI/CD
   - Scriptable with exit codes

6. **Caching** - Don't re-run expensive LLM checks unnecessarily
   - Cache results based on file content hash
   - Invalidate when files change

### Won't Have (Explicit Exclusions)

- **File access enforcement** - pcheck evaluates state, doesn't block edits (that's hooks)
- **Automatic remediation** - pcheck reports problems, doesn't fix them
- **Real-time monitoring** - pcheck is invoked on-demand, not continuously

## Technical Design

### Check Types

| Type | Parameters | Evaluation |
|------|------------|------------|
| `file_exists` | `pattern` | Filesystem glob check |
| `file_not_exists` | `pattern` | Inverse of above |
| `llm_check` | `file(s)`, `question`, `expect?` | Haiku answers yes/no to semantic question |
| `command` | `run`, `exit_code?`, `stdout?` | Shell command execution |

### Check Definition Format

```yaml
# codev/protocols/spir/checks.yaml

checks:
  # File existence
  spec_exists:
    type: file_exists
    pattern: "codev/specs/{project}-*.md"
    description: "Spec file exists"

  plan_exists:
    type: file_exists
    pattern: "codev/plans/{project}-*.md"
    description: "Plan file exists"

  # Semantic checks (LLM-evaluated)
  spec_human_reviewed:
    type: llm_check
    file: "codev/specs/{project}-*.md"
    question: "Is there evidence a human reviewed and approved this spec?"
    description: "Spec has human approval"

  spec_defines_what_not_how:
    type: llm_check
    file: "codev/specs/{project}-*.md"
    question: "Does this spec focus on WHAT to build (requirements, acceptance criteria) rather than HOW to build it (implementation phases, code structure)?"
    description: "Spec focuses on requirements, not implementation"

  spec_no_implementation_phases:
    type: llm_check
    file: "codev/specs/{project}-*.md"
    question: "Does this spec avoid defining implementation phases or detailed technical approach? Implementation phases belong in the plan, not the spec."
    description: "Spec doesn't include implementation phases"

  spec_has_testable_criteria:
    type: llm_check
    file: "codev/specs/{project}-*.md"
    question: "Does this spec have acceptance criteria that can be objectively verified or tested?"
    description: "Spec has testable acceptance criteria"

  spec_no_unresolved:
    type: llm_check
    file: "codev/specs/{project}-*.md"
    question: "Are there unresolved questions, TODOs, or TBDs that would block implementation?"
    expect: false
    description: "No unresolved TODOs or TBDs"

  spec_consultation_complete:
    type: llm_check
    file: "codev/specs/{project}-*.md"
    question: "Is there evidence of multi-agent consultation (feedback from external AI models like GPT, Gemini, or Codex)?"
    description: "Multi-agent consultation completed"

  plan_has_phases:
    type: llm_check
    file: "codev/plans/{project}-*.md"
    question: "Does this plan break the work into distinct implementation phases with clear boundaries?"
    description: "Plan defines implementation phases"

  plan_covers_spec:
    type: llm_check
    files:
      - "codev/specs/{project}-*.md"
      - "codev/plans/{project}-*.md"
    question: "Does the plan address all requirements and acceptance criteria from the spec?"
    description: "Plan covers all spec requirements"

  # Command checks
  tests_pass:
    type: command
    run: "npm test"
    exit_code: 0
    description: "All tests pass"

  clean_working_tree:
    type: command
    run: "git status --porcelain"
    stdout: ""
    description: "No uncommitted changes"

# Gates are compositions of checks
gates:
  spec_ready:
    description: "Spec is complete and ready for planning"
    all:
      - spec_exists
      - spec_human_reviewed
      - spec_defines_what_not_how
      - spec_no_implementation_phases
      - spec_has_testable_criteria
      - spec_no_unresolved
    guidance:
      pass: "Spec is ready. Create your plan at codev/plans/{project}-*.md"
      fail: "Complete the failing checks before proceeding to planning."

  plan_ready:
    description: "Plan is complete and ready for implementation"
    all:
      - spec_ready
      - spec_consultation_complete
      - plan_exists
      - plan_has_phases
      - plan_covers_spec
    guidance:
      pass: "Plan is ready. Run 'af spawn --project {project}' to start implementation."
      fail: "Complete the failing checks before spawning a builder."

  pr_ready:
    description: "Ready to create pull request"
    all:
      - tests_pass
      - clean_working_tree
    guidance:
      pass: "Ready to create PR."
      fail: "Fix failing tests or commit pending changes before creating PR."
```

### Command Interface

```bash
# Check a specific gate
$ codev pcheck plan_ready --project 0071
Checking gate: plan_ready (Plan is complete and ready for implementation)

✓ spec_exists - Spec file exists
✓ spec_human_reviewed - Spec has human approval
✓ spec_defines_what_not_how - Spec focuses on requirements, not implementation
✓ spec_no_implementation_phases - Spec doesn't include implementation phases
✓ spec_has_testable_criteria - Spec has testable acceptance criteria
✓ spec_no_unresolved - No unresolved TODOs or TBDs
✓ spec_consultation_complete - Multi-agent consultation completed
✓ plan_exists - Plan file exists
✗ plan_has_phases - Plan defines implementation phases
✗ plan_covers_spec - Plan covers all spec requirements

BLOCKED: 2 checks failed

Guidance: Complete the failing checks before spawning a builder.

# What should I do next?
$ codev pcheck --next --project 0071
Current state: spec_ready ✓, plan_ready ✗

Next action: Your plan needs implementation phases.
  Edit: codev/plans/0071-protocol-checks.md
  Add a "## Implementation Phases" section breaking the work into distinct phases.

# List all available checks
$ codev pcheck --list
Protocol: spir

Checks:
  spec_exists          - Spec file exists
  plan_exists          - Plan file exists
  spec_human_reviewed  - Spec has human approval
  ...

Gates:
  spec_ready  - Spec is complete and ready for planning
  plan_ready  - Plan is complete and ready for implementation
  pr_ready    - Ready to create pull request
```

### LLM Check Evaluation

```typescript
async function evaluateLlmCheck(
  check: LlmCheck,
  context: { project: string }
): Promise<{ pass: boolean; reasoning?: string }> {

  const files = Array.isArray(check.file) ? check.files : [check.file];
  const contents = files.map(f => {
    const pattern = expandPattern(f, context);
    const match = glob.sync(pattern)[0];
    return match ? fs.readFileSync(match, 'utf-8') : null;
  });

  if (contents.some(c => c === null)) {
    return { pass: false, reasoning: 'File not found' };
  }

  const prompt = `Based on the following document(s), answer YES or NO to this question:

${check.question}

${contents.map((c, i) => `--- Document ${i + 1} ---\n${c}`).join('\n\n')}

Answer YES or NO, followed by a brief explanation.`;

  const response = await haiku(prompt);
  const answer = response.trim().toUpperCase().startsWith('YES');
  const pass = check.expect === false ? !answer : answer;

  return { pass, reasoning: response };
}
```

### Caching Strategy

- Cache key: `{check_id}:{hash(file_contents)}`
- Store in `.codev/pcheck-cache.json`
- TTL: Until file changes (content hash mismatch)
- LLM checks are expensive (~$0.001 each, ~500ms), worth caching

## Acceptance Criteria

1. **Check evaluation works** - `codev pcheck <gate> --project <id>` correctly evaluates all check types
2. **Semantic checks are accurate** - LLM checks correctly interpret human-written content without requiring rigid formats
3. **Guidance is helpful** - `--next` flag provides actionable guidance
4. **Protocol-agnostic** - Works with spir, tick, bugfix, and custom protocols
5. **Performance acceptable** - Cached checks return instantly; uncached LLM checks complete in <2s each

## Open Questions

1. **Should gates be nestable?** - Can a gate reference another gate, or only checks?
   - Proposal: Yes, gates can include other gates for composition

2. **How to handle multi-file checks?** - For `plan_covers_spec`, both files are needed
   - Proposal: `files` array, all contents passed to LLM

3. **What happens when files don't exist?** - If spec doesn't exist, all spec checks fail
   - Proposal: `file_exists` check should be listed first; other checks auto-fail if file missing

## References

- Spike findings: `codev/spikes/checklister/README.md`
- SPIR Protocol: `codev/protocols/spir/protocol.md`
