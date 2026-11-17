/**
 * A stub `claude` executable for unit tests of the claude lane and `codev doctor` (#1912).
 *
 * `createStubClaude()` writes an executable named `claude` into a fresh temp dir. Pin it with
 * `CODEV_CLAUDE_BIN`, or put its `dir` on `PATH`. Each run of it:
 *
 * - picks a mode from its argv: `--version`, `auth …` (auth status), or anything else (a print-mode
 *   review)
 * - appends one record of its argv, env, stdin, cwd and pid to a log that `invocations()` reads,
 *   plus the content and mode of the `--system-prompt-file` it was given, which the lane deletes
 *   once the run ends
 * - optionally runs a shell command in its cwd, standing in for a reviewer that acts on the tree
 * - replays that mode's canned stdout, stderr and exit code, optionally sleeping after writing
 *   output so a test can signal it mid-run
 *
 * The defaults are a healthy CLI: a version above the floor, a logged-in `auth status` and the
 * success stream in `fixtures/claude-stream-success.jsonl`. The stream fixtures were captured from
 * a real `claude` 2.1.326 print-mode run with the lane's argv, then trimmed. The error-shaped
 * variants keep the captured init event and reshape only the result event, following the CLI's
 * result union (`SDKResultSuccess` / `SDKResultError` in the Agent SDK 0.2.105 type declarations).
 *
 * No real `claude` runs and no model is called.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCmdShim } from './npm-cmd-shim.js';

export type StubClaudeMode = 'version' | 'authStatus' | 'print';

export interface StubClaudeReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Seconds to stay alive after writing output, before exiting (for signal tests). */
  sleepSeconds?: number;
  /**
   * A `/bin/sh -c` command run in the stub's cwd before it writes output; its output is discarded.
   * `$STUB_CLAUDE_DIR` is the stub's own dir.
   */
  beforeOutput?: string;
}

export type StubClaudeOptions = Partial<Record<StubClaudeMode, StubClaudeReply>>;

export interface StubClaudeInvocation {
  mode: StubClaudeMode;
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  cwd: string;
  pid: number;
  /** The `--system-prompt-file` as the stub found it, when argv named one. */
  systemPrompt?: { path: string; content: string; mode: number };
}

export interface StubClaude {
  /** Absolute path of the stub executable, named `claude`. */
  bin: string;
  /** The temp dir holding it; put this on `PATH` to exercise the lookup. */
  dir: string;
  /** Every run so far, oldest first. */
  invocations(mode?: StubClaudeMode): StubClaudeInvocation[];
  cleanup(): void;
}

/**
 * The real `auth status --json` shape for a claude.ai login, with placeholder identity values. The
 * identity fields are here so tests can assert they never reach a log line or a returned object.
 */
export const STUB_LOGGED_IN_STATUS = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'stub-reviewer@example.invalid',
  orgId: '00000000-0000-0000-0000-000000000000',
  orgName: 'Stub Org Name Must Never Be Logged',
  subscriptionType: 'max',
};

/** The real logged-out shape. The CLI prints it and exits 1. */
export const STUB_LOGGED_OUT_STATUS = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Read a stream fixture, e.g. `readClaudeFixture('claude-stream-success.jsonl')`. */
export function readClaudeFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

const DEFAULT_REPLIES: Record<StubClaudeMode, StubClaudeReply> = {
  version: { stdout: '2.1.326 (Claude Code)\n' },
  authStatus: { stdout: `${JSON.stringify(STUB_LOGGED_IN_STATUS, null, 2)}\n` },
  print: { stdout: readClaudeFixture('claude-stream-success.jsonl') },
};

// CommonJS, so it runs whatever the package's module type.
const STUB_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const argv = process.argv.slice(2);
const mode = argv[0] === '--version' ? 'version' : argv[0] === 'auth' ? 'authStatus' : 'print';

function readStdin() {
  if (mode !== 'print') return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function readSystemPrompt() {
  const index = argv.indexOf('--system-prompt-file');
  if (index === -1) return undefined;
  const file = argv[index + 1];
  return { path: file, content: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 };
}

readStdin().then((stdin) => {
  const record = {
    mode, argv, env: process.env, stdin, cwd: process.cwd(), pid: process.pid, systemPrompt: readSystemPrompt(),
  };
  fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify(record) + '\\n');
  const reply = config[mode];
  if (reply.beforeOutput) {
    require('child_process').execFileSync('/bin/sh', ['-c', reply.beforeOutput], {
      stdio: 'ignore',
      env: { ...process.env, STUB_CLAUDE_DIR: __dirname },
    });
  }
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exitCode = reply.exitCode === undefined ? 0 : reply.exitCode;
  if (reply.sleepSeconds) setTimeout(() => {}, reply.sleepSeconds * 1000);
});
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createStubClaude(options: StubClaudeOptions = {}): StubClaude {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-claude-'));
  const config: Record<StubClaudeMode, StubClaudeReply> = {
    version: options.version ?? DEFAULT_REPLIES.version,
    authStatus: options.authStatus ?? DEFAULT_REPLIES.authStatus,
    print: options.print ?? DEFAULT_REPLIES.print,
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const script = path.join(dir, 'stub.cjs');
  fs.writeFileSync(script, STUB_SCRIPT);

  // A shell wrapper rather than a node shebang: shebang lines have length limits, and the absolute
  // node path keeps the stub runnable under a PATH that a test has narrowed. Native Windows cannot
  // run either, so there the stub is the `claude.cmd` npm would write for stub.cjs, reached the way
  // a real npm-installed claude is (Spec 1658, M16).
  let bin = path.join(dir, 'claude');
  if (process.platform === 'win32') {
    bin = path.join(dir, 'claude.cmd');
    fs.writeFileSync(bin, npmCmdShim('stub.cjs'));
  } else {
    fs.writeFileSync(bin, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  }

  const log = path.join(dir, 'invocations.jsonl');
  return {
    bin,
    dir,
    invocations(mode?: StubClaudeMode): StubClaudeInvocation[] {
      if (!fs.existsSync(log)) return [];
      const all = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as StubClaudeInvocation);
      return mode ? all.filter((inv) => inv.mode === mode) : all;
    },
    cleanup(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
