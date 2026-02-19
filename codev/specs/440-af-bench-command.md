# Spec 440: `af bench` — Consultation Benchmarking CLI Command

## Status: stub

This is a stub spec for the builder to flesh out. See GitHub Issue #440 for context.

## Summary

Wrap the existing benchmark shell script (`codev/resources/bench.sh`) into a proper `af bench` CLI subcommand that runs consultation benchmarks, reports timing data, and saves results.

## Key Requirements

- Run `consult -m <engine> --prompt <prompt>` for gemini, codex, claude
- Configurable iterations (`af bench --iterations 5`, default 1)
- Parallel execution by default (all 3 engines at once), `--sequential` flag for serial
- Custom prompt via `--prompt` flag with sensible default
- Clean table output with per-engine timing
- Summary stats (avg/min/max/stddev) across iterations
- Save results to timestamped files
- Auto-detect host info (CPU, RAM, hostname)

## Reference

See `codev/resources/bench.sh` for the existing shell script implementation.
