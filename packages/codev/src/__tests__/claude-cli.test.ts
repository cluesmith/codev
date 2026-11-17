/**
 * Tests for `lib/claude-cli.ts` (#1912): everything the claude lane decides before it spawns a
 * review. Which binary, which version, which auth, and what the child's env is.
 *
 * Every `claude` here is the stub from `helpers/stub-claude.ts`. No real CLI runs, no model call.
 * Scenario numbers refer to the spec's Test Scenarios.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CLAUDE_MIN_VERSION,
  ClaudePreflightError,
  assertApiKeyPresent,
  assertClaudeVersion,
  assertLoggedIn,
  buildClaudeChildEnv,
  describeClaudeAuth,
  preflightClaude,
  readClaudeAuthStatus,
  readClaudeVersion,
  resolveClaudeAuthMode,
  resolveClaudeBin,
  CLAUDE_UPDATE_HINT,
  type ClaudeAuthStatus,
} from '../lib/claude-cli.js';
import { readDotenvFile } from '../lib/dotenv.js';
import { loadConfig } from '../lib/config.js';
import {
  createStubClaude,
  STUB_LOGGED_IN_STATUS,
  STUB_LOGGED_OUT_STATUS,
  type StubClaude,
} from './helpers/stub-claude.js';

const SAVED_ENV_KEYS = ['CODEV_CLAUDE_BIN', 'CODEV_ALLOW_REAL_CLAUDE', 'PATH', 'HOME'] as const;

const SESSION_MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_PID: '4242',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
};

let tmpDir: string;
let workspace: string;
let savedEnv: Record<string, string | undefined>;
const stubs: StubClaude[] = [];

function stub(options?: Parameters<typeof createStubClaude>[0]): StubClaude {
  const created = createStubClaude(options);
  stubs.push(created);
  return created;
}

/** A stub pinned via CODEV_CLAUDE_BIN, as the lane sees it in every test below. */
function pinnedStub(options?: Parameters<typeof createStubClaude>[0]): StubClaude {
  const created = stub(options);
  process.env.CODEV_CLAUDE_BIN = created.bin;
  return created;
}

function writeConfig(file: string, body: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

const projectConfig = () => path.join(workspace, '.codev', 'config.json');

/** The env and `.env` provenance consult has after `loadDotenv`: shell first, `.env` fills gaps. */
function consultEnv(shell: Record<string, string>): { processEnv: NodeJS.ProcessEnv; fromDotenv: Set<string> } {
  const processEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...shell };
  const fromDotenv = new Set<string>();
  for (const [key, value] of Object.entries(readDotenvFile(workspace))) {
    if (!(key in processEnv)) {
      processEnv[key] = value;
      fromDotenv.add(key);
    }
  }
  return { processEnv, fromDotenv };
}

/** The error `fn` throws. One call, so a stub-backed assertion starts the stub once. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('expected a throw');
}

function preflightError(fn: () => unknown): ClaudePreflightError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ClaudePreflightError);
    return err as ClaudePreflightError;
  }
  throw new Error('expected preflightClaude to throw');
}

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-test-'));
  workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace);
  process.env.HOME = path.join(tmpDir, 'home');
  fs.mkdirSync(process.env.HOME);
  delete process.env.CODEV_ALLOW_REAL_CLAUDE;
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const created of stubs.splice(0)) created.cleanup();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveClaudeBin', () => {
  it('a CODEV_CLAUDE_BIN pin wins over the claude on PATH', () => {
    const onPath = stub();
    const pinned = pinnedStub();
    process.env.PATH = onPath.dir;
    expect(resolveClaudeBin()).toBe(pinned.bin);
  });

  it('reads the pin from the env it is given, not process.env (doctor passes its .env merge)', () => {
    const fromDotenv = stub();
    delete process.env.CODEV_CLAUDE_BIN;
    expect(resolveClaudeBin({ ...process.env, CODEV_CLAUDE_BIN: fromDotenv.bin })).toBe(fromDotenv.bin);
    expect(process.env.CODEV_CLAUDE_BIN).toBeUndefined();
  });

  it('a pin that does not exist throws naming it, with no PATH retry (scenario 13)', () => {
    const onPath = stub();
    process.env.PATH = onPath.dir;
    const missing = path.join(tmpDir, 'no-such-claude');
    process.env.CODEV_CLAUDE_BIN = missing;
    expect(() => resolveClaudeBin()).toThrow(`CODEV_CLAUDE_BIN=${missing} is not an executable file`);
    expect(() => resolveClaudeBin()).toThrow(/does not fall back to PATH/);
  });

  it('a relative pin is returned as an absolute path, so a spawn from another cwd runs the same file', () => {
    const pinned = stub();
    process.env.CODEV_CLAUDE_BIN = path.relative(process.cwd(), pinned.bin);
    expect(path.isAbsolute(process.env.CODEV_CLAUDE_BIN)).toBe(false);
    expect(resolveClaudeBin()).toBe(pinned.bin);
  });

  it('a pin that is not executable throws (scenario 13)', () => {
    const notExecutable = path.join(tmpDir, 'claude');
    fs.writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
    process.env.CODEV_CLAUDE_BIN = notExecutable;
    expect(() => resolveClaudeBin()).toThrow(/is not an executable file/);
  });

  it('refuses an unpinned lookup under the test runner (scenario 14)', () => {
    process.env.PATH = stub().dir;
    delete process.env.CODEV_CLAUDE_BIN;
    expect(() => resolveClaudeBin()).toThrow(/Refusing to resolve the claude binary under a test runner/);
  });

  it('with the real-claude opt-in, walks PATH, skipping non-executables and directories', () => {
    delete process.env.CODEV_CLAUDE_BIN;
    process.env.CODEV_ALLOW_REAL_CLAUDE = '1';
    const empty = path.join(tmpDir, 'empty');
    const dirNamedClaude = path.join(tmpDir, 'has-dir');
    const notExecutable = path.join(tmpDir, 'has-plain-file');
    fs.mkdirSync(empty);
    fs.mkdirSync(path.join(dirNamedClaude, 'claude'), { recursive: true });
    fs.mkdirSync(notExecutable);
    fs.writeFileSync(path.join(notExecutable, 'claude'), 'not a program', { mode: 0o644 });
    const real = stub();
    process.env.PATH = [empty, '', dirNamedClaude, notExecutable, real.dir].join(path.delimiter);
    expect(resolveClaudeBin()).toBe(path.join(real.dir, 'claude'));
  });

  it('with no claude anywhere, throws the install hint and names the pin', () => {
    delete process.env.CODEV_CLAUDE_BIN;
    process.env.CODEV_ALLOW_REAL_CLAUDE = '1';
    process.env.PATH = path.join(tmpDir, 'nothing-here');
    expect(() => resolveClaudeBin()).toThrow(/curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    expect(() => resolveClaudeBin()).toThrow(/CODEV_CLAUDE_BIN/);
  });

  it('resolution executes nothing', () => {
    const onPath = stub();
    process.env.CODEV_CLAUDE_BIN = onPath.bin;
    resolveClaudeBin();
    delete process.env.CODEV_CLAUDE_BIN;
    process.env.CODEV_ALLOW_REAL_CLAUDE = '1';
    process.env.PATH = onPath.dir;
    resolveClaudeBin();
    expect(onPath.invocations()).toEqual([]);
  });
});

describe('claude version', () => {
  it('parses the leading MAJOR.MINOR.PATCH of `claude --version`', () => {
    expect(readClaudeVersion(stub().bin)).toBe('2.1.326');
  });

  it('fails as unparseable on garbage, quoting it (scenario 15)', () => {
    const garbage = stub({ version: { stdout: 'claude, some version\n' } });
    const { message } = thrown(() => readClaudeVersion(garbage.bin));
    expect(message).toMatch(/Unparseable output from .*--version.*"claude, some version"/);
    expect(message).toMatch(/claude update/);
  });

  it('bounds the quoted excerpt', () => {
    const noisy = stub({ version: { stdout: 'x'.repeat(5000) } });
    const { message } = thrown(() => readClaudeVersion(noisy.bin));
    expect(message).toMatch(/x{200}…"/);
    expect(message.length).toBeLessThan(600);
  });

  it('fails naming the binary and exit code when --version itself fails', () => {
    const broken = stub({ version: { stderr: 'boom', exitCode: 3 } });
    expect(() => readClaudeVersion(broken.bin)).toThrow(`Cannot run \`${broken.bin} --version\` (exit 3: "boom")`);
  });

  it.each([
    ['2.1.326', true],
    [CLAUDE_MIN_VERSION, true],
    ['2.1.140', false],
    ['2.1.100', false],
    ['2.0.999', false],
    ['1.9.999', false],
    ['2.2.0', true],
    ['2.10.0', true],
    ['3.0.0', true],
  ])('version %s meets the 2.1.141 floor: %s', (version, ok) => {
    if (ok) {
      expect(() => assertClaudeVersion(version)).not.toThrow();
    } else {
      expect(() => assertClaudeVersion(version)).toThrow(`claude ${version} is older than 2.1.141`);
      expect(() => assertClaudeVersion(version)).toThrow(CLAUDE_UPDATE_HINT);
    }
  });

  it.each(['2.1', '2.1.x', '', 'v2.1.326', '2.1.326 (Claude Code)'])(
    'rejects the malformed version %j rather than comparing NaN past the floor',
    (version) => {
      expect(() => assertClaudeVersion(version)).toThrow(/Malformed claude version .*MAJOR\.MINOR\.PATCH/);
    },
  );
});

describe('buildClaudeChildEnv', () => {
  const shell = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-metered-key',
    ANTHROPIC_AUTH_TOKEN: 'auth-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-sub-token',
    CLAUDE_CODE_USE_VERTEX: '1',
    ANTHROPIC_BASE_URL: 'https://gateway.example.invalid',
    HTTPS_PROXY: 'http://proxy.example.invalid:3128',
    CLAUDE_EFFORT: 'high',
    ...SESSION_MARKERS,
  };

  it('in login mode, withholds the API credentials and names them (scenarios 4-7)', () => {
    const { env, withheld } = buildClaudeChildEnv(shell, 'login');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(withheld).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  });

  it('passes the OAuth token, provider switches, routing and settings through (scenarios 7, 12)', () => {
    const { env } = buildClaudeChildEnv(shell, 'login');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-sub-token');
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe('1');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.invalid');
    expect(env.HTTPS_PROXY).toBe('http://proxy.example.invalid:3128');
    expect(env.CLAUDE_EFFORT).toBe('high');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('drops every Claude Code session marker, in both modes (scenario 11)', () => {
    for (const mode of ['login', 'api-key'] as const) {
      const { env } = buildClaudeChildEnv({ ...shell, CLAUDE_CODE_SESSION_KIND: 'x' }, mode);
      for (const marker of [...Object.keys(SESSION_MARKERS), 'CLAUDE_CODE_SESSION_KIND']) {
        expect(env[marker], `${marker} in ${mode} mode`).toBeUndefined();
      }
    }
  });

  it('never mutates its input', () => {
    const input = { ...shell };
    const before = structuredClone(input);
    buildClaudeChildEnv(input, 'login');
    buildClaudeChildEnv(input, 'api-key');
    expect(input).toEqual(before);
  });

  it('in api-key mode, passes both keys through and withholds nothing (scenario 8)', () => {
    const { env, withheld } = buildClaudeChildEnv(shell, 'api-key');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-metered-key');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('auth-token');
    expect(withheld).toEqual([]);
  });

  it('drops undefined values, and does not report an empty key as withheld', () => {
    const { env, withheld } = buildClaudeChildEnv({ PATH: '/usr/bin', UNSET: undefined, ANTHROPIC_API_KEY: '' }, 'login');
    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(withheld).toEqual([]);
  });
});

describe('assertApiKeyPresent', () => {
  it('in api-key mode with no key, names both variables, the config key and its file (scenario 9)', () => {
    const fn = () => assertApiKeyPresent({ PATH: '/usr/bin' }, 'api-key', '/repo/.codev/config.json');
    expect(fn).toThrow(/ANTHROPIC_API_KEY/);
    expect(fn).toThrow(/ANTHROPIC_AUTH_TOKEN/);
    expect(fn).toThrow('consult.claudeAuth is "api-key" (set in /repo/.codev/config.json)');
  });

  it('accepts either key in api-key mode', () => {
    expect(() => assertApiKeyPresent({ ANTHROPIC_AUTH_TOKEN: 't' }, 'api-key')).not.toThrow();
    expect(() => assertApiKeyPresent({ ANTHROPIC_API_KEY: 'k' }, 'api-key')).not.toThrow();
  });

  it('requires nothing in login mode', () => {
    expect(() => assertApiKeyPresent({}, 'login')).not.toThrow();
  });
});

describe('readClaudeAuthStatus (scenario 16)', () => {
  it('parses a logged-in status, returning only the fields the lane uses', () => {
    const status = readClaudeAuthStatus(stub().bin, { PATH: process.env.PATH ?? '' });
    expect(status).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
    expect(JSON.stringify(status)).not.toContain(STUB_LOGGED_IN_STATUS.email);
    expect(JSON.stringify(status)).not.toContain(STUB_LOGGED_IN_STATUS.orgName);
  });

  it('runs `auth status --json` with exactly the env it is given', () => {
    const recorder = stub();
    readClaudeAuthStatus(recorder.bin, { PATH: process.env.PATH ?? '', MARKER_FOR_TEST: 'child-env' });
    const [call] = recorder.invocations('authStatus');
    expect(call.argv).toEqual(['auth', 'status', '--json']);
    expect(call.env.MARKER_FOR_TEST).toBe('child-env');
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('treats exit 1 with loggedIn:false as the logged-out answer, not a crash', () => {
    const loggedOut = stub({ authStatus: { stdout: JSON.stringify(STUB_LOGGED_OUT_STATUS), exitCode: 1 } });
    const status = readClaudeAuthStatus(loggedOut.bin, {});
    expect(status).toEqual({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    expect(() => assertLoggedIn(status)).toThrow('claude reports no login (authMethod: none). Run `claude auth login`.');
  });

  it('keeps the apiKeySource the CLI reports for a key', () => {
    const keyed = stub({ authStatus: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }) } });
    expect(readClaudeAuthStatus(keyed.bin, {}).apiKeySource).toBe('ANTHROPIC_API_KEY');
  });

  it.each([
    ['non-JSON output', 'You are logged in.', /not JSON/],
    ['a JSON array', '[]', /not a JSON object/],
    ['a missing loggedIn', JSON.stringify({ authMethod: 'claude.ai' }), /loggedIn is not a boolean/],
    ['a string loggedIn', JSON.stringify({ loggedIn: 'yes', authMethod: 'claude.ai' }), /loggedIn is not a boolean/],
    ['a missing authMethod', JSON.stringify({ loggedIn: true }), /authMethod is not a string/],
    ['a numeric optional field', JSON.stringify({ loggedIn: true, authMethod: 'x', subscriptionType: 5 }), /subscriptionType is not a string/],
  ])('fails as unparseable on %s', (_label, stdout, why) => {
    const odd = stub({ authStatus: { stdout } });
    const { message } = thrown(() => readClaudeAuthStatus(odd.bin, {}));
    expect(message).toMatch(/Unparseable output from .*auth status --json/);
    expect(message).toMatch(why);
  });

  it('treats a null display field as not reported', () => {
    const nulls = stub({ authStatus: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: null }) } });
    expect(readClaudeAuthStatus(nulls.bin, {})).toEqual({ loggedIn: true, authMethod: 'claude.ai' });
  });

  it('fails naming the exit code when the command crashes with no output', () => {
    const crashed = stub({ authStatus: { stderr: 'segfault', exitCode: 2 } });
    expect(() => readClaudeAuthStatus(crashed.bin, {})).toThrow(`Cannot run \`${crashed.bin} auth status --json\` (exit 2: "segfault")`);
  });

  it('fails when the command exits 1 while claiming a login', () => {
    const contradictory = stub({ authStatus: { stdout: JSON.stringify(STUB_LOGGED_IN_STATUS), exitCode: 1 } });
    expect(() => readClaudeAuthStatus(contradictory.bin, {})).toThrow(/Cannot run .*auth status --json.*exit 1/);
  });
});

describe('assertLoggedIn', () => {
  it('names a withheld key and the one-line opt-in, for key-only machines', () => {
    const status: ClaudeAuthStatus = { loggedIn: false, authMethod: 'none' };
    expect(() => assertLoggedIn(status, ['ANTHROPIC_API_KEY'])).toThrow(
      'ANTHROPIC_API_KEY is set but not used: to bill the API with it instead, set consult.claudeAuth to "api-key"',
    );
  });
});

describe('describeClaudeAuth', () => {
  const base = { mode: 'login' as const, modeSource: null, withheld: [], fromDotenv: new Set<string>() };

  it('a stored subscription login', () => {
    expect(describeClaudeAuth({
      ...base, env: {}, status: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
    })).toBe('claude.ai (max) — stored claude login');
  });

  it('an OAuth token from .env (#1754)', () => {
    expect(describeClaudeAuth({
      ...base, env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token-value' }, fromDotenv: new Set(['CLAUDE_CODE_OAUTH_TOKEN']),
      status: { loggedIn: true, authMethod: 'oauth_token' },
    })).toBe('oauth_token — CLAUDE_CODE_OAUTH_TOKEN (from .env)');
  });

  it('api-key mode names the key, its origin and the config file', () => {
    expect(describeClaudeAuth({
      ...base, mode: 'api-key', modeSource: '/repo/.codev/config.json', env: { ANTHROPIC_API_KEY: 'sk-secret' },
      status: { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' },
    })).toBe('api_key (ANTHROPIC_API_KEY) — ANTHROPIC_API_KEY (from shell), consult.claudeAuth="api-key" in /repo/.codev/config.json');
  });

  it('notes each withheld key with its origin and the opt-in', () => {
    const line = describeClaudeAuth({
      ...base, env: {}, withheld: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], fromDotenv: new Set(['ANTHROPIC_API_KEY']),
      status: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
    });
    expect(line).toBe(
      'claude.ai (max) — stored claude login; ignoring ANTHROPIC_API_KEY (from .env), ANTHROPIC_AUTH_TOKEN (from shell)' +
      ' — set consult.claudeAuth to "api-key" to bill the API instead',
    );
  });

  it('with both API credentials set, names the one the CLI uses and the other beside it', () => {
    // The status shape CLI 2.1.326 reports with both set: token auth, while apiKeySource names the key.
    expect(describeClaudeAuth({
      ...base, mode: 'api-key', modeSource: '/repo/.codev/config.json',
      env: { ANTHROPIC_API_KEY: 'sk-key', ANTHROPIC_AUTH_TOKEN: 'bearer' }, fromDotenv: new Set(['ANTHROPIC_API_KEY']),
      status: { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' },
    })).toBe(
      'oauth_token (ANTHROPIC_API_KEY) — ANTHROPIC_AUTH_TOKEN (from shell), with ANTHROPIC_API_KEY (from .env) also set, ' +
      'consult.claudeAuth="api-key" in /repo/.codev/config.json',
    );
  });

  it('names a cloud-provider switch and the provider', () => {
    expect(describeClaudeAuth({
      ...base, env: { CLAUDE_CODE_USE_VERTEX: '1' }, status: { loggedIn: true, authMethod: 'third_party', apiProvider: 'vertex' },
    })).toBe('third_party via vertex — CLAUDE_CODE_USE_VERTEX (from shell)');
  });

  it.each([
    // Every provider switch the CLI recognises, resolved in its order, ahead of any credential.
    [{ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k' }, 'CLAUDE_CODE_USE_BEDROCK (from shell), with ANTHROPIC_API_KEY (from shell) also set'],
    [{ CLAUDE_CODE_USE_MANTLE: 'true', CLAUDE_CODE_OAUTH_TOKEN: 't' }, 'CLAUDE_CODE_USE_MANTLE (from shell), with CLAUDE_CODE_OAUTH_TOKEN (from shell) also set'],
    [{ CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }, 'CLAUDE_CODE_USE_ANTHROPIC_AWS (from shell)'],
    // Claude Code reads "0" as off, so it is not reported as the provider.
    [{ CLAUDE_CODE_USE_BEDROCK: '0' }, 'stored claude login'],
    [{ ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN: 't' }, 'ANTHROPIC_AUTH_TOKEN (from shell), with CLAUDE_CODE_OAUTH_TOKEN (from shell) also set'],
    [{ PATH: '/usr/bin' }, 'stored claude login'],
  ])('names the credential Claude Code uses first: %j (#1754)', (env, credential) => {
    expect(describeClaudeAuth({ ...base, env, status: { loggedIn: true, authMethod: 'x' } })).toBe(`x — ${credential}`);
  });

  it('says plainly when there is no login', () => {
    expect(describeClaudeAuth({ ...base, env: {}, status: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' } }))
      .toBe('none — not logged in');
  });

  it('never carries a credential value', () => {
    const line = describeClaudeAuth({
      ...base, mode: 'api-key', env: { ANTHROPIC_API_KEY: 'sk-secret-value' },
      status: { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' },
    });
    expect(line).not.toContain('sk-secret-value');
  });
});

describe('consult.claudeAuth config', () => {
  it('rejects an unknown value at config load, listing the valid ones (scenario 10)', () => {
    writeConfig(projectConfig(), { consult: { claudeAuth: 'bogus' } });
    expect(() => loadConfig(workspace)).toThrow(/Invalid consult\.claudeAuth in Codev config: got "bogus"/);
    expect(() => loadConfig(workspace)).toThrow(/Valid values: "login", "api-key"/);
  });

  it('rejects a non-string value', () => {
    writeConfig(projectConfig(), { consult: { claudeAuth: true } });
    expect(() => loadConfig(workspace)).toThrow(/Invalid consult\.claudeAuth/);
  });

  it('defaults to login, with no source', () => {
    expect(resolveClaudeAuthMode(workspace)).toEqual({ mode: 'login', source: null });
  });

  it('honours api-key from the project config and names the file', () => {
    writeConfig(projectConfig(), { consult: { claudeAuth: 'api-key' } });
    expect(resolveClaudeAuthMode(workspace)).toEqual({ mode: 'api-key', source: projectConfig() });
  });
});

describe('preflightClaude', () => {
  it('returns the binary, version, child env, status and both report lines', () => {
    const healthy = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({});
    const result = preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    expect(result.bin).toBe(healthy.bin);
    expect(result.version).toBe('2.1.326');
    expect(result.mode).toBe('login');
    expect(result.binaryLine).toBe(`${healthy.bin}, 2.1.326 (from CODEV_CLAUDE_BIN)`);
    expect(result.authLine).toBe('claude.ai (max) — stored claude login');
    expect(result.status.loggedIn).toBe(true);
  });

  it('runs --version and then auth status, nothing else, and never a review', () => {
    const healthy = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({});
    preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    expect(healthy.invocations().map((inv) => inv.mode)).toEqual(['version', 'authStatus']);
  });

  it('never puts the email or org name anywhere in its result', () => {
    pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({});
    const serialized = JSON.stringify(preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(serialized).not.toContain(STUB_LOGGED_IN_STATUS.email);
    expect(serialized).not.toContain(STUB_LOGGED_IN_STATUS.orgName);
  });

  it('withholds a shell key from auth status and says so (scenario 4)', () => {
    const recorder = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({ ANTHROPIC_API_KEY: 'sk-shell' });
    const result = preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    expect(recorder.invocations('authStatus')[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.authLine).toContain('ignoring ANTHROPIC_API_KEY (from shell) — set consult.claudeAuth to "api-key"');
  });

  it('withholds a .env key and says it came from .env (scenario 5)', () => {
    fs.writeFileSync(path.join(workspace, '.env'), 'ANTHROPIC_API_KEY=sk-dotenv\n');
    const recorder = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({});
    const result = preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    expect(recorder.invocations('authStatus')[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.authLine).toContain('ignoring ANTHROPIC_API_KEY (from .env)');
  });

  it('withholds ANTHROPIC_AUTH_TOKEN set in both the shell and .env (scenario 6)', () => {
    fs.writeFileSync(path.join(workspace, '.env'), 'ANTHROPIC_AUTH_TOKEN=from-dotenv\n');
    const recorder = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({ ANTHROPIC_AUTH_TOKEN: 'from-shell' });
    const result = preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    expect(recorder.invocations('authStatus')[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.authLine).toContain('ignoring ANTHROPIC_AUTH_TOKEN (from shell)');
  });

  it('keeps an OAuth token while withholding a key beside it (scenario 7)', () => {
    const recorder = pinnedStub({ authStatus: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }) } });
    fs.writeFileSync(path.join(workspace, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=oauth-from-dotenv\n');
    const { processEnv, fromDotenv } = consultEnv({ ANTHROPIC_API_KEY: 'sk-shell' });
    const result = preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    const childEnv = recorder.invocations('authStatus')[0].env;
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-from-dotenv');
    expect(result.authLine).toBe(
      'oauth_token — CLAUDE_CODE_OAUTH_TOKEN (from .env); ignoring ANTHROPIC_API_KEY (from shell)' +
      ' — set consult.claudeAuth to "api-key" to bill the API instead',
    );
  });

  it('in api-key mode, passes the key and names the config file (scenario 8)', () => {
    writeConfig(projectConfig(), { consult: { claudeAuth: 'api-key' } });
    const recorder = pinnedStub({ authStatus: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }) } });
    const { processEnv, fromDotenv } = consultEnv({ ANTHROPIC_API_KEY: 'sk-ci' });
    const result = preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    expect(recorder.invocations('authStatus')[0].env.ANTHROPIC_API_KEY).toBe('sk-ci');
    expect(result.mode).toBe('api-key');
    expect(result.authLine).toBe(
      `api_key (ANTHROPIC_API_KEY) — ANTHROPIC_API_KEY (from shell), consult.claudeAuth="api-key" in ${projectConfig()}`,
    );
  });

  it('honours api-key from .codev/config.local.json and names that file (scenario 9a)', () => {
    const local = writeConfig(path.join(workspace, '.codev', 'config.local.json'), { consult: { claudeAuth: 'api-key' } });
    pinnedStub({ authStatus: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }) } });
    const { processEnv, fromDotenv } = consultEnv({ ANTHROPIC_API_KEY: 'sk-local' });
    expect(preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }).authLine)
      .toContain(`consult.claudeAuth="api-key" in ${local}`);
  });

  it('honours api-key from the global config and names that file (scenario 9a)', () => {
    const global = writeConfig(path.join(process.env.HOME!, '.codev', 'config.json'), { consult: { claudeAuth: 'api-key' } });
    pinnedStub({ authStatus: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }) } });
    const { processEnv, fromDotenv } = consultEnv({ ANTHROPIC_API_KEY: 'sk-global' });
    expect(preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }).authLine)
      .toContain(`consult.claudeAuth="api-key" in ${global}`);
  });

  it('in api-key mode with no key, fails before auth status and prints no auth line (scenario 9)', () => {
    writeConfig(projectConfig(), { consult: { claudeAuth: 'api-key' } });
    const recorder = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({});
    const err = preflightError(() => preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(err.message).toContain('ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN');
    expect(err.message).toContain(`consult.claudeAuth is "api-key" (set in ${projectConfig()})`);
    expect(err.authLine).toBeUndefined();
    expect(recorder.invocations('authStatus')).toEqual([]);
  });

  it('keeps session markers from the child and leaves its inputs and process.env alone (scenario 11)', () => {
    const recorder = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv(SESSION_MARKERS);
    const inputBefore = structuredClone(processEnv);
    const processEnvBefore = { ...process.env };
    const result = preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    const childEnv = recorder.invocations('authStatus')[0].env;
    for (const marker of Object.keys(SESSION_MARKERS)) {
      expect(childEnv[marker], marker).toBeUndefined();
      expect(result.env[marker], marker).toBeUndefined();
    }
    expect(processEnv).toEqual(inputBefore);
    expect(process.env).toEqual(processEnvBefore);
  });

  it('passes a provider switch and ANTHROPIC_BASE_URL through (scenario 12)', () => {
    const recorder = pinnedStub();
    const { processEnv, fromDotenv } = consultEnv({ CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_BASE_URL: 'https://gw.example.invalid' });
    preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv });
    const childEnv = recorder.invocations('authStatus')[0].env;
    expect(childEnv.CLAUDE_CODE_USE_VERTEX).toBe('1');
    expect(childEnv.ANTHROPIC_BASE_URL).toBe('https://gw.example.invalid');
  });

  it('a missing binary fails with no report lines (scenario 16a)', () => {
    process.env.CODEV_CLAUDE_BIN = path.join(tmpDir, 'missing-claude');
    const { processEnv, fromDotenv } = consultEnv({});
    const err = preflightError(() => preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(err.message).toMatch(/is not an executable file/);
    expect(err.binaryLine).toBeUndefined();
    expect(err.authLine).toBeUndefined();
  });

  it('a version below the floor fails before auth status, with no auth line (scenarios 15, 16a)', () => {
    const old = pinnedStub({ version: { stdout: '2.1.100 (Claude Code)\n' } });
    const { processEnv, fromDotenv } = consultEnv({});
    const err = preflightError(() => preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(err.message).toBe(
      'claude 2.1.100 is older than 2.1.141, the oldest version the claude review lane supports. ' +
      'Update claude: `claude update` for the native install, or ' +
      '`npm install -g @anthropic-ai/claude-code@latest` for an npm install.'
    );
    expect(err.binaryLine).toBe(`${old.bin}, 2.1.100 (from CODEV_CLAUDE_BIN)`);
    expect(err.authLine).toBeUndefined();
    expect(old.invocations('authStatus')).toEqual([]);
  });

  it('an unparseable version fails with no report lines (scenario 15)', () => {
    pinnedStub({ version: { stdout: 'not a version\n' } });
    const { processEnv, fromDotenv } = consultEnv({});
    const err = preflightError(() => preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(err.message).toMatch(/Unparseable output from .*--version/);
    expect(err.binaryLine).toBeUndefined();
    expect(err.authLine).toBeUndefined();
  });

  it('unparseable auth status fails with no auth line (scenario 16)', () => {
    pinnedStub({ authStatus: { stdout: 'Logged in as someone\n' } });
    const { processEnv, fromDotenv } = consultEnv({});
    const err = preflightError(() => preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(err.message).toMatch(/Unparseable output from .*auth status --json/);
    expect(err.authLine).toBeUndefined();
  });

  it('a logged-out CLI fails with `claude auth login`, and its parsed status still yields an auth line (scenario 16)', () => {
    pinnedStub({ authStatus: { stdout: JSON.stringify(STUB_LOGGED_OUT_STATUS), exitCode: 1 } });
    const { processEnv, fromDotenv } = consultEnv({ ANTHROPIC_API_KEY: 'sk-ci-only' });
    const err = preflightError(() => preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(err.message).toContain('Run `claude auth login`.');
    expect(err.message).toContain('set consult.claudeAuth to "api-key"');
    expect(err.authLine).toBe(
      'none — not logged in; ignoring ANTHROPIC_API_KEY (from shell) — set consult.claudeAuth to "api-key" to bill the API instead',
    );
  });

  it('carries the underlying error as its cause', () => {
    pinnedStub({ version: { stdout: '2.1.100\n' } });
    const { processEnv, fromDotenv } = consultEnv({});
    const err = preflightError(() => preflightClaude({ workspaceRoot: workspace, processEnv, fromDotenv }));
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('readDotenvFile', () => {
  it('returns {} when there is no .env', () => {
    expect(readDotenvFile(workspace)).toEqual({});
  });

  it('parses by the loader rules: comments, blanks, quotes, `=` in values, first occurrence wins', () => {
    fs.writeFileSync(path.join(workspace, '.env'), [
      '# a comment',
      '',
      '   ',
      'PLAIN=value',
      '  SPACED  =  padded value  ',
      'DOUBLE="double quoted"',
      "SINGLE='single quoted'",
      'MISMATCHED="half',
      'EQUALS=a=b=c',
      'QUOTED_EQUALS="x=y"',
      'EMPTY=',
      'NO_EQUALS_SIGN',
      '  # indented comment',
      'DUP=first',
      'DUP=second',
      '__proto__=ordinary',
      'CRLF=windows\r',
    ].join('\n'));
    const parsed = readDotenvFile(workspace);
    expect(parsed).toEqual({
      PLAIN: 'value',
      SPACED: 'padded value',
      DOUBLE: 'double quoted',
      SINGLE: 'single quoted',
      MISMATCHED: '"half',
      EQUALS: 'a=b=c',
      QUOTED_EQUALS: 'x=y',
      EMPTY: '',
      DUP: 'first',
      ['__proto__']: 'ordinary',
      CRLF: 'windows',
    });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('does not touch process.env', () => {
    fs.writeFileSync(path.join(workspace, '.env'), 'CLAUDE_CLI_TEST_ONLY_KEY=1\n');
    readDotenvFile(workspace);
    expect(process.env.CLAUDE_CLI_TEST_ONLY_KEY).toBeUndefined();
  });
});
