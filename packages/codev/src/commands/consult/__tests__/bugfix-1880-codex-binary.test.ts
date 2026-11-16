/**
 * #1880 — the codex lane ran a Codex CLI too old for current models, and nothing said so.
 *
 * `consult -m codex --model-id gpt-6-astra` got a provider 400 ("requires a newer version of
 * Codex") because the lane runs the CLI bundled with `@openai/codex-sdk`, which `^0.146.0` pinned
 * to 0.146.x (a caret on 0.x pins the minor). Upgrading the user's own `codex` changed nothing.
 *
 * Pinned here:
 *  - the bundled CLI is at least the oldest version observed serving gpt-6-astra;
 *  - the `[CODEX] binary:` line and the error annotation name the binary and version that ran;
 *  - `consult.codexPath` reaches the SDK as `codexPathOverride`, and a path that does not run
 *    fails loudly, never falling back to the bundled CLI;
 *  - the lane never passes `apiKey` (the SDK would export it as CODEX_API_KEY and move the lane
 *    off the ChatGPT subscription onto metered API billing).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateCodexPath } from '../../../lib/consult-lanes.js';

let mockConstructorArgs: Record<string, unknown> | undefined;
let mockStartThreadArgs: Record<string, unknown> | undefined;
let mockEvents: unknown[] = [];

async function* asGenerator(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

vi.mock('@openai/codex-sdk', () => {
  class MockCodex {
    constructor(options: Record<string, unknown>) {
      mockConstructorArgs = options;
    }
    startThread(options: Record<string, unknown>) {
      mockStartThreadArgs = options;
      return { runStreamed: () => Promise.resolve({ events: asGenerator(mockEvents) }) };
    }
  }
  return { Codex: MockCodex };
});

const { runCodexConsultation, bundledCodexVersion } = await import('../index.js');

const CODEX_OK = [
  { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
];

/** The oldest Codex CLI observed serving gpt-6-astra (the reporter's 0.166.0 CLI, #1880). */
const OLDEST_CODEX_SERVING_GPT_6_ASTRA = '0.166.0';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

let tmpDir: string;
let origHome: string | undefined;
let stderr: string[];

function writeConfig(config: unknown): string {
  mkdirSync(join(tmpDir, '.codev'), { recursive: true });
  const file = join(tmpDir, '.codev', 'config.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/** A stand-in codex binary that answers `--version` like the real CLI. */
function writeFakeCodex(mode: number): string {
  const file = join(tmpDir, 'fake-codex');
  writeFileSync(file, '#!/bin/sh\necho "codex-cli 9.9.9"\n');
  chmodSync(file, mode);
  return file;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bugfix-1880-'));
  // A real ~/.codev/config.json (which may set consult.codexPath) must not leak into assertions.
  origHome = process.env.HOME;
  process.env.HOME = join(tmpDir, 'fake-home');
  mockConstructorArgs = undefined;
  mockStartThreadArgs = undefined;
  mockEvents = CODEX_OK;
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  process.env.HOME = origHome;
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('bundled Codex CLI (#1880)', () => {
  it('is new enough to serve gpt-6-astra', () => {
    expect(compareVersions(bundledCodexVersion(), OLDEST_CODEX_SERVING_GPT_6_ASTRA)).toBeGreaterThanOrEqual(0);
  });

  it('runs by default, and the [CODEX] binary line names its version', async () => {
    await runCodexConsultation('q', 'role', tmpDir);

    expect(mockConstructorArgs?.codexPathOverride).toBeUndefined();
    expect(stderr).toContain(
      `[CODEX] binary: Codex CLI ${bundledCodexVersion()} bundled with codev ` +
      '(set `consult.codexPath` to run your own codex)',
    );
  });

  it('a provider rejection names the binary that ran, even on the shipped default model', async () => {
    mockEvents = [{
      type: 'turn.failed',
      error: { message: "The 'gpt-6-astra' model requires a newer version of Codex." },
    }];

    await expect(runCodexConsultation('q', 'role', tmpDir)).rejects.toThrow(
      `requires a newer version of Codex.\n\nThe codex lane ran Codex CLI ${bundledCodexVersion()} bundled with codev`,
    );
  });
});

describe('consult.codexPath (#1880)', () => {
  it('runs the configured binary and reports its path, version, and config source', async () => {
    const codex = writeFakeCodex(0o755);
    const configFile = writeConfig({ consult: { codexPath: codex } });

    await runCodexConsultation('q', 'role', tmpDir);

    expect(mockConstructorArgs?.codexPathOverride).toBe(codex);
    expect(stderr).toContain(
      `[CODEX] binary: ${codex}, codex-cli 9.9.9 (from \`consult.codexPath\` in ${configFile})`,
    );
  });

  it('a path that does not exist fails loudly and never falls back to the bundled CLI', async () => {
    writeConfig({ consult: { codexPath: join(tmpDir, 'no-such-codex') } });

    await expect(runCodexConsultation('q', 'role', tmpDir))
      .rejects.toThrow(/Cannot run the codex binary .*no-such-codex.*ENOENT[\s\S]*does not fall back/);
    expect(mockConstructorArgs).toBeUndefined();
  });

  it('a path that is not executable fails loudly and never falls back to the bundled CLI', async () => {
    writeConfig({ consult: { codexPath: writeFakeCodex(0o644) } });

    await expect(runCodexConsultation('q', 'role', tmpDir))
      .rejects.toThrow(/Cannot run the codex binary .*fake-codex.*EACCES[\s\S]*does not fall back/);
    expect(mockConstructorArgs).toBeUndefined();
  });

  it('a failed preflight discards a stale review file, like any failed consultation', async () => {
    writeConfig({ consult: { codexPath: join(tmpDir, 'no-such-codex') } });
    const outputPath = join(tmpDir, 'review.md');
    writeFileSync(outputPath, 'VERDICT: APPROVE (from an earlier run)');

    await expect(runCodexConsultation('q', 'role', tmpDir, outputPath)).rejects.toThrow(/ENOENT/);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('must be an absolute path', () => {
    expect(() => validateCodexPath(undefined)).not.toThrow();
    expect(() => validateCodexPath('/opt/homebrew/bin/codex')).not.toThrow();
    expect(() => validateCodexPath('codex')).toThrow(/consult\.codexPath.*absolute path/);
    expect(() => validateCodexPath('./bin/codex')).toThrow(/absolute path/);
    expect(() => validateCodexPath(42)).toThrow(/absolute path/);
  });
});

describe('subscription billing (#1880 owner constraint)', () => {
  it('never passes apiKey to the SDK, bundled or overridden', async () => {
    await runCodexConsultation('q', 'role', tmpDir);
    expect(mockConstructorArgs).not.toHaveProperty('apiKey');
    expect(mockStartThreadArgs).not.toHaveProperty('apiKey');

    writeConfig({ consult: { codexPath: writeFakeCodex(0o755) } });
    await runCodexConsultation('q', 'role', tmpDir);
    expect(mockConstructorArgs).not.toHaveProperty('apiKey');
    expect(mockStartThreadArgs).not.toHaveProperty('apiKey');
  });
});
