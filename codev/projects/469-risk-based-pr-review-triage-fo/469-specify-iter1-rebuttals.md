# Spec 469 — Iteration 1 Rebuttals

## Gemini (REQUEST_CHANGES)

### 1. CLI Orchestration vs Bash Orchestration
**Resolved.** Redesigned the CLI approach. Instead of `consult --risk auto` being an orchestrator, introduced `consult risk pr <N>` as a **reporter command**. It assesses risk and outputs recommended commands. The architect runs those commands manually, just as they do today. This avoids the entire orchestration complexity.

### 2. Model Selection for Medium Risk
**Resolved.** Spec now explicitly states: medium risk → architect runs `consult -m claude --type integration pr N` (Claude recommended for speed/cost at ~60-120s). Same integration review prompt. `-m` flag is not affected — it remains required for `consult -m` invocations, and `consult risk` is a separate subcommand that never invokes models.

### 3. Subsystem Configuration Storage
**Resolved.** Spec now defines: subsystem path mappings stored in `codev/resources/risk-triage.md` (human-readable) and hardcoded in the `consult risk` command (for auto-detection). Both updated together. Full initial path pattern table added to the spec.

### 4. Low Risk Execution Behavior
**Resolved.** `consult risk` always reports the risk level and recommended action. For low risk, the output says "No consultation needed. Read PR and merge." The command itself never invokes models regardless of risk level — it's purely a reporter.

## Codex (REQUEST_CHANGES)

### 1. No deterministic decision algorithm
**Resolved.** Added explicit precedence rule: "highest individual factor wins." If any single factor (lines, files, subsystem, cross-cutting) is high-risk, the overall assessment is high. This is fail-safe — ambiguous signals escalate.

### 2. Missing PR context handling
**Resolved.** `consult risk pr <N>` takes PR number as positional argument. Uses `gh pr diff --stat <N>` and `gh pr view <N> --json files` for data.

### 3. No behavior when `gh` is unavailable
**Resolved.** Spec now explicitly states: fail with clear error message. No fallback, no silent default. This follows the project's "fail fast, never implement fallbacks" principle.

### 4. Default behavior for omitted `--risk`
**Resolved.** No longer an issue. `consult risk` is a separate subcommand. Omitting it means using existing `consult` commands which work exactly as before. No ambiguity.

## Claude (COMMENT)

### 1. `--risk auto` interaction with `-m` flag
**Resolved.** Redesigned to `consult risk` subcommand (reporter). `-m` flag is irrelevant — `consult risk` never invokes models. Existing `consult -m X` commands are completely unchanged.

### 2. Medium-risk review underspecified
**Resolved.** Spec now explicitly states Claude as the recommended model, standard integration review template, and the reasoning (fastest, most cost-effective).

### 3. Performance requirements contradiction (< 5s vs < 2s)
**Resolved.** Unified to < 3 seconds for `consult risk` command. Removed the contradictory figure.

### 4. Missing error handling for `gh` failures
**Resolved.** Added explicit error handling section: fail fast with clear error for unavailable `gh`, unauthenticated `gh`, PR not found, and network failures.

### 5. Edge cases (deletions-only, binary files, TICK/bugfix PRs)
**Addressed.** Binary files: excluded from line counts, included in file counts. Deletions: weighted same as additions (changes are changes). Risk triage applies to all protocol types (SPIR, TICK, bugfix, ASPIR).
