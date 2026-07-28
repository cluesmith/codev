#!/usr/bin/env npx tsx
/**
 * CLI runner for the behavioural-impact measurement (Spec 1252, M12 / T14).
 *
 * The logic lives in `../src/lib/prompt-behavior-metrics.ts` so it is
 * unit-testable and can resolve this package's `js-yaml` dependency; this file
 * is a thin entry point only.
 *
 * Usage (from packages/codev):
 *   npx tsx scripts/measure-prompt-behavior.ts <repo-root>
 *   npx tsx scripts/measure-prompt-behavior.ts <repo-root> --json
 *
 * Produces the Phase-1 baseline artifact:
 *   npx tsx scripts/measure-prompt-behavior.ts ../.. \
 *     > ../../codev/resources/1252-behavior-baseline.md
 */
import { runCli } from '../src/lib/prompt-behavior-metrics.js';

process.stdout.write(runCli(process.argv.slice(2), process.cwd()) + '\n');
