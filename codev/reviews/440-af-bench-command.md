# Review: af-bench-command

## Summary

Implemented `afx bench` as a first-class CLI subcommand that benchmarks consultation performance across gemini, codex, and claude engines. The command replaces the shell script `codev/resources/bench.sh` with a TypeScript implementation supporting configurable iterations, parallel/sequential execution, per-engine timeouts, statistics computation (avg/min/max/sample stddev), and result file persistence.

## Spec Compliance

- [x] `afx bench` command registered in CLI with `--iterations`, `--sequential`, `--prompt`, `--timeout` flags
- [x] Spawns `consult -m <engine> --prompt <prompt>` for gemini, codex, claude
- [x] Parallel mode (default): all 3 engines run concurrently, wall time reported
- [x] Sequential mode (`--sequential`): engines run one at a time, no wall time
- [x] Per-engine timeout with SIGTERM/SIGKILL cascade
- [x] Host detection (CPU model, RAM) with macOS/Linux/unknown fallbacks
- [x] Summary statistics (avg/min/max/sample stddev with N-1 denominator) shown only when iterations > 1
- [x] FAILED/TIMEOUT results excluded from statistics
- [x] Results saved to `codev/resources/bench-results/bench-{hostname}-{timestamp}.txt`
- [x] Per-engine outputs saved to `{engine}-run{iteration}-{timestamp}.txt`
- [x] Results directory auto-created if missing
- [x] Invalid iterations (0, negative) rejected with clear error
- [x] Missing `consult` on PATH detected with clear error
- [x] Default prompt matches bench.sh: "Please analyze the codev codebase..."
- [x] Default timeout: 300 seconds
- [x] Times formatted to 1 decimal place with 's' suffix

## Deviations from Plan

- **Test file path**: Plan specified `commands/__tests__/bench.test.ts` but tests live at `__tests__/bench.test.ts` (agent-farm level) to match existing project convention. All other agent-farm tests use this location.
- **Phase 2 was a no-op**: The stats-and-output phase deliverables were all implemented in Phase 1 (core-command) since the code structure made it natural to implement stats alongside the main function. Phase 2 consultation verified completeness.

## Lessons Learned

### What Went Well
- ASPIR protocol (no spec/plan gates) enabled fast progression through phases — spec → plan → implement → review in a single session
- 3-way consultation was consistently valuable. Codex caught the missing `--timeout` flag and stats edge cases in the spec phase; Claude caught the missing per-iteration column headers in stats-and-output; all three caught the missing `bench()` tests in the tests phase
- Mocking strategy using `PassThrough` streams for `createWriteStream` worked cleanly for pipe() compatibility
- The `settle()` pattern in `runEngine` cleanly prevents double-resolution of the promise (timeout race with close event)

### Challenges Encountered
- **createWriteStream mock**: Initial mock returned a plain object, but `pipe()` requires a real writable stream. Resolved by using `new PassThrough()` from `node:stream`
- **IEEE 754 rounding**: `(12.35).toFixed(1)` returns `'12.3'` not `'12.4'` due to floating point representation. Fixed test to use `12.36` instead
- **Phase 2 redundancy**: All Phase 2 deliverables were already done in Phase 1. The 3-phase split was overly granular for this feature's size

### What Would Be Done Differently
- Merge Phases 1 and 2 into a single implementation phase. The stats/output logic is tightly coupled with the command module — separating them added consultation overhead without meaningful benefit
- Start with `bench()` orchestration tests from the beginning rather than adding them in a second iteration after consultation feedback

### Methodology Improvements
- ASPIR works well for features of this scope (single module, clear spec). The lack of human gates saved significant wait time
- Consider a heuristic for plan phase count: if total new code is <500 LOC, two phases (implement + test) may be better than three

## Technical Debt
- `bench.sh` shell script still exists at `codev/resources/bench.sh` — can be removed in a follow-up cleanup once `afx bench` is validated in production
- CLI documentation at `codev/resources/commands/agent-farm.md` should be updated to include `afx bench`
- Validation exists in both `cli.ts` (Commander parseInt) and `bench.ts` (iterations < 1 check) — defense in depth, not a problem, but noted

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE). Noted path resolution and timing precision.

#### Codex
- **Concern**: Missing FAILED/TIMEOUT treatment in stats, no timeout policy, stddev undefined, edge cases for iterations 0/NaN
  - **Addressed**: Added `--timeout` flag, stats exclusion rules, sample stddev definition, input validation

#### Claude
- **Concern**: Default prompt buried, timeout undefined, coverage scope ambiguous
  - **Addressed**: Moved default prompt to CLI section, added `--timeout`, clarified coverage to bench.ts module

### Plan Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Default prompt not in plan, path resolution unclear, Node version risk for AbortSignal
  - **Addressed**: Added prompt to plan, specified `process.cwd()`, noted setTimeout fallback

#### Claude
- **Concern**: Test file path wrong convention, console output format ambiguity, result file fields not enumerated, missing all-failures test
  - **Addressed**: Fixed test path, clarified console.log for banners, enumerated file fields, added all-failures test case

### Implement: core-command (Round 1)

#### Gemini
- **Concern**: DRY violation — DEFAULT_PROMPT duplicated in bench.ts and cli.ts
  - **Addressed**: Exported from bench.ts, imported in cli.ts

#### Codex
- No concerns raised (APPROVE)

#### Claude
- **Concern**: DRY violation, error handler branches identical
  - **Addressed**: Exported DEFAULT_PROMPT, merged identical error branches

### Implement: stats-and-output (Round 1)

#### Gemini
- No concerns raised (APPROVE)

#### Codex
- **Concern**: Missing per-iteration Engine/Time header, extra Engines: line in file
  - **Addressed**: Added header row, removed Engines from file output

#### Claude
- **Concern**: Same as Codex
  - **Addressed**: Same fixes

### Implement: tests (Round 1)

#### Gemini
- **Concern**: bench() function untested, missing planned test cases 11-13
  - **Addressed**: Added 7 bench() orchestration tests covering all missing cases

#### Codex
- **Concern**: bench() not tested, required test cases missing, test file path mismatch
  - **Addressed**: Added bench() tests; test path follows project convention (rebutted)

#### Claude
- **Concern**: bench() has zero coverage (~38% of file), 5 of 15 plan cases missing, Linux detection paths untested
  - **Addressed**: Added 9 new tests (7 bench() + 2 Linux detection), bringing total to 34

## Architecture Updates

Added `bench.ts` to the commands directory listing in `codev/resources/arch.md` under the agent-farm commands section. No new subsystems or data flows introduced — bench is a self-contained command module following the existing afx CLI pattern.

## Lessons Learned Updates

No lessons learned updates needed. The patterns observed (mock stream compatibility, floating point rounding in tests, ASPIR efficiency) are specific to this implementation and don't generalize beyond existing entries in lessons-learned.md.

## Flaky Tests
No flaky tests encountered.

## Follow-up Items
- Remove `codev/resources/bench.sh` after `afx bench` is validated
- Update `codev/resources/commands/agent-farm.md` with `afx bench` documentation
