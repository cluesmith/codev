/**
 * Regression tests for issue #1754.
 *
 * `consult` loads `<workspace>/.env` into `process.env`. A `CLAUDE_CODE_OAUTH_TOKEN` there outranks
 * the keychain login and — via `buildClaudeConsultEnv` (#985) — strips the API key, so the lane runs
 * as whichever org owns that token. When that org was out of usage, the only output was the
 * provider's limit text, with nothing saying the credential came from `.env`.
 *
 * Pinned here: each SDK lane names its credential and its origin on stderr, and a result the SDK
 * flags `is_error` fails the run with no output file instead of passing as a review.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mockClaudeOptions: Record<string, unknown> | undefined;
let mockClaudeMessages: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    mockClaudeOptions = args.options;
    return (async function* () {
      for (const m of mockClaudeMessages) yield m;
    })();
  },
}));

vi.mock('@openai/codex-sdk', () => {
  class MockCodex {
    startThread() {
      return {
        runStreamed: () => Promise.resolve({
          events: (async function* () {
            yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } };
            yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
          })(),
        }),
      };
    }
  }
  return { Codex: MockCodex };
});

let recordedMetrics: Array<Record<string, unknown>> = [];

vi.mock('../metrics.js', () => ({
  MetricsDB: class {
    record(row: Record<string, unknown>) { recordedMetrics.push(row); }
    close() {}
  },
}));

const {
  _loadDotenv,
  runClaudeConsultation,
  runCodexConsultation,
  describeClaudeAuth,
  describeCodexAuth,
} = await import('../index.js');

const CREDENTIAL_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX',
  'CODEX_API_KEY', 'OPENAI_API_KEY',
];

const LIMIT_TEXT = 'You have hit your org monthly usage limit';

let tmpDir: string;
let origHome: string | undefined;
let savedEnv: Record<string, string | undefined>;
let stderr: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bugfix-1754-'));
  origHome = process.env.HOME;
  process.env.HOME = join(tmpDir, 'fake-home');
  // The developer's own shell credentials would otherwise decide every origin assertion.
  savedEnv = Object.fromEntries(CREDENTIAL_KEYS.map((k) => [k, process.env[k]]));
  for (const k of CREDENTIAL_KEYS) delete process.env[k];
  mockClaudeOptions = undefined;
  recordedMetrics = [];
  mockClaudeMessages = [
    { type: 'assistant', message: { content: [{ text: 'LGTM' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'LGTM' },
  ];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ')); });
});

afterEach(() => {
  process.env.HOME = origHome;
  for (const k of CREDENTIAL_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('the claude lane names its credential source (#1754)', () => {
  it('reports an OAuth token injected from .env, and passes it without the .env API key', async () => {
    writeFileSync(join(tmpDir, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=oat-from-dotenv\nANTHROPIC_API_KEY="sk-from-dotenv"\n');
    _loadDotenv(tmpDir);

    await runClaudeConsultation('q', 'role', tmpDir);

    expect(stderr).toContain('[CLAUDE] auth: CLAUDE_CODE_OAUTH_TOKEN (from .env)');
    const env = mockClaudeOptions?.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-from-dotenv');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('reports the winning credential after the #985 strip, per Claude Code precedence', () => {
    const none = new Set<string>();
    expect(describeClaudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, none)).toBe('CLAUDE_CODE_OAUTH_TOKEN (from shell)');
    expect(describeClaudeAuth({ ANTHROPIC_API_KEY: 'k' }, new Set(['ANTHROPIC_API_KEY'])))
      .toBe('ANTHROPIC_API_KEY (from .env)');
    expect(describeClaudeAuth({ ANTHROPIC_AUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'k' }, none))
      .toBe('ANTHROPIC_AUTH_TOKEN (from shell)');
    expect(describeClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k' }, none))
      .toBe('CLAUDE_CODE_USE_BEDROCK (from shell)');
    // Every provider the bundled CLI recognises, resolved in its order.
    expect(describeClaudeAuth({ CLAUDE_CODE_USE_MANTLE: 'true', CLAUDE_CODE_OAUTH_TOKEN: 't' }, none))
      .toBe('CLAUDE_CODE_USE_MANTLE (from shell)');
    expect(describeClaudeAuth({ CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }, none))
      .toBe('CLAUDE_CODE_USE_ANTHROPIC_AWS (from shell)');
    // Claude Code reads "0" as off, so it must not be reported as the provider.
    expect(describeClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: '0' }, none)).toBe('stored claude login (no credential env var)');
    expect(describeClaudeAuth({ PATH: '/usr/bin' }, none)).toBe('stored claude login (no credential env var)');
  });
});

describe('the codex lane names its credential source (#1754)', () => {
  it('reports CODEX_API_KEY injected from .env', async () => {
    writeFileSync(join(tmpDir, '.env'), 'CODEX_API_KEY=sk-codex-from-dotenv\n');
    _loadDotenv(tmpDir);

    await runCodexConsultation('q', 'role', tmpDir);

    expect(stderr).toContain('[CODEX] auth: CODEX_API_KEY (from .env)');
  });

  it('does not report OPENAI_API_KEY, which codex ignores for auth', () => {
    expect(describeCodexAuth({ OPENAI_API_KEY: 'sk' }, new Set(['OPENAI_API_KEY'])))
      .toBe('stored codex login (no CODEX_API_KEY)');
    expect(describeCodexAuth({ CODEX_API_KEY: 'sk' }, new Set())).toBe('CODEX_API_KEY (from shell)');
  });
});

describe('an is_error result fails the claude lane instead of passing as a review (#1754)', () => {
  beforeEach(() => {
    // What the SDK yields when the final assistant message is an API error. Nothing is thrown
    // afterwards: consult must fail on the result itself, not on the SDK's exit-code rethrow.
    mockClaudeMessages = [
      { type: 'assistant', error: 'rate_limit', message: { content: [{ text: LIMIT_TEXT }] } },
      {
        type: 'result', subtype: 'success', is_error: true, result: LIMIT_TEXT,
        total_cost_usd: 0.42, usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800 },
      },
    ];
  });

  it('rejects, names the credential, and writes no output file', async () => {
    writeFileSync(join(tmpDir, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=oat-exhausted-org\n');
    _loadDotenv(tmpDir);
    const outputPath = join(tmpDir, 'review.md');

    const run = runClaudeConsultation('q', 'role', tmpDir, outputPath);

    await expect(run).rejects.toThrow(LIMIT_TEXT);
    await expect(run).rejects.toThrow('Credential in use: CLAUDE_CODE_OAUTH_TOKEN (from .env)');
    expect(existsSync(outputPath)).toBe(false);
  });

  it('records the tokens and cost the failed run spent', async () => {
    const metricsCtx = {
      timestamp: '2026-09-29T00:00:00.000Z', model: 'claude', reviewType: 'pr', subcommand: 'pr',
      protocol: 'bugfix', projectId: 'bugfix-1754', workspacePath: tmpDir,
    };

    await expect(runClaudeConsultation('q', 'role', tmpDir, undefined, metricsCtx)).rejects.toThrow(LIMIT_TEXT);

    expect(recordedMetrics).toHaveLength(1);
    expect(recordedMetrics[0]).toMatchObject({
      exitCode: 1, costUsd: 0.42, inputTokens: 1200, outputTokens: 30, cachedInputTokens: 800,
    });
  });

  it('removes a stale review left by an earlier run of the same iteration', async () => {
    const outputPath = join(tmpDir, 'review.md');
    writeFileSync(outputPath, 'VERDICT: APPROVE (stale)');

    await expect(runClaudeConsultation('q', 'role', tmpDir, outputPath)).rejects.toThrow(LIMIT_TEXT);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('still writes the review when the result is a real success', async () => {
    mockClaudeMessages = [
      { type: 'assistant', message: { content: [{ text: 'VERDICT: APPROVE' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'VERDICT: APPROVE' },
    ];
    const outputPath = join(tmpDir, 'review.md');

    await runClaudeConsultation('q', 'role', tmpDir, outputPath);

    expect(readFileSync(outputPath, 'utf-8')).toBe('VERDICT: APPROVE');
  });
});
