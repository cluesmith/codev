# Plan: `afx bench` — Consultation Benchmarking CLI Command

## Metadata
- **ID**: plan-2026-02-19-af-bench-command
- **Status**: draft
- **Specification**: codev/specs/440-af-bench-command.md
- **Created**: 2026-02-19

## Executive Summary

Implement `afx bench` as a TypeScript command module following the existing `afx` CLI pattern (Approach 1 from spec). The command spawns `consult` as child processes, collects timing data via `performance.now()`, computes statistics, and formats output using the existing logger utilities.

Three phases: core command with parallel/sequential execution, statistics and output formatting, and tests.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Test coverage >90% of bench.ts module
- [ ] `afx bench --help` works
- [ ] `afx bench` runs 3 engines in parallel
- [ ] `afx bench --sequential` runs engines serially
- [ ] `afx bench --iterations N` computes summary stats
- [ ] Results saved to timestamped file

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "core-command", "title": "Core Command and Engine Execution"},
    {"id": "stats-and-output", "title": "Statistics, Output Formatting, and Result Files"},
    {"id": "tests", "title": "Unit Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Core Command and Engine Execution
**Dependencies**: None

#### Objectives
- Create the `bench` command module with CLI option parsing
- Register it in `cli.ts`
- Implement parallel and sequential engine execution via `consult` subprocess spawning
- Implement host detection (hostname, CPU, RAM)
- Implement per-engine timeout handling

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/bench.ts` — main command implementation
- [ ] Updated `packages/codev/src/agent-farm/cli.ts` — register bench command
- [ ] Parallel execution: spawn all 3 engines concurrently with `Promise.all`
- [ ] Sequential execution: run engines one at a time with `--sequential`
- [ ] Timeout: kill engine process after `--timeout` seconds, record as TIMEOUT
- [ ] Host detection: hostname via `os.hostname()`, CPU via `sysctl`/`lscpu`, RAM via `sysctl`/`free`

#### Implementation Details

**Default prompt:** `"Please analyze the codev codebase and give me a list of potential impactful improvements."` (must match bench.sh exactly).

**Project root resolution:** Use `process.cwd()` as the base for `codev/resources/bench-results/`. The `afx` CLI is always invoked from the project root (same assumption as all other `afx` commands).

**`bench.ts` structure:**
```typescript
interface BenchOptions {
  iterations: number;
  sequential: boolean;
  prompt: string;
  timeout: number;
}

interface EngineResult {
  engine: string;
  elapsed: number | null;  // null = FAILED or TIMEOUT
  status: 'ok' | 'failed' | 'timeout';
}

interface IterationResult {
  iteration: number;
  engines: EngineResult[];
  wallTime: number | null;  // null in sequential mode
}
```

**Engine execution:**
- Spawn `consult -m <engine> --prompt <prompt>` via `child_process.spawn`
- Capture stdout to `{engine}-run{iteration}-{timestamp}.txt`
- Time with `performance.now()` (start before spawn, end on close event)
- Timeout: use `AbortSignal.timeout()` or `setTimeout` + `process.kill()`
- On non-zero exit: `status: 'failed'`, `elapsed: null`
- On timeout: `status: 'timeout'`, `elapsed: null`

**Host detection:**
- Hostname: `os.hostname()`
- CPU: `execSync('sysctl -n machdep.cpu.brand_string')` on macOS, fallback to `lscpu` on Linux, fallback to 'unknown'
- RAM: `execSync('sysctl -n hw.memsize')` on macOS → format as GB, fallback to `free -h` on Linux, fallback to 'unknown'

**CLI registration in `cli.ts`:**
```typescript
program
  .command('bench')
  .description('Run consultation benchmarks across engines')
  .option('-i, --iterations <n>', 'Number of iterations', '1')
  .option('-s, --sequential', 'Run engines sequentially')
  .option('--prompt <text>', 'Custom prompt')
  .option('--timeout <seconds>', 'Per-engine timeout', '300')
  .action(async (options) => {
    const { bench } = await import('./commands/bench.js');
    // parse and validate options, call bench()
  });
```

#### Acceptance Criteria
- [ ] `afx bench` spawns 3 consult processes in parallel
- [ ] `afx bench --sequential` spawns processes serially
- [ ] Engine failures recorded as FAILED, don't abort run
- [ ] Engine timeouts recorded as TIMEOUT after configured seconds
- [ ] `--iterations 0` fails with clear error
- [ ] `consult` not on PATH fails with clear error

#### Test Plan
- **Unit Tests**: Mock `child_process.spawn` to test parallel/sequential logic, timeout handling, failure handling
- **Manual Testing**: `afx bench --iterations 1` against live engines

---

### Phase 2: Statistics, Output Formatting, and Result Files
**Dependencies**: Phase 1

#### Objectives
- Compute summary statistics (avg/min/max/stddev) across iterations
- Format console output using logger utilities (header, kv, row)
- Save results to timestamped file in `codev/resources/bench-results/`
- Save individual engine outputs to per-engine files

#### Deliverables
- [ ] Statistics computation (avg, min, max, sample stddev)
- [ ] Formatted console output matching spec output format
- [ ] Result file saved to `bench-{hostname}-{YYYYMMDD}-{HHMMSS}.txt`
- [ ] Individual engine outputs saved to `{engine}-run{iteration}-{timestamp}.txt`
- [ ] Directory auto-creation for `codev/resources/bench-results/`

#### Implementation Details

**Statistics functions (in bench.ts):**
```typescript
function computeStats(times: number[]): { avg: number; min: number; max: number; stddev: number }
```
- Filter out null values (FAILED/TIMEOUT results)
- Sample stddev with N-1 denominator
- Return values in seconds, formatted to 1 decimal

**Console output:**
- Use `console.log()` for banner lines (`=== Consultation Benchmark ===`, `=== Summary ===`) to match spec's exact format (not `logger.header()` which renders bold+underline)
- Use `logger.kv()` for host info fields: Host, CPU, RAM, Engines, Mode, Iterations
- Use `logger.row()` with fixed column widths for timing tables (Engine, Time columns)
- Wall time shown only in parallel mode

**File output:**
- `mkdir -p` equivalent via `fs.mkdirSync(dir, { recursive: true })`
- Timestamp format: `YYYYMMDD-HHMMSS`
- All individual engine outputs saved in the same `bench-results/` directory
- Full field list in result file header: Host, CPU, RAM, Mode, Iterations, Prompt, Date
- Write both to console (via logger) and to file simultaneously

#### Acceptance Criteria
- [ ] Summary stats shown only when iterations > 1
- [ ] FAILED/TIMEOUT excluded from stats
- [ ] Sample stddev (N-1) computed correctly
- [ ] Times formatted to 1 decimal place
- [ ] Result file created with correct name format
- [ ] Results directory created if missing
- [ ] Wall time shown only in parallel mode

#### Test Plan
- **Unit Tests**: Stats computation with known values, edge cases (all failures, single successful result)
- **Manual Testing**: `afx bench --iterations 3` → verify table formatting and saved file

---

### Phase 3: Unit Tests
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Write comprehensive unit tests for the bench command module
- Achieve >90% coverage of `bench.ts`

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/__tests__/bench.test.ts`
- [ ] >90% coverage of `bench.ts`

#### Implementation Details

**Test strategy:**
- Mock `child_process.spawn` to simulate engine responses with controlled timing
- Mock `os.hostname()` for deterministic host info
- Mock `execSync` for CPU/RAM detection
- Mock `fs` for file writing verification
- Test `computeStats` with known inputs/outputs

**Test cases:**
1. Parallel execution: 3 engines spawned concurrently
2. Sequential execution: engines run one at a time
3. Custom prompt passed to consult
4. Engine failure: non-zero exit recorded as FAILED
5. Engine timeout: process killed after timeout
6. Single iteration: no summary stats section
7. Multiple iterations: summary stats computed correctly
8. Stats computation: known values for avg/min/max/stddev
9. Stats with failures: FAILED excluded from computation
10. Host detection: macOS path, Linux fallback, unknown fallback
11. Results file: correct path and content
12. Invalid iterations: 0 and negative rejected
13. `consult` not on PATH: clear error message
14. All engines fail in all iterations: no stats computed, no division-by-zero
15. Default prompt used when `--prompt` not specified

#### Acceptance Criteria
- [ ] All tests pass
- [ ] >90% coverage of bench.ts
- [ ] No flaky tests (all subprocess behavior mocked)

#### Test Plan
- **Unit Tests**: All 13 test cases above
- **Manual Testing**: Run full test suite

## Dependency Map
```
Phase 1 (Core) ──→ Phase 2 (Stats/Output) ──→ Phase 3 (Tests)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `consult` subprocess mocking complexity | Medium | Low | Use established patterns from existing tests |
| Host detection platform differences | Low | Low | Best-effort with 'unknown' fallback |

## Validation Checkpoints
1. **After Phase 1**: `afx bench --iterations 1` runs and shows timing output
2. **After Phase 2**: `afx bench --iterations 3` shows stats table and saves to file
3. **After Phase 3**: `npm test` passes with >90% bench.ts coverage

## Notes
- The existing `bench.sh` is the reference implementation — behavior should match closely
- Wall time in parallel mode: measured from `Promise.all` start to resolve (all engines spawned simultaneously)
- No new npm dependencies required
