# Specification: `afx bench` — Consultation Benchmarking CLI Command

## Metadata
- **ID**: spec-2026-02-19-af-bench-command
- **Status**: draft
- **Created**: 2026-02-19

## Clarifying Questions Asked

1. **Q: Should `afx bench` replace `bench.sh` or coexist?**
   A: Replace — wrap all functionality into the `afx` CLI. The shell script serves as the reference implementation.

2. **Q: Should results go in a project-relative or global directory?**
   A: Project-relative, under `codev/resources/bench-results/` (same as the existing script).

3. **Q: Which engines are supported?**
   A: gemini, codex, claude — the three engines supported by the `consult` CLI.

4. **Q: Should the summary stats (avg/min/max/stddev) be computed only when iterations > 1?**
   A: Yes. For a single iteration, just show the per-engine times. Stats across iterations only make sense with 2+ runs.

## Problem Statement

Benchmarking consultation engine performance currently requires running a standalone shell script (`codev/resources/bench.sh`). This script is undiscoverable, not integrated with the `afx` CLI, and lacks statistical reporting (avg/min/max/stddev). Users who want to compare engine latencies must know the script exists and interpret raw output manually.

## Current State

- `codev/resources/bench.sh` runs `consult -m <engine> --prompt <prompt>` for gemini, codex, and claude
- Supports parallel (default) or sequential execution
- Reports per-iteration, per-engine elapsed time in seconds
- Saves results to timestamped text files in `codev/resources/bench-results/`
- Detects host info (CPU, RAM, hostname) via platform-specific commands
- No summary statistics — just raw times per iteration
- Not integrated into the `afx` CLI — must be invoked directly

## Desired State

A first-class `afx bench` subcommand that:

1. Runs consultation benchmarks with configurable iterations
2. Supports parallel (default) and sequential execution modes
3. Outputs a clean formatted table with per-engine timing per iteration
4. Computes and displays summary statistics (avg/min/max/stddev) across iterations
5. Saves results to timestamped files for historical comparison
6. Auto-detects host information for reproducibility context
7. Is discoverable via `afx --help` and `afx bench --help`

## Stakeholders
- **Primary Users**: Codev developers benchmarking engine performance
- **Secondary Users**: CI/CD pipelines for automated performance tracking
- **Technical Team**: Codev maintainers (self-hosted project)

## Success Criteria
- [ ] `afx bench` runs all 3 engines in parallel and reports timing
- [ ] `afx bench --sequential` runs engines one at a time
- [ ] `afx bench --iterations N` runs N iterations with summary stats
- [ ] `afx bench --prompt "custom"` accepts a custom prompt
- [ ] Per-engine timing displayed in formatted table output
- [ ] Summary stats (avg/min/max/stddev) shown when iterations > 1
- [ ] Results saved to timestamped file in `codev/resources/bench-results/`
- [ ] Host info (hostname, CPU, RAM) included in output
- [ ] `afx bench --help` shows usage information
- [ ] All tests pass with >90% coverage of the new `bench.ts` module
- [ ] Existing `afx` CLI commands unaffected

## Constraints

### Technical Constraints
- Must use the existing `consult` CLI binary (spawn as subprocess, not import)
- Must follow the `afx` CLI command pattern: Commander.js registration, dynamic import, logger utilities
- TypeScript implementation in `packages/codev/src/agent-farm/commands/bench.ts`
- Must work on macOS; Linux host detection as best-effort
- `consult` command must be available on PATH

### Business Constraints
- No new external dependencies — use Node.js built-ins and existing project dependencies (chalk, commander)

## Assumptions
- `consult` CLI is installed and available on PATH
- All three engines (gemini, codex, claude) are configured and accessible
- Individual engine failures should not abort the entire benchmark run (capture error, report as failed)

## Solution Approaches

### Approach 1: TypeScript CLI Command (Selected)
**Description**: Implement `afx bench` as a TypeScript command module following the existing `afx` command pattern. Spawns `consult` as child processes, collects timing data, computes stats, formats output.

**Pros**:
- Consistent with all other `afx` commands
- Type-safe, testable, maintainable
- Can use logger utilities for clean output
- Can compute stats natively (no dependency on Python like bench.sh)

**Cons**:
- More code than a shell script
- Needs build step

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Shell Script Wrapper
**Description**: Keep bench.sh and add a thin `afx bench` wrapper that delegates to it.

**Pros**:
- Minimal code change
- Reuses proven script

**Cons**:
- Two implementations to maintain
- Can't easily add stats/table formatting
- Shell scripts are harder to test
- Inconsistent with other `afx` commands (all TypeScript)

**Estimated Complexity**: Low
**Risk Level**: Medium (maintenance burden)

## CLI Interface

```
afx bench [options]

Options:
  -i, --iterations <n>    Number of benchmark iterations (default: 1)
  -s, --sequential        Run engines sequentially instead of in parallel
  --prompt <text>         Custom consultation prompt (default: "Please analyze
                          the codev codebase and give me a list of potential
                          impactful improvements.")
  --timeout <seconds>     Per-engine timeout in seconds (default: 300)
  -h, --help              Show help
```

## Output Format

### Per-Iteration Output (parallel mode)
```
=== Consultation Benchmark ===
  Host:       macbook-pro
  CPU:        Apple M2 Max
  RAM:        32 GB
  Engines:    gemini, codex, claude
  Mode:       parallel
  Iterations: 3

--- Iteration 1/3 ---
  Engine   Time
  gemini   12.3s
  codex    45.6s
  claude   18.2s
  wall     45.8s

--- Iteration 2/3 ---
  ...

=== Summary ===
  Engine   Avg      Min      Max      StdDev
  gemini   12.5s    11.8s    13.2s    0.7s
  codex    44.2s    42.1s    46.3s    2.1s
  claude   17.8s    16.5s    19.1s    1.3s

Results saved to: codev/resources/bench-results/bench-macbook-pro-20260219-143022.txt
```

### Per-Iteration Output (sequential mode)
Same format but no "wall" time line (wall time equals sum of individual times).

## Result File Format

Saved to `codev/resources/bench-results/bench-{hostname}-{YYYYMMDD}-{HHMMSS}.txt`:

```
=== Consultation Benchmark ===
Host: macbook-pro
CPU: Apple M2 Max
RAM: 32 GB
Mode: parallel
Iterations: 3
Prompt: Please analyze the codev codebase...
Date: 2026-02-19T14:30:22Z

--- Iteration 1/3 ---
gemini: 12.3s
codex: 45.6s
claude: 18.2s
wall: 45.8s

...

=== Summary ===
gemini: avg=12.5s min=11.8s max=13.2s stddev=0.7s
codex: avg=44.2s min=42.1s max=46.3s stddev=2.1s
claude: avg=17.8s min=16.5s max=19.1s stddev=1.3s
```

Individual engine outputs saved to: `{engine}-run{iteration}-{timestamp}.txt`

## Error Handling

- If an engine fails (non-zero exit), record it as `FAILED` in the table and continue with remaining engines/iterations
- If an engine exceeds the `--timeout` value (default 300s), kill it and record as `TIMEOUT` — continue with remaining engines/iterations
- If all engines fail in an iteration, still record the iteration and continue
- If `consult` is not found on PATH, fail immediately with a clear error message
- Engine failures should not affect other engines running in parallel
- `FAILED` and `TIMEOUT` results are excluded from summary statistics (avg/min/max/stddev)
- If `--iterations` is 0 or negative, fail with a clear error message
- The results directory (`codev/resources/bench-results/`) is created automatically if it doesn't exist

### Statistics Definitions
- **stddev**: Sample standard deviation (N-1 denominator) — used because iterations are a sample, not the full population
- **Precision**: All times formatted to 1 decimal place (e.g., `12.3s`)
- **Timing**: Uses `performance.now()` for high-precision elapsed time measurement

## Open Questions

### Critical (Blocks Progress)
- None — requirements are clear from the issue and reference implementation

### Nice-to-Know (Optimization)
- [ ] Should there be a `--engines` flag to select a subset? (Deferred — all 3 for now)
- [ ] Should there be JSON output format? (Deferred — text only for now)

## Performance Requirements
- Benchmark itself should add < 1s overhead per iteration (excluding engine time)
- Parallel mode should overlap engine execution, wall time ≈ slowest engine

## Security Considerations
- No sensitive data — prompts and timing data only
- Results saved to project directory, not transmitted externally

## Test Scenarios

### Functional Tests
1. **Parallel execution**: All 3 engines run concurrently, wall time ≈ max(engine times)
2. **Sequential execution**: Engines run one at a time with `--sequential`
3. **Custom prompt**: `--prompt` flag passes custom text to `consult`
4. **Multiple iterations**: `--iterations 3` runs 3 rounds, summary stats computed
5. **Single iteration**: No summary stats section when iterations = 1
6. **Engine failure**: One engine fails, others succeed — failure recorded, run continues
7. **Results file**: Output saved to timestamped file in bench-results directory

### Unit Tests
1. **Stats computation**: avg/min/max/stddev calculated correctly
2. **Host detection**: CPU, RAM, hostname extracted on macOS
3. **Output formatting**: Table columns aligned, times formatted to 1 decimal

## Dependencies
- **External Services**: gemini, codex, claude consultation APIs (via `consult` CLI)
- **Internal Systems**: `consult` CLI binary
- **Libraries/Frameworks**: Node.js child_process, os modules; existing chalk, commander

## References
- Existing shell script: `codev/resources/bench.sh`
- GitHub Issue: #440
- `afx` CLI entry point: `packages/codev/src/agent-farm/cli.ts`
- Logger utilities: `packages/codev/src/agent-farm/utils/logger.ts`

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Engine API unavailable during bench | Medium | Low | Record as FAILED, continue run |
| Host detection fails on Linux | Low | Low | Fallback to "unknown" |
| `consult` not on PATH | Low | High | Fail fast with clear error message |

## Expert Consultation
**Date**: 2026-02-19
**Models Consulted**: Gemini, Codex (GPT), Claude
**Sections Updated**:
- **CLI Interface**: Added `--timeout` option and explicit default prompt (Gemini, Claude)
- **Error Handling**: Added timeout policy, FAILED exclusion from stats, stddev definition, precision spec (Codex)
- **Success Criteria**: Clarified coverage scope to `bench.ts` module (Claude, Codex)
- **Statistics Definitions**: New subsection defining stddev type, precision, timing method (Codex)

Verdicts: Gemini APPROVE (HIGH), Codex REQUEST_CHANGES (MEDIUM) — addressed, Claude APPROVE (HIGH)

## Approval
- [x] Expert AI Consultation Complete

## Notes
- This is the first project using the ASPIR protocol (autonomous SPIR — no spec/plan approval gates)
- The default prompt should match bench.sh: "Please analyze the codev codebase and give me a list of potential impactful improvements."
