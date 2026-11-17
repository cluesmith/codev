/**
 * Regression tests for issue #1754.
 *
 * `consult` loads `<workspace>/.env` into `process.env`. A `CLAUDE_CODE_OAUTH_TOKEN` there outranks
 * the keychain login, so the claude lane runs as whichever org owns that token. When that org was
 * out of usage, the only output was the provider's limit text, with nothing saying the credential
 * came from `.env`.
 *
 * Pinned here: each lane names its credential and its origin on stderr, and a result the CLI flags
 * `is_error` fails the run with no output file instead of passing as a review. Since #1912 the
 * claude lane runs the installed `claude` CLI and, by default, withholds `ANTHROPIC_API_KEY` /
 * `ANTHROPIC_AUTH_TOKEN` from it, wherever they came from. The `claude` here is the stub from
 * `helpers/stub-claude.ts`, which records the env it was run with.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStubClaude, readClaudeFixture, type StubClaude, type StubClaudeOptions } from '../../../__tests__/helpers/stub-claude.js';

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
  describeCodexAuth,
} = await import('../index.js');

const CREDENTIAL_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX',
  'CODEX_API_KEY', 'OPENAI_API_KEY',
];

const LIMIT_TEXT = 'You have hit your org monthly usage limit';

/** What `claude auth status --json` reports when `CLAUDE_CODE_OAUTH_TOKEN` is the credential. */
const OAUTH_TOKEN_STATUS = JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' });

/** The env the stub `claude` ran the review with. */
const reviewEnv = () => claude.invocations('print')[0].env;

let claude: StubClaude;
const harnessClaudeBin = process.env.CODEV_CLAUDE_BIN;

function pinClaude(options: StubClaudeOptions = {}): void {
  claude?.cleanup();
  claude = createStubClaude({ authStatus: { stdout: OAUTH_TOKEN_STATUS }, ...options });
  process.env.CODEV_CLAUDE_BIN = claude.bin;
}

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
  recordedMetrics = [];
  pinClaude();
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ')); });
});

afterEach(() => {
  claude.cleanup();
  if (harnessClaudeBin === undefined) delete process.env.CODEV_CLAUDE_BIN;
  else process.env.CODEV_CLAUDE_BIN = harnessClaudeBin;
  process.env.HOME = origHome;
  for (const k of CREDENTIAL_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('the claude lane names its credential source (#1754)', () => {
  it('reports an OAuth token injected from .env, and withholds the .env API key from claude', async () => {
    writeFileSync(join(tmpDir, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=oat-from-dotenv\nANTHROPIC_API_KEY="sk-from-dotenv"\n');
    _loadDotenv(tmpDir);

    await runClaudeConsultation('q', 'role', tmpDir);

    expect(stderr).toContain(
      '[CLAUDE] auth: oauth_token — CLAUDE_CODE_OAUTH_TOKEN (from .env); ignoring ANTHROPIC_API_KEY (from .env)' +
      ' — set consult.claudeAuth to "api-key" to bill the API instead',
    );
    expect(reviewEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-from-dotenv');
    expect(reviewEnv()).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('passes a .env API key, and says so, only when consult.claudeAuth opts into api-key billing', async () => {
    pinClaude({ authStatus: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }) } });
    mkdirSync(join(tmpDir, '.codev'), { recursive: true });
    writeFileSync(join(tmpDir, '.codev', 'config.json'), JSON.stringify({ consult: { claudeAuth: 'api-key' } }));
    writeFileSync(join(tmpDir, '.env'), 'ANTHROPIC_API_KEY=sk-from-dotenv\n');
    _loadDotenv(tmpDir);

    await runClaudeConsultation('q', 'role', tmpDir);

    expect(stderr).toContain(
      `[CLAUDE] auth: api_key (ANTHROPIC_API_KEY) — ANTHROPIC_API_KEY (from .env), consult.claudeAuth="api-key" in ${join(tmpDir, '.codev', 'config.json')}`,
    );
    expect(reviewEnv().ANTHROPIC_API_KEY).toBe('sk-from-dotenv');
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
    // What the CLI prints when the final assistant message is an API error: subtype `success` with
    // `is_error: true`. consult must fail on the result itself, whatever the exit code.
    const events = readClaudeFixture('claude-stream-error-result.jsonl').trim().split('\n').map((l) => JSON.parse(l));
    const stream = events.map((e) => JSON.stringify(e.type !== 'result' ? e : {
      ...e, total_cost_usd: 0.42, usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800 },
    })).join('\n') + '\n';
    pinClaude({ print: { stdout: stream } });
  });

  it('rejects, names the credential, and writes no output file', async () => {
    writeFileSync(join(tmpDir, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=oat-exhausted-org\n');
    _loadDotenv(tmpDir);
    const outputPath = join(tmpDir, 'review.md');

    const err = await runClaudeConsultation('q', 'role', tmpDir, outputPath).catch((e: unknown) => e as Error);

    expect(err.message).toContain(LIMIT_TEXT);
    expect(err.message).toContain('Credential in use: oauth_token — CLAUDE_CODE_OAUTH_TOKEN (from .env)');
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
    pinClaude({
      print: {
        stdout: [
          { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read'] },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: APPROVE' }] } },
          { type: 'result', subtype: 'success', is_error: false, result: 'VERDICT: APPROVE' },
        ].map((e) => JSON.stringify(e)).join('\n') + '\n',
      },
    });
    const outputPath = join(tmpDir, 'review.md');

    await runClaudeConsultation('q', 'role', tmpDir, outputPath);

    expect(readFileSync(outputPath, 'utf-8')).toBe('VERDICT: APPROVE');
  });
});
