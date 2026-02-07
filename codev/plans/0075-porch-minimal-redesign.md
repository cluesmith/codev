# Plan 0075: Porch Minimal Redesign (Build-Verify Cycles)

## Overview

Redesign porch to orchestrate **build-verify cycles** where porch runs 3-way consultations automatically, feeds back failures to Claude, and manages iteration/commit/push.

## Dependencies

- Existing porch code (run.ts, repl.ts, claude.ts, etc.)
- consult CLI tool
- git for commit/push

## Implementation Phases

```json
{
  "phases": [
    {
      "id": "phase_1",
      "title": "Protocol Format and Types",
      "description": "Update protocol.json format and types for build_verify phases"
    },
    {
      "id": "phase_2",
      "title": "Build-Verify Loop",
      "description": "Implement the core build-verify cycle in run.ts"
    },
    {
      "id": "phase_3",
      "title": "Consultation Integration",
      "description": "Integrate consult CLI, parse verdicts, synthesize feedback"
    },
    {
      "id": "phase_4",
      "title": "Commit and Push",
      "description": "Add automatic commit/push after successful verification"
    }
  ]
}
```

### Phase 1: Protocol Format and Types

**Goal:** Update protocol.json format to express build_verify phases.

**Files to modify:**

| File | Action |
|------|--------|
| `codev/resources/protocol-format.md` | Update: Document build_verify phase type |
| `packages/codev/src/commands/porch/types.ts` | Update: Add build_verify types |
| `packages/codev/src/commands/porch/protocol.ts` | Update: Parse build_verify config |
| `codev-skeleton/protocols/spir/protocol.json` | Update: Convert to build_verify format |

**New types:**

```typescript
interface BuildConfig {
  prompt: string;           // Prompt file (e.g., "specify.md")
  artifact: string;         // Artifact path pattern (e.g., "codev/specs/${PROJECT_ID}-*.md")
}

interface VerifyConfig {
  type: string;             // Review type (e.g., "spec-review")
  models: string[];         // ["gemini", "codex", "claude"]
  parallel: boolean;        // Run consultations in parallel
}

interface PhaseConfig {
  id: string;
  name: string;
  type: 'build_verify' | 'once' | 'per_plan_phase';
  build?: BuildConfig;
  verify?: VerifyConfig;
  max_iterations?: number;  // Default: 7
  on_complete?: {
    commit: boolean;
    push: boolean;
  };
  gate?: string;
}
```

**Updated spir protocol.json structure:**

```json
{
  "phases": [
    {
      "id": "specify",
      "type": "build_verify",
      "build": { "prompt": "specify.md", "artifact": "codev/specs/${PROJECT_ID}-*.md" },
      "verify": { "type": "spec-review", "models": ["gemini", "codex", "claude"] },
      "max_iterations": 7,
      "on_complete": { "commit": true, "push": true },
      "gate": "spec-approval"
    }
  ]
}
```

### Phase 2: Build-Verify Loop

**Goal:** Implement the core build-verify cycle.

**Files to modify:**

| File | Action |
|------|--------|
| `packages/codev/src/commands/porch/run.ts` | Update: Implement build-verify loop |
| `packages/codev/src/commands/porch/state.ts` | Update: Add iteration tracking |
| `packages/codev/src/commands/porch/types.ts` | Update: Add feedback types |

**State additions:**

```typescript
type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

interface ReviewResult {
  model: string;
  verdict: Verdict;
  file: string;  // Path to review output file
}

interface IterationRecord {
  iteration: number;
  build_output: string;    // Path to Claude's build output
  reviews: ReviewResult[]; // Reviews from verification
}

interface ProjectState {
  // ... existing
  iteration: number;           // Current iteration (1-based)
  build_complete: boolean;     // Has build finished this iteration?
  history: IterationRecord[];  // All iterations (file paths, not summaries)
}
```

**Key insight:** Instead of synthesizing feedback, porch stores file paths. Claude reads these files itself.

**Run loop pseudocode:**

```typescript
async function runBuildVerifyCycle(state, phaseConfig) {
  while (state.iteration <= phaseConfig.max_iterations) {
    // BUILD phase
    const prompt = buildPrompt(state, phaseConfig);
    if (state.iteration > 1) {
      prompt = prependFeedback(prompt, state.last_feedback);
    }

    await runClaude(prompt);  // Wait for PHASE_COMPLETE

    // VERIFY phase
    const feedback = await runVerification(phaseConfig.verify);
    state.last_feedback = feedback;

    if (allApprove(feedback)) {
      // Success - commit, push, proceed to gate
      await commitAndPush(phaseConfig);
      return 'gate';
    }

    // Failure - increment and retry
    state.iteration++;
    saveState(state);
  }

  // Max iterations - proceed to gate anyway
  console.log('Max iterations reached, proceeding to gate');
  return 'gate';
}
```

### Phase 3: Consultation Integration

**Goal:** Run consult CLI, write output to files, parse verdicts.

**Files to modify:**

| File | Action |
|------|--------|
| `packages/codev/src/commands/porch/run.ts` | Update: Verification logic inline |
| `packages/codev/src/commands/porch/prompts.ts` | Update: List history files |

**Verification flow (writes output to files):**

```typescript
async function runVerification(state, verifyConfig): Promise<ReviewResult[]> {
  const reviews: ReviewResult[] = [];

  await Promise.all(
    verifyConfig.models.map(async (model) => {
      const outputFile = `.porch/${state.id}-${state.phase}-iter${state.iteration}-${model}.txt`;

      const proc = spawn('consult', [
        '--model', model,
        '--type', verifyConfig.type,
        'spec',
        state.id
      ]);

      const output = await captureOutput(proc);
      fs.writeFileSync(outputFile, output);

      reviews.push({
        model,
        verdict: parseVerdict(output),
        file: outputFile,
      });
    })
  );

  return reviews;
}

function parseVerdict(output: string): Verdict {
  // Safety: empty/short output = something went wrong
  if (!output || output.trim().length < 50) {
    return 'REQUEST_CHANGES';
  }
  if (output.includes('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (output.includes('APPROVE')) return 'APPROVE';
  return 'REQUEST_CHANGES';  // No explicit verdict = safe default
}
```

**History header (lists files, Claude reads them):**

```typescript
function buildHistoryHeader(history: IterationRecord[]): string {
  let md = '# ⚠️ REVISION REQUIRED\n\n';
  md += '**Read the files below to understand the history and address the feedback.**\n\n';

  for (const record of history) {
    md += `### Iteration ${record.iteration}\n\n`;
    md += `**Build Output:** \`${record.build_output}\`\n\n`;
    md += '**Reviews:**\n';
    for (const review of record.reviews) {
      md += `- ${review.model} (${review.verdict}): \`${review.file}\`\n`;
    }
    md += '\n';
  }

  return md;
}
```

**Key simplification:** No feedback synthesis needed. Claude reads raw consultation output.

### Phase 4: Commit and Push

**Goal:** Automatic commit/push after successful verification.

**Files to modify:**

| File | Action |
|------|--------|
| `packages/codev/src/commands/porch/run.ts` | Update: Add `runOnComplete()` inline |

**Git operations (inline in run.ts):**

```typescript
async function runOnComplete(projectRoot, state, protocol, reviews) {
  const onComplete = getOnCompleteConfig(protocol, state.phase);
  if (!onComplete) return;

  const buildConfig = getBuildConfig(protocol, state.phase);
  const artifact = buildConfig.artifact
    .replace('${PROJECT_ID}', state.id)
    .replace('${PROJECT_TITLE}', state.title);

  if (onComplete.commit) {
    try {
      await exec(`git add ${artifact}`);
      const message = `[Spec ${state.id}] ${state.phase}: ${state.title}\n\nIteration ${state.iteration}\n3-way review: ${formatVerdicts(reviews)}`;
      await exec(`git commit -m "${message}"`);
    } catch (err) {
      console.log('Commit failed (may be nothing to commit).');
    }
  }

  if (onComplete.push) {
    try {
      await exec('git push');
    } catch (err) {
      console.log('Push failed.');
    }
  }
}
```

**Note:** Git logic is inline in run.ts, not a separate git.ts file.

## Claude → Porch → Claude Architecture

**The outer builder Claude just runs porch. Porch spawns an inner Claude to do the work.**

```
Builder Claude (outer)
    │
    └──► porch run XXXX
              │
              └──► Claude (inner) creates artifact
              │         │
              │         └──► <signal>PHASE_COMPLETE</signal>
              │                      or
              │              <signal type=AWAITING_INPUT>questions</signal>
              │
              └──► 3-way verification (Gemini, Codex, Claude)
              │
              └──► Iterate if needed, or advance
```

**Signals from inner Claude:**

| Signal | Meaning | Porch Action |
|--------|---------|--------------|
| `<signal>PHASE_COMPLETE</signal>` | Artifact created, ready for verification | Run 3-way review |
| `<signal>GATE_NEEDED</signal>` | Human approval required | Stop and wait |
| `<signal>BLOCKED:reason</signal>` | Claude is stuck | Log blocker, may retry |
| `<signal type=AWAITING_INPUT>questions</signal>` | Claude needs clarification | Prompt user for answers, store in `context.user_answers`, respawn Claude |

**Role separation:**
- **Builder role (outer)**: `codev-skeleton/roles/builder.md` - Just runs porch, handles gates
- **Phase prompts (inner)**: `codev-skeleton/protocols/spir/prompts/*.md` - Detailed work instructions
- **Spec compliance**: Added to `implement.md` since inner Claude does the coding work

## REPL Updates

Update status display for build-verify:

```
[0075] SPECIFY - Iteration 2/3
  BUILD: complete (Claude finished)
  VERIFY: running...
    gemini: APPROVE
    codex:  running (45s)
    claude: REQUEST_CHANGES

> _
```

## Success Criteria

1. Protocol.json supports `type: "build_verify"` phases
2. Porch runs consultations automatically after Claude completes
3. Verdicts parsed from consultation output
4. Failed verifications feed back to next Claude iteration
5. Successful verification triggers commit + push
6. Human gates come after build-verify cycle completes
7. Max iteration cap prevents infinite loops
8. Status display shows build/verify progress

## Estimated Scope

| Metric | Value |
|--------|-------|
| New files | 0 (all logic inline in existing files) |
| Modified files | 6 (run.ts, types.ts, protocol.ts, state.ts, prompts.ts, protocol-format.md) |
| Lines of code | ~300 |

**Simplification:** Verification and git logic are inline in run.ts. No feedback synthesis needed - Claude reads files directly.

## Testing Strategy

| Test Type | Scope | Status |
|-----------|-------|--------|
| Unit: `parseVerdict()` | Verdict parsing with edge cases | TODO |
| Unit: `allApprove()` | Review result aggregation | TODO |
| Unit: `buildHistoryHeader()` | Prompt history formatting | TODO |
| Integration: build-verify loop | Mock consult CLI, verify state transitions | TODO |
| E2E: full cycle | Manual testing with real consultations | Done (ad-hoc) |

**Existing test coverage:**
- `plan.test.ts`: Phase parsing, advancement, completion checks
- `state.test.ts`: State init with new `history` field
- `protocol.test.ts`: Protocol parsing including `build_verify` type

**Test gaps:**
- No mock for `consult` CLI
- No timeout simulation
- No git failure simulation

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| consult CLI output format changes | Low | Medium | Abstract parsing, easy to update |
| Consultation takes too long | Medium | Low | Parallel execution, timeouts (TODO) |
| Verdict parsing unreliable | Low | High | Safe default to REQUEST_CHANGES, validate output length |
| Silent consultation failures | Low | High | Default to REQUEST_CHANGES on empty/short output |
| Agent ignores feedback files | Medium | Medium | Clear prompt instructions, file paths in header |
