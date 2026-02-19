/**
 * Bench command - run consultation benchmarks across engines.
 *
 * Spawns `consult -m <engine> --prompt <prompt>` for gemini, codex, and claude,
 * collects timing data, computes statistics, and saves results.
 */

import { spawn as spawnProcess, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { hostname as osHostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { logger } from '../utils/logger.js';

const ENGINES = ['gemini', 'codex', 'claude'] as const;
type Engine = (typeof ENGINES)[number];

export const DEFAULT_PROMPT =
  'Please analyze the codev codebase and give me a list of potential impactful improvements.';
export const DEFAULT_TIMEOUT = 300;

export interface BenchOptions {
  iterations: number;
  sequential: boolean;
  prompt: string;
  timeout: number;
}

export interface EngineResult {
  engine: Engine;
  elapsed: number | null;
  status: 'ok' | 'failed' | 'timeout';
}

export interface IterationResult {
  iteration: number;
  engines: EngineResult[];
  wallTime: number | null;
}

/** Detect host CPU model. */
export function detectCpu(): string {
  try {
    // macOS
    return execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
  } catch {
    try {
      // Linux
      const out = execSync("lscpu 2>/dev/null | grep 'Model name'", {
        encoding: 'utf8',
        shell: '/bin/sh',
      });
      return out.replace(/.*:\s*/, '').trim();
    } catch {
      return 'unknown';
    }
  }
}

/** Detect host RAM. */
export function detectRam(): string {
  try {
    // macOS
    const bytes = execSync('sysctl -n hw.memsize', { encoding: 'utf8' }).trim();
    return `${Math.round(parseInt(bytes, 10) / 1073741824)} GB`;
  } catch {
    try {
      // Linux
      const out = execSync("free -h 2>/dev/null | awk '/Mem:/{print $2}'", {
        encoding: 'utf8',
        shell: '/bin/sh',
      });
      return out.trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

/** Run a single engine consultation, returning timing result. */
export function runEngine(
  engine: Engine,
  prompt: string,
  timeoutSecs: number,
  outputFile: string,
): Promise<EngineResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawnProcess('consult', ['-m', engine, '--prompt', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const outStream = createWriteStream(outputFile);
    proc.stdout?.pipe(outStream);
    proc.stderr?.pipe(outStream);

    const settle = (result: EngineResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      outStream.end();
      resolve(result);
    };

    proc.on('close', (code) => {
      const elapsed = (performance.now() - start) / 1000;
      if (code === 0) {
        settle({ engine, elapsed, status: 'ok' });
      } else {
        settle({ engine, elapsed: null, status: 'failed' });
      }
    });

    proc.on('error', () => {
      settle({ engine, elapsed: null, status: 'failed' });
    });

    timer = setTimeout(() => {
      proc.kill('SIGTERM');
      // Give it a moment to clean up, then force kill
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 2000);
      settle({ engine, elapsed: null, status: 'timeout' });
    }, timeoutSecs * 1000);
  });
}

/** Run all engines in parallel for one iteration. */
export async function runParallel(
  prompt: string,
  timeoutSecs: number,
  iteration: number,
  timestamp: string,
  resultsDir: string,
): Promise<IterationResult> {
  const wallStart = performance.now();
  const promises = ENGINES.map((engine) => {
    const outputFile = join(resultsDir, `${engine}-run${iteration}-${timestamp}.txt`);
    return runEngine(engine, prompt, timeoutSecs, outputFile);
  });
  const engines = await Promise.all(promises);
  const wallTime = (performance.now() - wallStart) / 1000;
  return { iteration, engines, wallTime };
}

/** Run all engines sequentially for one iteration. */
export async function runSequential(
  prompt: string,
  timeoutSecs: number,
  iteration: number,
  timestamp: string,
  resultsDir: string,
): Promise<IterationResult> {
  const engines: EngineResult[] = [];
  for (const engine of ENGINES) {
    const outputFile = join(resultsDir, `${engine}-run${iteration}-${timestamp}.txt`);
    const result = await runEngine(engine, prompt, timeoutSecs, outputFile);
    engines.push(result);
  }
  return { iteration, engines, wallTime: null };
}

/** Compute summary statistics from an array of numbers. */
export function computeStats(values: number[]): {
  avg: number;
  min: number;
  max: number;
  stddev: number;
} | null {
  if (values.length === 0) return null;

  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  let stddev = 0;
  if (values.length > 1) {
    const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
    stddev = Math.sqrt(variance);
  }

  return { avg, min, max, stddev };
}

/** Format a time value to 1 decimal place with 's' suffix. */
export function formatTime(secs: number): string {
  return `${secs.toFixed(1)}s`;
}

/** Format an engine result for display. */
function formatEngineTime(result: EngineResult): string {
  if (result.status === 'timeout') return 'TIMEOUT';
  if (result.status === 'failed') return 'FAILED';
  return formatTime(result.elapsed!);
}

/** Main bench command. */
export async function bench(options: BenchOptions): Promise<void> {
  const { iterations, sequential, prompt, timeout } = options;

  if (iterations < 1) {
    logger.error('--iterations must be at least 1');
    process.exit(1);
  }

  // Validate consult is available by checking PATH
  try {
    execSync('which consult', { stdio: 'ignore' });
  } catch {
    logger.error("'consult' command not found on PATH");
    process.exit(1);
  }

  const resultsDir = join(process.cwd(), 'codev', 'resources', 'bench-results');
  mkdirSync(resultsDir, { recursive: true });

  const host = osHostname();
  const cpu = detectCpu();
  const ram = detectRam();
  const mode = sequential ? 'sequential' : 'parallel';
  const now = new Date();
  const timestamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  const outFile = join(resultsDir, `bench-${host}-${timestamp}.txt`);
  const lines: string[] = [];

  const log = (line: string) => {
    console.log(line);
    lines.push(line);
  };

  // Header
  log('=== Consultation Benchmark ===');
  logger.kv('Host', host);
  lines.push(`Host: ${host}`);
  logger.kv('CPU', cpu);
  lines.push(`CPU: ${cpu}`);
  logger.kv('RAM', ram);
  lines.push(`RAM: ${ram}`);
  logger.kv('Engines', ENGINES.join(', '));
  lines.push(`Engines: ${ENGINES.join(', ')}`);
  logger.kv('Mode', mode);
  lines.push(`Mode: ${mode}`);
  logger.kv('Iterations', iterations);
  lines.push(`Iterations: ${iterations}`);
  lines.push(`Prompt: ${prompt}`);
  lines.push(`Date: ${now.toISOString()}`);
  logger.blank();
  lines.push('');

  const allResults: IterationResult[] = [];

  for (let i = 1; i <= iterations; i++) {
    const header = `--- Iteration ${i}/${iterations} ---`;
    log(header);

    const result = sequential
      ? await runSequential(prompt, timeout, i, timestamp, resultsDir)
      : await runParallel(prompt, timeout, i, timestamp, resultsDir);

    allResults.push(result);

    // Per-engine results
    const colWidths = [10, 10];
    for (const er of result.engines) {
      logger.row([er.engine, formatEngineTime(er)], colWidths);
      lines.push(`${er.engine}: ${formatEngineTime(er)}`);
    }
    if (result.wallTime !== null) {
      logger.row(['wall', formatTime(result.wallTime)], colWidths);
      lines.push(`wall: ${formatTime(result.wallTime)}`);
    }
    logger.blank();
    lines.push('');
  }

  // Summary stats (only if iterations > 1)
  if (iterations > 1) {
    log('=== Summary ===');
    const summaryColWidths = [10, 10, 10, 10, 10];
    logger.row(['Engine', 'Avg', 'Min', 'Max', 'StdDev'], summaryColWidths);

    for (const engine of ENGINES) {
      const times = allResults
        .map((r) => r.engines.find((e) => e.engine === engine))
        .filter((e): e is EngineResult => e !== undefined && e.status === 'ok')
        .map((e) => e.elapsed!);

      const stats = computeStats(times);
      if (stats) {
        const row = [
          engine,
          formatTime(stats.avg),
          formatTime(stats.min),
          formatTime(stats.max),
          formatTime(stats.stddev),
        ];
        logger.row(row, summaryColWidths);
        lines.push(
          `${engine}: avg=${formatTime(stats.avg)} min=${formatTime(stats.min)} max=${formatTime(stats.max)} stddev=${formatTime(stats.stddev)}`,
        );
      } else {
        logger.row([engine, 'N/A', 'N/A', 'N/A', 'N/A'], summaryColWidths);
        lines.push(`${engine}: no successful runs`);
      }
    }
    logger.blank();
    lines.push('');
  }

  // Save results
  writeFileSync(outFile, lines.join('\n') + '\n');
  logger.blank();
  logger.success(`Results saved to: ${outFile}`);
}
