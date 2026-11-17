/**
 * The claude consult lane on the installed `claude` CLI (#1912): what `runClaudeConsultation`
 * spawns, what it reads back, and how each way a run can end is reported.
 *
 * Every `claude` here is the stub from `helpers/stub-claude.ts`, pinned via `CODEV_CLAUDE_BIN`. It
 * records its argv, env, stdin, cwd and the system-prompt file it was given, and replays canned
 * stream-json. No real CLI runs and no model is called. Each lane run starts three stub processes
 * (`--version`, `auth status`, the review), so runs are shared between assertions where one run can
 * answer several questions.
 *
 * Scenario numbers refer to the spec's Test Scenarios.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createStubClaude,
  readClaudeFixture,
  STUB_LOGGED_IN_STATUS,
  STUB_LOGGED_OUT_STATUS,
  type StubClaude,
  type StubClaudeInvocation,
  type StubClaudeOptions,
} from '../../../__tests__/helpers/stub-claude.js';

let recordedMetrics: Array<Record<string, unknown>> = [];

vi.mock('../metrics.js', () => ({
  MetricsDB: class {
    record(row: Record<string, unknown>) { recordedMetrics.push(row); }
    close() {}
  },
}));

const {
  runClaudeConsultation,
  buildClaudeReviewArgs,
  describeClaudePermissionDenials,
  resolveLaneModelChoice,
  CLAUDE_CAPABILITY_NOTE,
  CLAUDE_REVIEW_TOOLS,
  DEFAULT_CLAUDE_MODEL,
} = await import('../index.js');

const here = path.dirname(fileURLToPath(import.meta.url));

// --- stream-json events, built from the captured fixture so the shapes stay real ---------------

type StreamEvent = Record<string, unknown>;

const CAPTURED = readClaudeFixture('claude-stream-success.jsonl').trim().split('\n')
  .map((line) => JSON.parse(line) as StreamEvent);
const capturedEvent = (type: string): StreamEvent => {
  const event = CAPTURED.find((e) => e.type === type);
  if (!event) throw new Error(`fixture has no ${type} event`);
  return event;
};
const INIT = capturedEvent('system');
const RATE_LIMIT = capturedEvent('rate_limit_event');
const ASSISTANT = capturedEvent('assistant');
const RESULT_OK = capturedEvent('result');

function assistant(...content: unknown[]): StreamEvent {
  return { ...ASSISTANT, message: { ...(ASSISTANT.message as StreamEvent), content } };
}
const text = (t: string) => ({ type: 'text', text: t });
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** A fixture with its result event replaced by `edit(result)`. */
function withResult(fixture: string, edit: (result: StreamEvent) => StreamEvent): string {
  const events = readClaudeFixture(fixture).trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
  return jsonl(...events.map((e) => (e.type === 'result' ? edit(e) : e)));
}

const METRICS_CTX = {
  timestamp: '2026-11-17T00:00:00.000Z', model: 'claude', reviewType: 'impl', subcommand: 'impl',
  protocol: 'aspir', projectId: '1912', workspacePath: '/workspace',
};

const SESSION_MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_PID: '4242',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
};

const SAVED_ENV_KEYS = [
  'CODEV_CLAUDE_BIN', 'CODEV_ALLOW_REAL_CLAUDE', 'HOME',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX',
  ...Object.keys(SESSION_MARKERS),
];

// --- per-run context ----------------------------------------------------------------------------

interface Ctx {
  tmpDir: string;
  workspace: string;
  savedEnv: Record<string, string | undefined>;
  stubs: StubClaude[];
  stdout: string[];
  stderr: string[];
}

function setUp(): Ctx {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-lane-')));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace);
  const savedEnv = Object.fromEntries(SAVED_ENV_KEYS.map((key) => [key, process.env[key]]));
  // The developer's own shell credentials, session markers and global config would otherwise decide
  // what reaches the child and what the auth line says.
  for (const key of SAVED_ENV_KEYS) delete process.env[key];
  process.env.HOME = path.join(tmpDir, 'home');
  fs.mkdirSync(process.env.HOME);
  recordedMetrics = [];
  const ctx: Ctx = { tmpDir, workspace, savedEnv, stubs: [], stdout: [], stderr: [] };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    ctx.stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { ctx.stderr.push(args.map(String).join(' ')); });
  return ctx;
}

function tearDown(ctx: Ctx): void {
  vi.restoreAllMocks();
  for (const key of SAVED_ENV_KEYS) {
    if (ctx.savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = ctx.savedEnv[key];
  }
  for (const stub of ctx.stubs.splice(0)) stub.cleanup();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

/** Fresh context for every test in the enclosing describe. */
function freshContextPerTest(): () => Ctx {
  let ctx: Ctx;
  beforeEach(() => { ctx = setUp(); });
  afterEach(() => tearDown(ctx));
  return () => ctx;
}

function pinnedStub(ctx: Ctx, options?: StubClaudeOptions): StubClaude {
  const stub = createStubClaude(options);
  ctx.stubs.push(stub);
  process.env.CODEV_CLAUDE_BIN = stub.bin;
  return stub;
}

function writeProjectConfig(ctx: Ctx, body: unknown): string {
  const file = path.join(ctx.workspace, '.codev', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

interface LaneRun {
  error?: Error;
  /** The stub the lane was pointed at; undefined when the test pinned something else or nothing. */
  stub?: StubClaude;
  /** The review invocation (print mode), if the lane got that far. */
  review?: StubClaudeInvocation;
  stdout: string;
  stderr: string[];
  metrics: Array<Record<string, unknown>>;
  outputPath: string;
  listenersBefore: { SIGINT: number; SIGTERM: number };
  listenersAfter: { SIGINT: number; SIGTERM: number };
}

const listenerCounts = () => ({
  SIGINT: process.listenerCount('SIGINT'),
  SIGTERM: process.listenerCount('SIGTERM'),
});

/**
 * One lane run. A stale review file is put at `outputPath` first, so every run also answers "is a
 * stale review removed / overwritten?".
 *
 * The lane runs against the stub the test already pinned, or else a new pinned stub built from
 * `opts.stub`. `noStub` leaves `CODEV_CLAUDE_BIN` as the test set it, for the cases about a
 * missing or unpinned binary.
 */
async function runLane(ctx: Ctx, opts: {
  stub?: StubClaudeOptions;
  noStub?: boolean;
  prompt?: string;
  role?: string;
  choice?: ReturnType<typeof resolveLaneModelChoice>;
} = {}): Promise<LaneRun> {
  const stub = opts.noStub ? undefined : (ctx.stubs.at(-1) ?? pinnedStub(ctx, opts.stub));
  const outputPath = path.join(ctx.tmpDir, 'out', 'review.md');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, 'VERDICT: APPROVE (stale, from an earlier run)');

  const listenersBefore = listenerCounts();
  let error: Error | undefined;
  try {
    await runClaudeConsultation(
      opts.prompt ?? 'Review the change.',
      opts.role ?? '# Consultant role',
      ctx.workspace,
      outputPath,
      METRICS_CTX,
      opts.choice,
    );
  } catch (err) {
    error = err as Error;
  }
  return {
    error,
    stub,
    review: stub?.invocations('print')[0],
    stdout: ctx.stdout.join(''),
    stderr: [...ctx.stderr],
    metrics: [...recordedMetrics],
    outputPath,
    listenersBefore,
    listenersAfter: listenerCounts(),
  };
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const linesStartingWith = (lines: string[], prefix: string) => lines.filter((l) => l.startsWith(prefix));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Scenarios 1, 3, 3a, 3b, 11, 24, 26: one default run ----------------------------------------

describe('a default successful review', () => {
  const PROMPT = `PROMPT-START\n${'x'.repeat(150 * 1024)}\nPROMPT-END`;
  const ROLE = '# Consultant role\n\nReview the tree; never modify it.';
  // Two assistant text blocks, with a tool call, a thinking block and events the lane ignores
  // (rate_limit_event, a user tool result, an event type no CLI has yet) in between.
  const STREAM = jsonl(
    INIT,
    assistant({ type: 'thinking', thinking: 'Let me read the files.', signature: 'sig' }, text('Part one of the review. ')),
    assistant({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/workspace/app.ts' } }),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export {}' }] } },
    RATE_LIMIT,
    { type: 'event_type_from_the_future', payload: 1 },
    assistant(text('---\nVERDICT: APPROVE\nSUMMARY: fine\nCONFIDENCE: HIGH\n---\n')),
    {
      ...RESULT_OK,
      result: 'ignored: the review is the assistant text',
      total_cost_usd: 0.4321,
      usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 300, cache_creation_input_tokens: 5 },
    },
  );
  const EXPECTED_TEXT = 'Part one of the review. ---\nVERDICT: APPROVE\nSUMMARY: fine\nCONFIDENCE: HIGH\n---\n';

  let ctx: Ctx;
  let run: LaneRun;
  let review: StubClaudeInvocation;
  let envBefore: NodeJS.ProcessEnv;
  let envAfter: NodeJS.ProcessEnv;
  let outputAfter: string | null;

  beforeAll(async () => {
    ctx = setUp();
    Object.assign(process.env, SESSION_MARKERS);
    process.env.ANTHROPIC_API_KEY = 'sk-from-the-shell';
    pinnedStub(ctx, { print: { stdout: STREAM } });
    envBefore = { ...process.env };
    run = await runLane(ctx, { prompt: PROMPT, role: ROLE });
    envAfter = { ...process.env };
    outputAfter = fs.existsSync(run.outputPath) ? fs.readFileSync(run.outputPath, 'utf-8') : null;
    if (!run.review) throw new Error(`the review never ran: ${run.error?.message}`);
    review = run.review;
  });

  afterAll(() => tearDown(ctx));

  it('succeeds', () => {
    expect(run.error).toBeUndefined();
  });

  it('runs exactly the documented argv (scenario 1)', () => {
    const systemPromptFile = flagValue(review.argv, '--system-prompt-file');
    const sandboxDir = flagValue(review.argv, '--add-dir');
    expect(review.argv).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', 'Read,Glob,Grep',
      '--permission-mode', 'dontAsk',
      '--allowedTools', 'Read,Glob,Grep',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--max-turns', '200',
      '--max-budget-usd', '25',
      '--model', 'claude-opus-5',
      '--system-prompt-file', systemPromptFile,
      '--add-dir', sandboxDir,
    ]);
    expect(review.argv).toEqual(buildClaudeReviewArgs({ model: DEFAULT_CLAUDE_MODEL, systemPromptFile, sandboxDir }));
    expect(review.argv).not.toContain('--mcp-config');
    expect(review.argv).not.toContain('--dangerously-skip-permissions');
    expect(CLAUDE_REVIEW_TOOLS).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('sends the prompt on stdin, intact at 150 KB, and keeps it and the role off argv (scenario 3)', () => {
    expect(review.stdin).toBe(PROMPT);
    const argv = review.argv.join(' ');
    expect(argv).not.toContain('PROMPT-START');
    expect(argv).not.toContain('never modify it');
    expect(argv.length).toBeLessThan(2000);
  });

  it('runs in the workspace', () => {
    expect(fs.realpathSync(review.cwd)).toBe(ctx.workspace);
  });

  it('delivers the role, unmodified, followed by the capability note (scenario 3a)', () => {
    expect(review.systemPrompt?.content).toBe(`${ROLE}\n\n${CLAUDE_CAPABILITY_NOTE}\n`);
  });

  it('writes the system prompt 0600 in the granted sandbox dir and removes it after (scenario 3b)', () => {
    const file = review.systemPrompt!;
    expect(file.mode).toBe(0o600);
    const sandboxDir = flagValue(review.argv, '--add-dir');
    expect(path.dirname(file.path)).toBe(sandboxDir);
    expect(path.basename(sandboxDir)).toMatch(/^codev-consult-/);
    expect(sandboxDir.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('withholds the shell API key and every session marker from the child, and says so', () => {
    for (const marker of Object.keys(SESSION_MARKERS)) expect(review.env).not.toHaveProperty(marker);
    expect(review.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    const auth = linesStartingWith(run.stderr, '[CLAUDE] auth:');
    expect(auth).toEqual([
      '[CLAUDE] auth: claude.ai (max) — stored claude login; ignoring ANTHROPIC_API_KEY (from shell) — ' +
      'set consult.claudeAuth to "api-key" to bill the API instead',
    ]);
    expect(linesStartingWith(run.stderr, '[CLAUDE] binary:')).toEqual([
      `[CLAUDE] binary: ${run.stub!.bin}, 2.1.326 (from CODEV_CLAUDE_BIN)`,
    ]);
  });

  it('leaves process.env exactly as it found it (scenario 11)', () => {
    expect(envAfter).toEqual(envBefore);
  });

  it('streams the assistant text to stdout and writes the same bytes to --output (scenarios 24, 26)', () => {
    expect(run.stdout).toBe(EXPECTED_TEXT);
    expect(outputAfter).toBe(EXPECTED_TEXT);
  });

  it('records tokens, cost, exit 0, the model id and the duration from the result event (scenario 24)', () => {
    expect(run.metrics).toHaveLength(1);
    expect(run.metrics[0]).toMatchObject({
      modelId: 'claude-opus-5',
      inputTokens: 1200,
      cachedInputTokens: 800,
      outputTokens: 300,
      costUsd: 0.4321,
      exitCode: 0,
      errorMessage: null,
    });
    expect(run.metrics[0].durationSeconds as number).toBeGreaterThan(0);
  });

  it('leaves no SIGINT/SIGTERM listener behind', () => {
    expect(run.listenersAfter).toEqual(run.listenersBefore);
  });

  it('prints no permission-denial warning when nothing was denied', () => {
    expect(linesStartingWith(run.stderr, '[CLAUDE] warning:')).toEqual([]);
  });
});

// --- Permission denials ---------------------------------------------------------------------------

describe('tool calls the CLI denied are named on stderr', () => {
  const ctx = freshContextPerTest();
  const denial = (tool_name: string, tool_input: Record<string, unknown>) =>
    ({ tool_name, tool_use_id: `toolu_${tool_name}`, tool_input });

  it.each([undefined, null, [], 'not a list'])('says nothing for %j', (denials) => {
    expect(describeClaudePermissionDenials(denials)).toBeNull();
  });

  it('names each tool and what it asked for', () => {
    expect(describeClaudePermissionDenials([
      denial('Read', { file_path: '/tmp/codev-consult-x/pr-1.diff' }),
      denial('Glob', { pattern: '**/*.ts', path: '/etc' }),
      denial('Grep', { pattern: 'TODO' }),
      denial('WebFetch', {}),
      { unexpected: true },
    ])).toBe(
      '[CLAUDE] warning: claude denied 5 tool calls (Read "/tmp/codev-consult-x/pr-1.diff", Glob "/etc", ' +
      'Grep "TODO", WebFetch, an unrecognised tool call). The review did not see what those calls asked for.',
    );
  });

  it('lists five and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => denial('Read', { file_path: `/f${i}` }));
    expect(describeClaudePermissionDenials(many)).toMatch(/claude denied 8 tool calls \(.*"\/f4", and 3 more\)/);
  });

  it('warns, and still succeeds, when the review ran with a denied read', async () => {
    const run = await runLane(ctx(), {
      stub: {
        print: {
          stdout: jsonl(INIT, assistant(text('VERDICT: COMMENT')), {
            ...RESULT_OK, permission_denials: [denial('Read', { file_path: '/tmp/codev-consult-x/pr-1.diff' })],
          }),
        },
      },
    });

    expect(run.error).toBeUndefined();
    expect(linesStartingWith(run.stderr, '[CLAUDE] warning:')).toEqual([
      '[CLAUDE] warning: claude denied 1 tool call (Read "/tmp/codev-consult-x/pr-1.diff"). ' +
      'The review did not see what those calls asked for.',
    ]);
    expect(fs.readFileSync(run.outputPath, 'utf-8')).toBe('VERDICT: COMMENT');
  });
});

describe('the capability note', () => {
  it('names the three tools, the missing shell, and every shell command the prompts mention', () => {
    expect(CLAUDE_CAPABILITY_NOTE).toMatch(/Read, Glob and Grep/);
    expect(CLAUDE_CAPABILITY_NOTE).toMatch(/There is no shell/);
    for (const command of ['cat', 'git diff', 'git log', 'git show', 'git status', 'ls', 'grep']) {
      expect(CLAUDE_CAPABILITY_NOTE).toContain(`\`${command}\``);
    }
  });
});

// --- Scenario 2: model selection -----------------------------------------------------------------

describe('model selection reaches the CLI and the metrics row (scenario 2)', () => {
  const ctx = freshContextPerTest();

  it('consult.models.claude', async () => {
    writeProjectConfig(ctx(), { consult: { models: { claude: 'claude-from-config' } } });
    const run = await runLane(ctx());
    expect(flagValue(run.review!.argv, '--model')).toBe('claude-from-config');
    expect(run.metrics[0]).toMatchObject({ modelId: 'claude-from-config', exitCode: 0 });
  });

  it('--model-id outranks consult.models.claude', async () => {
    writeProjectConfig(ctx(), { consult: { models: { claude: 'claude-from-config' } } });
    const choice = resolveLaneModelChoice(ctx().workspace, 'claude', DEFAULT_CLAUDE_MODEL, 'claude-from-flag');
    const run = await runLane(ctx(), { choice });
    expect(flagValue(run.review!.argv, '--model')).toBe('claude-from-flag');
    expect(run.metrics[0]).toMatchObject({ modelId: 'claude-from-flag', exitCode: 0 });
  });
});

// --- Scenarios 9, 13–16a, 23: preflight failures --------------------------------------------------

describe('a preflight failure fails the lane before any review is spawned', () => {
  const ctx = freshContextPerTest();

  interface PreflightCase {
    name: string;
    arrange: (c: Ctx) => void;
    noStub?: boolean;
    message: RegExp[];
    binaryLine: boolean;
    authLine: boolean;
  }

  const cases: PreflightCase[] = [
    {
      name: 'a pinned binary that does not exist (scenario 13)',
      arrange: (c) => { process.env.CODEV_CLAUDE_BIN = path.join(c.tmpDir, 'no-such-claude'); },
      noStub: true,
      message: [/CODEV_CLAUDE_BIN=.*no-such-claude is not an executable file/, /does not fall back to PATH/],
      binaryLine: false,
      authLine: false,
    },
    {
      name: 'an unpinned lookup under the test runner (scenario 14)',
      arrange: () => { delete process.env.CODEV_CLAUDE_BIN; },
      noStub: true,
      message: [/Refusing to resolve the claude binary under a test runner/],
      binaryLine: false,
      authLine: false,
    },
    {
      name: 'a version below the floor (scenario 15)',
      arrange: (c) => { pinnedStub(c, { version: { stdout: '2.1.100 (Claude Code)\n' } }); },
      message: [/claude 2\.1\.100 is older than 2\.1\.141/, /claude update/],
      binaryLine: true,
      authLine: false,
    },
    {
      name: 'unparseable --version output (scenario 15)',
      arrange: (c) => { pinnedStub(c, { version: { stdout: 'claude, some version\n' } }); },
      message: [/Unparseable output from .*--version/],
      binaryLine: false,
      authLine: false,
    },
    {
      name: 'api-key mode with no key set (scenario 9)',
      arrange: (c) => {
        writeProjectConfig(c, { consult: { claudeAuth: 'api-key' } });
        pinnedStub(c);
      },
      message: [/ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN/, /consult\.claudeAuth/],
      binaryLine: true,
      authLine: false,
    },
    {
      name: 'claude reporting no login (scenario 16)',
      arrange: (c) => {
        pinnedStub(c, { authStatus: { stdout: JSON.stringify(STUB_LOGGED_OUT_STATUS), exitCode: 1 } });
      },
      message: [/claude reports no login/, /claude auth login/],
      binaryLine: true,
      authLine: true,
    },
    {
      name: 'auth status output that is not JSON (scenario 16)',
      arrange: (c) => { pinnedStub(c, { authStatus: { stdout: 'Logged in, probably\n' } }); },
      message: [/Unparseable output from .*auth status --json/],
      binaryLine: true,
      authLine: false,
    },
  ];

  it.each(cases)('$name', async ({ arrange, noStub, message, binaryLine, authLine }) => {
    arrange(ctx());
    const run = await runLane(ctx(), { noStub });

    expect(run.error).toBeInstanceOf(Error);
    for (const pattern of message) expect(run.error!.message).toMatch(pattern);
    expect(run.review).toBeUndefined();
    expect(fs.existsSync(run.outputPath)).toBe(false);
    expect(run.metrics).toHaveLength(1);
    expect(run.metrics[0]).toMatchObject({ exitCode: 1, modelId: 'claude-opus-5', inputTokens: null, costUsd: null });
    expect(run.metrics[0].errorMessage).toEqual(expect.stringMatching(message[0]));
    expect(linesStartingWith(run.stderr, '[CLAUDE] binary:')).toHaveLength(binaryLine ? 1 : 0);
    expect(linesStartingWith(run.stderr, '[CLAUDE] auth:')).toHaveLength(authLine ? 1 : 0);
    expect(run.listenersAfter).toEqual(run.listenersBefore);
  });
});

// --- Scenarios 17–23: a review that ends without a review ----------------------------------------

describe('a review run that fails is reported by how it failed', () => {
  const ctx = freshContextPerTest();

  interface ReviewCase {
    name: string;
    print: StubClaudeOptions['print'];
    message: RegExp[];
    usage?: Record<string, number>;
  }

  const cases: ReviewCase[] = [
    {
      name: 'a non-zero exit with no result, quoting stderr (scenario 17)',
      print: { stdout: jsonl(INIT), stderr: 'boom: the CLI fell over\n', exitCode: 1 },
      message: [/claude exited with code 1 before reporting a result/, /claude stderr \(last 2000 chars\):\nboom: the CLI fell over/],
    },
    {
      name: 'exit 0 with no result event (scenario 18)',
      print: { stdout: jsonl(INIT, assistant(text('half a review'))) },
      message: [/claude exited 0 but ended without a result event/],
    },
    {
      name: 'a stdout line that is not JSON, quoted (scenario 19)',
      print: { stdout: `${jsonl(INIT)}this is not json\n${jsonl(RESULT_OK)}` },
      message: [/a line that is not stream-json on stdout: "this is not json"/],
    },
    {
      name: 'an error result, naming the credential in use (scenario 20)',
      print: {
        stdout: withResult('claude-stream-error-result.jsonl', (r) => ({
          ...r, total_cost_usd: 0.42, usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 30 },
        })),
        exitCode: 1,
      },
      message: [
        /Claude returned an error instead of a review: You have hit your org monthly usage limit/,
        /Credential in use: claude\.ai \(max\) — stored claude login/,
      ],
      usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 30, costUsd: 0.42 },
    },
    {
      name: 'error_max_turns, naming the subtype (scenario 21)',
      print: { stdout: readClaudeFixture('claude-stream-error-max-turns.jsonl'), exitCode: 1 },
      message: [/Claude CLI error \(error_max_turns\)/, /used all 200 turns/],
      usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 4, costUsd: 0.03259 },
    },
    {
      name: 'error_max_budget_usd, naming the subtype (scenario 21)',
      print: {
        stdout: withResult('claude-stream-error-max-turns.jsonl', (r) => ({ ...r, subtype: 'error_max_budget_usd' })),
        exitCode: 1,
      },
      message: [/Claude CLI error \(error_max_budget_usd\)/, /\$25 budget cap/],
    },
    {
      name: '"Prompt is too long", as context exhaustion (scenario 22)',
      print: { stdout: readClaudeFixture('claude-stream-prompt-too-long.jsonl'), exitCode: 1 },
      message: [/Claude ran out of context/, /model claude-opus-5/, /#1641/, /does not retry/],
      usage: { inputTokens: 198000, outputTokens: 1500, costUsd: 1.2345 },
    },
    {
      name: 'a non-zero exit after a successful result',
      print: { stdout: readClaudeFixture('claude-stream-success.jsonl'), exitCode: 2 },
      message: [/claude reported a successful review but exited with code 2/],
    },
    {
      name: 'a successful result with no review text',
      print: { stdout: jsonl(INIT, assistant(text('  \n')), RESULT_OK) },
      message: [/claude reported a successful review but wrote no review text, so there is no VERDICT/],
    },
  ];

  it.each(cases)('$name', async ({ print, message, usage }) => {
    const run = await runLane(ctx(), { stub: { print } });

    expect(run.error).toBeInstanceOf(Error);
    for (const pattern of message) expect(run.error!.message).toMatch(pattern);
    // The binary that ran, for the case where an old CLI is the cause (#1880).
    expect(run.error!.message).toContain(`The claude lane ran ${run.stub!.bin}, 2.1.326 (from CODEV_CLAUDE_BIN).`);
    // Scenario 23: no review file, and the stale one is gone.
    expect(fs.existsSync(run.outputPath)).toBe(false);
    expect(fs.existsSync(run.review!.systemPrompt!.path)).toBe(false);
    expect(run.metrics).toHaveLength(1);
    expect(run.metrics[0]).toMatchObject({ exitCode: 1, ...(usage ?? {}) });
    expect(run.metrics[0].errorMessage).toEqual(expect.stringMatching(message[0]));
    expect(run.listenersAfter).toEqual(run.listenersBefore);
  });

  it('bounds the stderr tail it quotes', async () => {
    const run = await runLane(ctx(), { stub: { print: { stderr: `${'x'.repeat(10_000)}THE-END`, exitCode: 1 } } });
    expect(run.error!.message).toMatch(/THE-END/);
    expect(run.error!.message).not.toMatch(/x{2001}/);
  });

  it('names the binary it could not start', async () => {
    // The auth-status run deletes the stub, so the review spawn finds nothing to execute.
    const stub = pinnedStub(ctx(), {
      authStatus: { stdout: JSON.stringify(STUB_LOGGED_IN_STATUS), beforeOutput: 'rm -f "$STUB_CLAUDE_DIR/claude"' },
    });

    const run = await runLane(ctx());

    expect(run.error!.message).toContain(`Cannot start ${stub.bin}: spawn ${stub.bin} ENOENT.`);
    expect(fs.existsSync(run.outputPath)).toBe(false);
    expect(run.metrics[0]).toMatchObject({ exitCode: 1 });
  });

  it('succeeds with null token columns when the result carries no usage (scenario 25)', async () => {
    const { usage: _usage, total_cost_usd: _cost, ...noUsage } = RESULT_OK;
    const run = await runLane(ctx(), { stub: { print: { stdout: jsonl(INIT, assistant(text('VERDICT: COMMENT')), noUsage) } } });

    expect(run.error).toBeUndefined();
    expect(fs.readFileSync(run.outputPath, 'utf-8')).toBe('VERDICT: COMMENT');
    expect(run.metrics[0]).toMatchObject({
      exitCode: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null,
    });
  });
});

// --- The init guard and the abort path ------------------------------------------------------------

describe('a protocol failure mid-stream stops the review child before the lane fails', () => {
  const ctx = freshContextPerTest();

  // Each stub sleeps after writing its output, so only the lane can end it before the test times out.
  it.each([
    {
      name: 'an init event listing write and shell tools',
      stdout: jsonl({ ...INIT, tools: ['Read', 'Edit', 'Bash'] }, assistant(text('I can edit now'))),
      message: /claude did not honour --tools; refusing a review with write or shell tools.*Edit/,
    },
    {
      name: 'an init event with no tools list',
      stdout: jsonl({ ...INIT, tools: undefined }),
      message: /claude did not honour --tools/,
    },
    {
      name: 'an init event missing one review tool',
      stdout: jsonl({ ...INIT, tools: ['Glob', 'Read'] }, assistant(text('I cannot grep'))),
      message: /claude did not honour --tools; refusing a review without Grep\. .*expected exactly Read, Glob, Grep/,
    },
    {
      name: 'an init event with an empty tools list',
      stdout: jsonl({ ...INIT, tools: [] }),
      message: /claude did not honour --tools; refusing a review without Read, Glob, Grep\./,
    },
    {
      name: 'an init event repeating a tool in place of another',
      stdout: jsonl({ ...INIT, tools: ['Read', 'Read', 'Glob'] }),
      message: /claude did not honour --tools; refusing a review without Grep\./,
    },
    {
      name: 'an init event repeating a tool on top of all three',
      stdout: jsonl({ ...INIT, tools: ['Glob', 'Grep', 'Read', 'Read'] }),
      message: /claude did not honour --tools; refusing a review without each tool exactly once\./,
    },
    {
      name: 'an assistant event before any init event',
      stdout: jsonl(assistant(text('no init first'))),
      message: /assistant event arrived before the init event/,
    },
    {
      name: 'a malformed line',
      stdout: `${jsonl(INIT)}{"type":"assistant",\n`,
      message: /not stream-json/,
    },
    {
      name: 'a JSON line that is not an event',
      stdout: `${jsonl(INIT)}[1, 2, 3]\n`,
      message: /a JSON line that is not a stream-json event/,
    },
  ])('$name', async ({ stdout, message }) => {
    const run = await runLane(ctx(), { stub: { print: { stdout, sleepSeconds: 60 } } });

    expect(run.error!.message).toMatch(message);
    expect(isAlive(run.review!.pid)).toBe(false);
    expect(run.stdout).toBe('');
    expect(fs.existsSync(run.outputPath)).toBe(false);
    expect(run.metrics[0]).toMatchObject({ exitCode: 1 });
  });
});

// --- Scenario 23a: a signal mid-review ------------------------------------------------------------

describe('SIGTERM while the review runs (scenario 23a)', () => {
  const ctx = freshContextPerTest();
  const require_ = createRequire(import.meta.url);
  const TSX_CLI = require_.resolve('tsx/cli');
  const INDEX_SRC = path.resolve(here, '../index.ts');

  /** Poll `check` until it is true, or fail after `timeoutMs`. */
  async function waitFor(check: () => boolean, what: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('terminates the child, removes the temp file and the stale review, and exits non-zero', async () => {
    // Consult runs in its own process, from source via tsx, so the signal never reaches the vitest
    // worker and the test cannot pass against a stale build.
    const stub = pinnedStub(ctx(), { print: { stdout: jsonl(INIT), sleepSeconds: 120 } });
    const outputPath = path.join(ctx().tmpDir, 'review.md');
    fs.writeFileSync(outputPath, 'VERDICT: APPROVE (stale)');
    const driver = path.join(ctx().tmpDir, 'driver.mts');
    fs.writeFileSync(driver, [
      `import { runClaudeConsultation } from ${JSON.stringify(INDEX_SRC)};`,
      `await runClaudeConsultation('Review the change.', '# Consultant role', ${JSON.stringify(ctx().workspace)}, ${JSON.stringify(outputPath)});`,
    ].join('\n'));

    const consult = spawn(process.execPath, [TSX_CLI, driver], {
      cwd: ctx().workspace,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let consultStderr = '';
    consult.stderr!.on('data', (chunk: Buffer) => { consultStderr += chunk.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      consult.on('close', (code, signal) => resolve({ code, signal }));
    });

    try {
      await waitFor(() => stub.invocations('print').length === 1, 'the review to start', 45_000);
      const review = stub.invocations('print')[0];
      expect(isAlive(review.pid)).toBe(true);

      consult.kill('SIGTERM');
      const { code } = await exited;

      expect(code, consultStderr).toBe(143);
      // consult waited for the child's exit before its own, so this is not a race.
      expect(isAlive(review.pid)).toBe(false);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.existsSync(review.systemPrompt!.path)).toBe(false);
      expect(consultStderr).toContain('[CLAUDE] SIGTERM received: stopping the review');
      fs.rmSync(flagValue(review.argv, '--add-dir'), { recursive: true, force: true });
    } finally {
      consult.kill('SIGKILL');
    }
  }, 60_000);
});
