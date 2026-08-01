/**
 * Agy lane model passthrough and the fail-fast split (spec 1286, Phase 3).
 *
 * The invariant under test, stated as an invariant because this is the phase with the quiet
 * failure mode: **a skip may only be reached for an ENVIRONMENT cause.**
 *
 *   - unconfigured lane → today's behavior exactly; every failure is a non-blocking COMMENT skip
 *   - configured lane   → a non-zero exit is a HARD failure: no review file, and the error carries
 *                         agy's own output plus the config key and layer
 *   - auth and timeout  → skips in BOTH cases; a degraded agy (#1032/#1033) must never wedge a phase
 *
 * Uses a real fake `agy` subprocess (the `agy-auth-cache.test.ts` pattern) rather than a mock, so
 * argv and exit codes are genuinely exercised — argv order matters here, since agy parses `--print`
 * as string-valued and its value must immediately follow it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _runAgyConsultation, resolveOptionalLaneModelChoice } from '../index.js';

const ENV_KEYS = [
  'CODEV_AGY_BIN',
  'CODEV_AGY_AUTH_CACHE_DIR',
  'CODEV_AGY_AUTH_CACHE_DISABLE',
  'FAKE_AGY_LOG',
  'FAKE_AGY_ARGV_LOG',
  'FAKE_AGY_MODE',
  'HOME',
] as const;

/**
 * Fake agy. Records its own argv so `--model` placement can be asserted, then behaves per
 * FAKE_AGY_MODE: a clean review, a non-zero exit with diagnostic text on stderr, empty output, or
 * the OAuth banner.
 */
const FAKE_AGY_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_AGY_LOG, process.pid + '\\n');
fs.writeFileSync(process.env.FAKE_AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
if (process.argv[2] === '--version') { console.log('1.0.10-fake'); process.exit(0); }
const mode = process.env.FAKE_AGY_MODE || 'ok';
if (mode === 'reject') {
  process.stderr.write('Error: model "bogus-gemini-id" is not available for this account.\\n');
  process.exit(1);
}
if (mode === 'empty') { process.exit(0); }
if (mode === 'unauth') {
  process.stderr.write('Please visit https://accounts.google.com/o/oauth2/auth?client_id=fake\\n');
  setTimeout(() => process.exit(1), 30000);
  return;
}
process.stdout.write('---\\nVERDICT: APPROVE\\nSUMMARY: ok\\nCONFIDENCE: HIGH\\n---\\n');
process.exit(0);
`;

let dir: string;
let savedEnv: Record<string, string | undefined>;
let argvLog: string;

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.join(dir, '.codev'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codev', 'config.json'), JSON.stringify(config));
}

function agyArgv(): string[] {
  return JSON.parse(fs.readFileSync(argvLog, 'utf-8'));
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lane-model-'));
  const fakeAgy = path.join(dir, 'agy');
  fs.writeFileSync(fakeAgy, FAKE_AGY_SOURCE, { mode: 0o755 });
  argvLog = path.join(dir, 'argv.json');

  process.env.CODEV_AGY_BIN = fakeAgy;
  process.env.CODEV_AGY_AUTH_CACHE_DIR = path.join(dir, 'cache');
  process.env.FAKE_AGY_LOG = path.join(dir, 'spawns.log');
  process.env.FAKE_AGY_ARGV_LOG = argvLog;
  process.env.FAKE_AGY_MODE = 'ok';
  // A real ~/.codev/config.json would otherwise leak a gemini model into every assertion.
  process.env.HOME = path.join(dir, 'fake-home');
  fs.writeFileSync(path.join(dir, 'spawns.log'), '');

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- argv passthrough ---------------------------------------------------------------

describe('--model passthrough (zero-config parity)', () => {
  it('omits --model entirely when no model is configured', async () => {
    await _runAgyConsultation('q', 'role', dir);
    expect(agyArgv()).not.toContain('--model');
  });

  it('passes the configured model id', async () => {
    writeConfig({ consult: { models: { gemini: 'gemini-3-pro' } } });
    await _runAgyConsultation('q', 'role', dir);
    const argv = agyArgv();
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('gemini-3-pro');
  });

  it('places --model before --print, whose value must immediately follow it', async () => {
    writeConfig({ consult: { models: { gemini: 'gemini-3-pro' } } });
    await _runAgyConsultation('q', 'role', dir);
    const argv = agyArgv();
    // The bug this guards: --model inserted between --print and its value silently steals the
    // prompt, because agy parses --print as string-valued.
    expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('--print'));
    expect(argv[argv.indexOf('--print') + 1]).not.toBe('--model');
    expect(argv[argv.length - 2]).toBe('--print');
  });
});

// --- the split: unconfigured stays non-blocking --------------------------------------

describe('unconfigured lane keeps every failure non-blocking', () => {
  it('a non-zero exit is a COMMENT skip, not a failure', async () => {
    process.env.FAKE_AGY_MODE = 'reject';
    const outputPath = path.join(dir, 'review.txt');

    await expect(_runAgyConsultation('q', 'role', dir, outputPath)).resolves.toBeUndefined();

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf-8')).toContain('VERDICT: COMMENT');
  });

  it('empty output is a COMMENT skip', async () => {
    process.env.FAKE_AGY_MODE = 'empty';
    const outputPath = path.join(dir, 'review.txt');

    await expect(_runAgyConsultation('q', 'role', dir, outputPath)).resolves.toBeUndefined();

    expect(fs.readFileSync(outputPath, 'utf-8')).toContain('VERDICT: COMMENT');
  });
});

// --- the split: configured hard-fails on a non-zero exit ------------------------------

describe('configured lane hard-fails on a non-zero exit', () => {
  beforeEach(() => {
    writeConfig({ consult: { models: { gemini: 'bogus-gemini-id' } } });
    process.env.FAKE_AGY_MODE = 'reject';
  });

  it('rejects rather than resolving', async () => {
    await expect(_runAgyConsultation('q', 'role', dir)).rejects.toThrow(/agy exited with code 1/);
  });

  it('writes no review file, so porch cannot mistake it for a completed review', async () => {
    const outputPath = path.join(dir, 'review.txt');
    await _runAgyConsultation('q', 'role', dir, outputPath).catch(() => {});
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("carries agy's own output, not merely an exit code", async () => {
    const err = await _runAgyConsultation('q', 'role', dir).catch((e: unknown) => e as Error);
    // The whole point of retaining stderr: an exit code alone leaves the user with a rejected
    // model id and no idea why.
    expect(err.message).toContain('is not available for this account');
  });

  it('names the config key and the layer that supplied the id', async () => {
    const err = await _runAgyConsultation('q', 'role', dir).catch((e: unknown) => e as Error);
    expect(err.message).toContain('consult.models.gemini');
    expect(err.message).toContain(path.join('.codev', 'config.json'));
    expect(err.message).toContain('bogus-gemini-id');
  });

  it('empty output stays a skip even when configured — that is an environment cause', async () => {
    process.env.FAKE_AGY_MODE = 'empty';
    const outputPath = path.join(dir, 'review.txt');

    await expect(_runAgyConsultation('q', 'role', dir, outputPath)).resolves.toBeUndefined();

    expect(fs.readFileSync(outputPath, 'utf-8')).toContain('VERDICT: COMMENT');
  });
});

// --- resolver ------------------------------------------------------------------------

describe('resolveOptionalLaneModelChoice', () => {
  it('returns null when unconfigured, so the flag is omitted rather than defaulted', () => {
    expect(resolveOptionalLaneModelChoice(dir, 'gemini')).toBeNull();
  });

  it('reports the config key and layer when configured', () => {
    writeConfig({ consult: { models: { gemini: 'gemini-3-pro' } } });
    const choice = resolveOptionalLaneModelChoice(dir, 'gemini');
    expect(choice?.id).toBe('gemini-3-pro');
    expect(choice?.key).toBe('consult.models.gemini');
    expect(choice?.source).toContain(path.join('.codev', 'config.json'));
  });

  it('lets --model-id outrank config, closing the phase_2 gap for this lane', () => {
    writeConfig({ consult: { models: { gemini: 'from-config' } } });
    const choice = resolveOptionalLaneModelChoice(dir, 'gemini', 'from-flag');
    expect(choice?.id).toBe('from-flag');
    expect(choice?.fromFlag).toBe(true);
  });

  it('applies the same syntax rule as config', () => {
    expect(() => resolveOptionalLaneModelChoice(dir, 'gemini', 'has spaces')).toThrow(/Invalid model id/);
  });
});
