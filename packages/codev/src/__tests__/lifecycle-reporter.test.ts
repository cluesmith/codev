/**
 * Tests for the Claude lifecycle reporter (Spec 1595).
 *
 * These exercise the EXACT generated artifacts: LIFECYCLE_REPORTER_SCRIPT is
 * written to a temp .cjs and run as a child process with fixture stdin against
 * a local stub Tower, and the generated hook command is run through a real
 * shell. Every request body is checked against Tower's own contract parser, so
 * the reporter and the route cannot drift apart.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LIFECYCLE_REPORTER_SCRIPT,
  LIFECYCLE_REPORTER_SCRIPT_NAME,
  LIFECYCLE_REPORTER_SETTINGS_NAME,
  LIFECYCLE_HOOK_TIMEOUT_SECONDS,
  buildLifecycleHookCommand,
  buildLifecycleReporterSettings,
  ensureLifecycleReporterInstalled,
  resolveLifecycleReporterInjection,
} from '../agent-farm/utils/lifecycle-reporter.js';
import {
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  OPENCODE_HARNESS,
  buildCustomHarnessProvider,
} from '../agent-farm/utils/harness.js';
import { buildWorktreeGuardFiles } from '../agent-farm/utils/worktree-write-guard.js';
import { DEFAULT_TOWER_PORT } from '@cluesmith/codev-sdk/constants';
import { parseLifecycleEvent } from '../agent-farm/servers/agent-state/route.js';

const KEY = 'a'.repeat(64);
const WORKTREE = '/repo/.builders/spir-1595';

let base: string;
let scriptPath: string;
let farmDir: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-reporter-'));
  scriptPath = path.join(base, LIFECYCLE_REPORTER_SCRIPT_NAME);
  fs.writeFileSync(scriptPath, LIFECYCLE_REPORTER_SCRIPT);
  farmDir = path.join(base, 'farm');
  fs.mkdirSync(farmDir);
  fs.writeFileSync(path.join(farmDir, 'local-key'), `${KEY}\n`);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stub Tower
// ---------------------------------------------------------------------------

type StubMode = 'accept' | 'hang' | 'error';

interface Received {
  method: string;
  url: string;
  key: string | undefined;
  body: string;
}

interface Stub {
  port: number;
  received: Received[];
  close: () => Promise<void>;
}

const openStubs: Stub[] = [];

async function startStub(mode: StubMode): Promise<Stub> {
  const received: Received[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', key: req.headers['codev-tower-key'] as string | undefined, body });
      if (mode === 'accept') {
        res.writeHead(204);
        res.end();
      } else if (mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"boom"}');
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const stub: Stub = {
    port: (server.address() as AddressInfo).port,
    received,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
  openStubs.push(stub);
  return stub;
}

/** A port nothing listens on. */
async function refusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  while (openStubs.length > 0) await openStubs.pop()!.close();
});

// ---------------------------------------------------------------------------
// Running the reporter
// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** A clean env: nothing inherited from the test runner's own agent identity. */
function reporterEnv(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: base,
    CODEV_AGENT_FARM_DIR: farmDir,
    CODEV_TOWER_PORT: String(port),
    CODEV_BUILDER_WORKTREE: WORKTREE,
    ...extra,
  };
}

function run(command: string, args: string[], stdin: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
    // A child may exit without reading stdin (the hook wrapper does when the script is missing).
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function runReporter(payload: unknown, env: Record<string, string>): Promise<RunResult> {
  const stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return run(process.execPath, [scriptPath], stdin, env);
}

/** Run the reporter against an accepting stub and return the parsed bodies it posted. */
async function report(payload: unknown, extraEnv: Record<string, string> = {}): Promise<{ result: RunResult; bodies: unknown[]; stub: Stub }> {
  const stub = await startStub('accept');
  const result = await runReporter(payload, reporterEnv(stub.port, extraEnv));
  return { result, bodies: stub.received.map(r => JSON.parse(r.body)), stub };
}

function hook(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: 'sess-1', cwd: WORKTREE, hook_event_name: event, ...fields };
}

// ---------------------------------------------------------------------------
// Translation (Test 5)
// ---------------------------------------------------------------------------

describe('lifecycle reporter translation', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['SessionStart startup', hook('SessionStart', { source: 'startup' }), { event: 'session-started' }],
    ['SessionStart resume', hook('SessionStart', { source: 'resume' }), { event: 'session-started' }],
    ['SessionStart clear', hook('SessionStart', { source: 'clear' }), { event: 'session-started' }],
    ['SessionStart compact', hook('SessionStart', { source: 'compact' }), { event: 'session-started' }],
    ['UserPromptSubmit', hook('UserPromptSubmit', { prompt: 'go' }), { event: 'turn-started' }],
    ['PostToolUse', hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), { event: 'tool-activity' }],
    [
      'PreToolUse question tool',
      hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which approach?' }] } }),
      { event: 'needs-input', needsInput: { kind: 'question', tool: 'AskUserQuestion', summary: 'Which approach?' } },
    ],
    [
      'PermissionRequest Bash',
      hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pnpm test\n  --run' } }),
      { event: 'needs-input', needsInput: { kind: 'permission', tool: 'Bash', summary: 'pnpm test --run' } },
    ],
    [
      'PermissionRequest Write',
      hook('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/repo/x.ts', content: 'secret body' } }),
      { event: 'needs-input', needsInput: { kind: 'permission', tool: 'Write', summary: '/repo/x.ts' } },
    ],
    [
      'PermissionRequest question tool',
      hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ship it?' }] } }),
      { event: 'needs-input', needsInput: { kind: 'question', tool: 'AskUserQuestion', summary: 'Ship it?' } },
    ],
    [
      'PermissionRequest with no primary argument',
      hook('PermissionRequest', { tool_name: 'mcp__srv__do', tool_input: { n: 1 } }),
      { event: 'needs-input', needsInput: { kind: 'permission', tool: 'mcp__srv__do' } },
    ],
    ['Notification permission_prompt', hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }), { event: 'needs-input' }],
    ['Notification elicitation_dialog', hook('Notification', { notification_type: 'elicitation_dialog' }), { event: 'needs-input', needsInput: { kind: 'question' } }],
    ['Notification idle_prompt', hook('Notification', { notification_type: 'idle_prompt' }), { event: 'turn-ended' }],
    ['Stop with background tasks', hook('Stop', { background_tasks: [{ id: 'b1' }] }), { event: 'turn-ended', backgroundWork: true }],
    ['Stop with no background tasks', hook('Stop', { background_tasks: [] }), { event: 'turn-ended', backgroundWork: false }],
    ['Stop without the field', hook('Stop'), { event: 'turn-ended', backgroundWork: false }],
  ];

  it.each(cases)('%s', async (_label, payload, expected) => {
    const { result, bodies, stub } = await report(payload);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body).toEqual({
      agent: { kind: 'builder', worktreePath: WORKTREE },
      sessionId: 'sess-1',
      at: expect.any(Number),
      ...expected,
    });
    expect(parseLifecycleEvent(body)).not.toBeNull();
    expect(stub.received[0].method).toBe('POST');
    expect(stub.received[0].url).toBe('/api/agent-lifecycle');
    expect(stub.received[0].key).toBe(KEY);
  });

  it.each([
    ['PreToolUse for another tool', hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })],
    ['Notification auth_success', hook('Notification', { notification_type: 'auth_success' })],
    ['SessionEnd', hook('SessionEnd', { reason: 'clear' })],
    ['an unknown hook', hook('SubagentStop')],
  ])('%s sends nothing', async (_label, payload) => {
    const { result, bodies } = await report(payload);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(bodies).toHaveLength(0);
  });

  it('stamps the hook time', async () => {
    const before = Date.now();
    const { bodies } = await report(hook('UserPromptSubmit'));
    const at = (bodies[0] as { at: number }).at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('bounds the tool name and the summary, one line, no control characters', async () => {
    const command = `rm -rf \u001b[31mnow\u0007\r\n${'x'.repeat(500)}`;
    const { bodies } = await report(hook('PermissionRequest', { tool_name: `T${'y'.repeat(100)}\u0000`, tool_input: { command } }));
    const detail = (bodies[0] as { needsInput: { tool: string; summary: string } }).needsInput;
    expect(detail.tool).toHaveLength(64);
    expect(detail.summary).toHaveLength(200);
    expect(detail.summary.startsWith('rm -rf [31mnow ')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(detail.summary + detail.tool)).toBe(false);
    expect(parseLifecycleEvent(bodies[0])).not.toBeNull();
  });

  it('treats Unicode line and paragraph separators as line breaks', async () => {
    const { bodies } = await report(hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'one\u2028two \u2029 three' } }));
    expect((bodies[0] as { needsInput: { summary: string } }).needsInput.summary).toBe('one two three');
  });

  it('never splits a surrogate pair at the summary limit', async () => {
    const command = `${'a'.repeat(199)}\u{1F600}tail`;
    const { bodies } = await report(hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command } }));
    expect((bodies[0] as { needsInput: { summary: string } }).needsInput.summary).toBe('a'.repeat(199));
  });

  it('reports an architect by its workspace and name', async () => {
    const { bodies } = await report(hook('Stop'), {
      CODEV_BUILDER_WORKTREE: '',
      CODEV_ARCHITECT_WORKSPACE: '/repo',
      CODEV_ARCHITECT_NAME: 'main',
    });
    expect((bodies[0] as { agent: unknown }).agent).toEqual({ kind: 'architect', workspacePath: '/repo', name: 'main' });
    expect(parseLifecycleEvent(bodies[0])).not.toBeNull();
  });

  it('falls back to the shared default Tower port', () => {
    expect(LIFECYCLE_REPORTER_SCRIPT).toContain(`const DEFAULT_TOWER_PORT = ${DEFAULT_TOWER_PORT};`);
  });

  it('presents CODEV_TOWER_KEY when set, over the key file', async () => {
    const override = 'b'.repeat(64);
    const { stub } = await report(hook('Stop'), { CODEV_TOWER_KEY: override });
    expect(stub.received[0].key).toBe(override);
  });
});

// ---------------------------------------------------------------------------
// Fail-open (Test 5, SC15)
// ---------------------------------------------------------------------------

describe('lifecycle reporter fail-open', () => {
  it.each([
    ['no identity', { CODEV_BUILDER_WORKTREE: '' }],
    ['an architect name without its workspace', { CODEV_BUILDER_WORKTREE: '', CODEV_ARCHITECT_NAME: 'main' }],
    ['no local key', { CODEV_AGENT_FARM_DIR: path.join(os.tmpdir(), 'no-such-farm-dir') }],
  ])('makes no request with %s', async (_label, extra) => {
    const { result, bodies } = await report(hook('Stop'), extra);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(bodies).toHaveLength(0);
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['an empty payload', ''],
    ['a JSON array', '[]'],
    ['no session id', JSON.stringify({ hook_event_name: 'Stop' })],
    ['an over-long session id', JSON.stringify(hook('Stop', { session_id: 's'.repeat(129) }))],
  ])('exits 0 silently on %s', async (_label, raw) => {
    const { result, bodies } = await report(raw);
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(bodies).toHaveLength(0);
  });

  it('exits 0 silently when Tower refuses the connection', async () => {
    const result = await runReporter(hook('Stop'), reporterEnv(await refusedPort()));
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('exits 0 silently when Tower errors', async () => {
    const stub = await startStub('error');
    const result = await runReporter(hook('Stop'), reporterEnv(stub.port));
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(stub.received).toHaveLength(1);
  });

  it('gives up on a hung Tower within its sub-second deadline, without retrying', async () => {
    const stub = await startStub('hang');
    const result = await runReporter(hook('Stop'), reporterEnv(stub.port));
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.elapsedMs).toBeLessThan(LIFECYCLE_HOOK_TIMEOUT_SECONDS * 1000);
    expect(stub.received).toHaveLength(1);
  });

  it('exits on its own when stdin never closes', async () => {
    const result = await new Promise<RunResult>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [scriptPath], { env: reporterEnv(1), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr: '', elapsedMs: Date.now() - started }));
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.elapsedMs).toBeLessThan(LIFECYCLE_HOOK_TIMEOUT_SECONDS * 1000);
  });
});

// ---------------------------------------------------------------------------
// The hook command and settings
// ---------------------------------------------------------------------------

describe('lifecycle hook command', () => {
  it('is silent with exit 0 when the script has been deleted (SC15)', async () => {
    const missing = path.join(base, 'deleted', LIFECYCLE_REPORTER_SCRIPT_NAME);
    const command = buildLifecycleHookCommand(missing);
    for (const shell of ['sh', 'bash']) {
      const result = await run(shell, ['-c', command], JSON.stringify(hook('Stop')), reporterEnv(1));
      expect(result, shell).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
  });

  it('is silent with exit 0 when node is not on PATH', async () => {
    const command = buildLifecycleHookCommand(scriptPath);
    const result = await run('/bin/sh', ['-c', command], JSON.stringify(hook('Stop')), { ...reporterEnv(1), PATH: path.join(base, 'empty-bin') });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('runs the script and reports, through a path with a space and a quote', async () => {
    const dir = path.join(base, "dir with 'quote");
    fs.mkdirSync(dir, { recursive: true });
    const quotedScript = path.join(dir, LIFECYCLE_REPORTER_SCRIPT_NAME);
    fs.writeFileSync(quotedScript, LIFECYCLE_REPORTER_SCRIPT);
    const stub = await startStub('accept');
    const result = await run('sh', ['-c', buildLifecycleHookCommand(quotedScript)], JSON.stringify(hook('UserPromptSubmit')), reporterEnv(stub.port));
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(stub.received).toHaveLength(1);
  });

  it('returns within the hook timeout against a hung listener, printing nothing (SC15)', async () => {
    const stub = await startStub('hang');
    const result = await run('sh', ['-c', buildLifecycleHookCommand(scriptPath)], JSON.stringify(hook('Stop')), reporterEnv(stub.port));
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.elapsedMs).toBeLessThan(LIFECYCLE_HOOK_TIMEOUT_SECONDS * 1000);
  });

  it('wires every translated hook, async with a short timeout, all running the same command', () => {
    const settings = JSON.parse(buildLifecycleReporterSettings(scriptPath));
    const events = Object.keys(settings.hooks).sort();
    expect(events).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(settings.hooks.SessionEnd).toBeUndefined();
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*');
    expect(settings.hooks.Notification[0].matcher).toBeUndefined();
    const commands = new Set<string>();
    for (const event of events) {
      for (const group of settings.hooks[event]) {
        for (const h of group.hooks) {
          expect(h).toEqual({ type: 'command', command: buildLifecycleHookCommand(scriptPath), async: true, timeout: LIFECYCLE_HOOK_TIMEOUT_SECONDS });
          commands.add(h.command);
        }
      }
    }
    expect(commands.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Windows paths under bash (#1658)
// ---------------------------------------------------------------------------

describe('backslash paths', () => {
  const winDir = 'C:\\Users\\a b\\.agent-farm\\hooks';
  const winScript = `${winDir}\\${LIFECYCLE_REPORTER_SCRIPT_NAME}`;
  const winSettings = `${winDir}\\${LIFECYCLE_REPORTER_SETTINGS_NAME}`;

  /** The words bash parses out of `text`. */
  function bashWords(text: string): string[] {
    const out = execFileSync('bash', ['-c', `for w in ${text}; do printf '%s\\n' "$w"; done`], { encoding: 'utf8' });
    return out.split('\n').slice(0, -1);
  }

  it('the hook command carries only forward-slash, single-quoted paths that bash keeps intact', () => {
    const command = buildLifecycleHookCommand(winScript);
    expect(command).not.toContain('\\');
    const quoted = `'C:/Users/a b/.agent-farm/hooks/${LIFECYCLE_REPORTER_SCRIPT_NAME}'`;
    expect(command).toBe(`[ -f ${quoted} ] && node ${quoted} >/dev/null 2>&1; exit 0`);
    expect(bashWords(quoted)).toEqual([`C:/Users/a b/.agent-farm/hooks/${LIFECYCLE_REPORTER_SCRIPT_NAME}`]);
  });

  it('the injection args and fragment carry the forward-slash path, and bash parses the fragment back intact', () => {
    const injection = CLAUDE_HARNESS.buildLifecycleReporterInjection!(winSettings);
    const forward = `C:/Users/a b/.agent-farm/hooks/${LIFECYCLE_REPORTER_SETTINGS_NAME}`;
    expect(injection.args).toEqual(['--settings', forward]);
    expect(injection.scriptFragment).not.toContain('\\');
    expect(bashWords(injection.scriptFragment)).toEqual(['--settings', forward]);
    expect(injection.env).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

describe('ensureLifecycleReporterInstalled', () => {
  function mode(p: string): number {
    return fs.statSync(p).mode & 0o777;
  }

  it('installs both files with modes 0700/0600 regardless of umask, and returns the absolute settings path', () => {
    const dir = path.join(base, 'install-modes', 'hooks');
    const previous = process.umask(0o000);
    let settingsPath: string;
    try {
      settingsPath = ensureLifecycleReporterInstalled(dir);
    } finally {
      process.umask(previous);
    }
    expect(path.isAbsolute(settingsPath)).toBe(true);
    expect(settingsPath).toBe(path.join(dir, LIFECYCLE_REPORTER_SETTINGS_NAME));
    const script = path.join(dir, LIFECYCLE_REPORTER_SCRIPT_NAME);
    expect(mode(dir)).toBe(0o700);
    expect(mode(script)).toBe(0o600);
    expect(mode(settingsPath)).toBe(0o600);
    expect(fs.readFileSync(script, 'utf8')).toBe(LIFECYCLE_REPORTER_SCRIPT);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(buildLifecycleReporterSettings(script));
    expect(fs.readdirSync(dir).sort()).toEqual([LIFECYCLE_REPORTER_SETTINGS_NAME, LIFECYCLE_REPORTER_SCRIPT_NAME].sort());
  });

  it('rewrites only on a content change, and tightens a widened mode', () => {
    const dir = path.join(base, 'install-rewrite');
    const settingsPath = ensureLifecycleReporterInstalled(dir);
    const script = path.join(dir, LIFECYCLE_REPORTER_SCRIPT_NAME);
    const inode = fs.statSync(script).ino;

    fs.chmodSync(script, 0o644);
    ensureLifecycleReporterInstalled(dir);
    expect(fs.statSync(script).ino).toBe(inode);
    expect(mode(script)).toBe(0o600);

    fs.writeFileSync(script, 'tampered');
    ensureLifecycleReporterInstalled(dir);
    expect(fs.statSync(script).ino).not.toBe(inode);
    expect(fs.readFileSync(script, 'utf8')).toBe(LIFECYCLE_REPORTER_SCRIPT);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(buildLifecycleReporterSettings(script));
  });

  it('embeds no secret in either file', () => {
    const dir = path.join(base, 'install-secret');
    const settingsPath = ensureLifecycleReporterInstalled(dir);
    for (const file of [settingsPath, path.join(dir, LIFECYCLE_REPORTER_SCRIPT_NAME)]) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider capability
// ---------------------------------------------------------------------------

describe('buildLifecycleReporterInjection capability', () => {
  it('only Claude implements it', () => {
    expect(CLAUDE_HARNESS.buildLifecycleReporterInjection).toBeTypeOf('function');
    expect(CODEX_HARNESS.buildLifecycleReporterInjection).toBeUndefined();
    expect(OPENCODE_HARNESS.buildLifecycleReporterInjection).toBeUndefined();
    const custom = buildCustomHarnessProvider({ roleArgs: ['--role', '${ROLE_FILE}'], roleScriptFragment: '--role ${ROLE_FILE}' });
    expect(custom.buildLifecycleReporterInjection).toBeUndefined();
  });

  it('resolves for Claude after installing the files', () => {
    const dir = path.join(base, 'resolve-claude');
    const injection = resolveLifecycleReporterInjection(CLAUDE_HARNESS, dir);
    const settingsPath = path.join(dir, LIFECYCLE_REPORTER_SETTINGS_NAME);
    expect(injection).toEqual({ args: ['--settings', settingsPath], scriptFragment: `--settings '${settingsPath}'`, env: {} });
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('is null for a harness without the capability, installing nothing', () => {
    const dir = path.join(base, 'resolve-codex');
    expect(resolveLifecycleReporterInjection(CODEX_HARNESS, dir)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('fails open to null when the files cannot be installed', () => {
    const blocker = path.join(base, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    expect(resolveLifecycleReporterInjection(CLAUDE_HARNESS, path.join(blocker, 'hooks'))).toBeNull();
  });
});

// Constraint 5: the reporter rides on --settings, so the write-guard's
// settings.local.json is exactly what it was before Spec 1595.
describe('write-guard settings unchanged', () => {
  it('is byte-identical', () => {
    const settings = buildWorktreeGuardFiles('/w').find(f => f.relativePath === '.claude/settings.local.json')!;
    expect(settings.content).toBe(
      '{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "Write|Edit|MultiEdit",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "CODEV_WORKTREE_ROOT=\'/w\' node \'/w/.claude/hooks/worktree-write-guard.cjs\'"\n          }\n        ]\n      }\n    ]\n  }\n}\n',
    );
  });
});
