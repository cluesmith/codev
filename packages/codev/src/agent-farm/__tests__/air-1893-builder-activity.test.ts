/**
 * Builder activity for `afx status --activity` (#1893): transcript summary, the
 * "unknown" paths (a builder on codex/agy has no pinned Claude transcript), the
 * test/review process classifier, and the bounded process-table read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  summarizeTranscript,
  readSessionActivity,
  classifyProcess,
  processesUnder,
  readCensus,
  gatherBuilderActivity,
  LAST_TURN_COUNT,
} from '../lib/builder-activity.js';
import { encodeClaudeProjectDir } from '../utils/claude-session-discovery.js';
import type { Builder } from '../types.js';

const SESSION_ID = '024b0a52-e4f4-493c-bfae-bd1898f657e5';

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, ...extra });

describe('summarizeTranscript', () => {
  it('renders one line per user, assistant and tool-call message, oldest first', () => {
    const text = [
      user('Implement the feature'),
      assistant([{ type: 'thinking', thinking: 'hmm' }]),
      assistant([{ type: 'text', text: 'Reading the code first.' }]),
      assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'Run tests' } }]),
      user([{ type: 'tool_result', content: 'ok' }]),
    ].join('\n');
    expect(summarizeTranscript(text, false)).toEqual({
      lastTurns: ['user: Implement the feature', 'assistant: Reading the code first.', 'tool: Bash(pnpm test)'],
      apiError: false,
    });
  });

  it(`keeps only the last ${LAST_TURN_COUNT} lines, flattened and truncated`, () => {
    const lines = ['one', 'two', 'three', `four\n${'x'.repeat(200)}`].map((t) => assistant([{ type: 'text', text: t }]));
    const { lastTurns } = summarizeTranscript(lines.join('\n'), false);
    expect(lastTurns).toHaveLength(LAST_TURN_COUNT);
    expect(lastTurns![0]).toBe('assistant: two');
    expect(lastTurns![2].startsWith('assistant: four xxx')).toBe(true);
    expect(lastTurns![2]).toHaveLength(100);
    expect(lastTurns![2].endsWith('…')).toBe(true);
  });

  it('flags an API error only when the LAST assistant message is one', () => {
    const error = assistant([{ type: 'text', text: 'API Error: rate limited' }], { isApiErrorMessage: true, error: 'rate_limit' });
    expect(summarizeTranscript([user('go'), error].join('\n'), false).apiError).toBe(true);
    const recovered = [user('go'), error, assistant([{ type: 'text', text: 'Back on track.' }])].join('\n');
    expect(summarizeTranscript(recovered, false).apiError).toBe(false);
  });

  it('reports apiError unknown (null) when there is no assistant message', () => {
    expect(summarizeTranscript(user('hello'), false)).toEqual({ lastTurns: ['user: hello'], apiError: null });
  });

  it('skips sidechain, meta, non-message and malformed lines, and a partial first line', () => {
    const text = [
      '"half a line from a tail read"}',
      user('subagent prompt', { isSidechain: true }),
      user('Caveat: local command output', { isMeta: true }),
      JSON.stringify({ type: 'attachment', attachment: {} }),
      '{not json',
      assistant([{ type: 'text', text: 'done' }]),
    ].join('\n');
    expect(summarizeTranscript(text, true)).toEqual({ lastTurns: ['assistant: done'], apiError: false });
  });
});

describe('readSessionActivity', () => {
  let home: string;
  let worktree: string;

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'air-1893-'));
    home = path.join(root, 'home');
    worktree = path.join(root, '.builders', 'air-7');
    fs.mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(worktree)), { recursive: true, force: true });
  });

  function writeTranscript(lines: string[]): string {
    const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(worktree));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  it('reads the pinned session transcript: write time, last turns, API-error flag', () => {
    fs.writeFileSync(path.join(worktree, '.builder-session-id'), `${SESSION_ID}\n`);
    const file = writeTranscript([user('start'), assistant([{ type: 'text', text: 'working' }])]);
    const writtenAt = new Date('2026-11-20T10:00:00Z');
    fs.utimesSync(file, writtenAt, writtenAt);

    expect(readSessionActivity(worktree, { homeDir: home })).toEqual({
      sessionWrittenAt: writtenAt.toISOString(),
      lastTurns: ['user: start', 'assistant: working'],
      apiError: false,
    });
  });

  it('reads only the tail of a large transcript', () => {
    fs.writeFileSync(path.join(worktree, '.builder-session-id'), SESSION_ID);
    const filler = Array.from({ length: 4000 }, (_, i) => user(`filler ${i} ${'y'.repeat(100)}`));
    writeTranscript([...filler, assistant([{ type: 'text', text: 'latest' }])]);

    const { lastTurns } = readSessionActivity(worktree, { homeDir: home });
    expect(lastTurns![lastTurns!.length - 1]).toBe('assistant: latest');
  });

  const UNKNOWN = { sessionWrittenAt: null, lastTurns: null, apiError: null };

  it('is unknown for a builder with no pinned session (codex / agy harness)', () => {
    writeTranscript([user('another session in this dir')]);
    expect(readSessionActivity(worktree, { homeDir: home })).toEqual(UNKNOWN);
  });

  it('is unknown when the pinned transcript does not exist', () => {
    fs.writeFileSync(path.join(worktree, '.builder-session-id'), SESSION_ID);
    expect(readSessionActivity(worktree, { homeDir: home })).toEqual(UNKNOWN);
  });

  it('is unknown when the worktree is gone', () => {
    expect(readSessionActivity(path.join(worktree, 'missing'), { homeDir: home })).toEqual(UNKNOWN);
  });

  it('rejects a session id that is not a plain id (no path traversal)', () => {
    fs.writeFileSync(path.join(worktree, '.builder-session-id'), '../../etc/passwd');
    expect(readSessionActivity(worktree, { homeDir: home })).toEqual(UNKNOWN);
  });
});

describe('classifyProcess', () => {
  it.each([
    ['node /w/node_modules/vitest/vitest.mjs run src/x.test.ts', { kind: 'test', command: 'vitest run src/x.test.ts' }],
    ['/opt/homebrew/bin/node /opt/homebrew/bin/pnpm test', { kind: 'test', command: 'pnpm test' }],
    ['pnpm --filter @cluesmith/codev test', { kind: 'test', command: 'pnpm --filter @cluesmith/codev test' }],
    ['npm run test:e2e', { kind: 'test', command: 'npm run test:e2e' }],
    ['python3 -m pytest -q', { kind: 'test', command: 'pytest -q' }],
    ['go test ./...', { kind: 'test', command: 'go test ./...' }],
    ['node /opt/homebrew/bin/consult -m codex --type impl-review', { kind: 'review', command: 'consult -m codex --type impl-review' }],
    ['"C:\\Program Files\\nodejs\\node.exe" C:\\w\\node_modules\\vitest\\vitest.mjs run', { kind: 'test', command: 'vitest run' }],
  ])('classifies %s', (cmdline, expected) => {
    expect(classifyProcess(cmdline)).toEqual(expected);
  });

  it.each([
    'claude --model opus --append-system-prompt run consult and vitest when done',
    'codex consult the reviewers then run pnpm test',
    '/bin/zsh -c source snapshot.sh && eval pnpm test',
    'node /w/mcp-server.js',
    'pnpm install',
  ])('does not classify %s', (cmdline) => {
    expect(classifyProcess(cmdline)).toBeNull();
  });
});

describe('processesUnder', () => {
  const census = [
    { pid: 10, ppid: 1, rssKb: 0, cmdline: 'node shellper-main.js' },
    { pid: 11, ppid: 10, rssKb: 0, cmdline: 'claude --model opus consult vitest' },
    { pid: 12, ppid: 11, rssKb: 0, cmdline: '/bin/zsh -c pnpm test' },
    { pid: 13, ppid: 12, rssKb: 0, cmdline: 'node /x/pnpm.cjs test' },
    { pid: 14, ppid: 13, rssKb: 0, cmdline: 'node /x/vitest.mjs run' },
    { pid: 15, ppid: 11, rssKb: 0, cmdline: 'node /bin/consult -m gemini' },
    { pid: 20, ppid: 1, rssKb: 0, cmdline: 'node /other/vitest.mjs run' },
  ];

  it("lists the topmost test/review process of each branch under the builder's shellper", () => {
    expect(processesUnder(census, 10)).toEqual([
      { pid: 15, kind: 'review', command: 'consult -m gemini' },
      { pid: 13, kind: 'test', command: 'pnpm test' },
    ]);
  });

  it('is empty when the shellper is no longer running', () => {
    expect(processesUnder(census, 99)).toEqual([]);
  });
});

describe('readCensus', () => {
  it('gives up (null) when the process table takes longer than the bound', async () => {
    vi.useFakeTimers();
    try {
      const pending = readCensus(50, () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is null when the read fails or returns nothing', async () => {
    await expect(readCensus(1000, () => Promise.reject(new Error('no ps')))).resolves.toBeNull();
    await expect(readCensus(1000, async () => [])).resolves.toBeNull();
  });
});

describe('gatherBuilderActivity', () => {
  const builder = (id: string, worktree: string) => ({ id, worktree } as Builder);

  it('reports processes unknown when the census is unreadable, and per builder when it is', async () => {
    const census = [
      { pid: 10, ppid: 1, rssKb: 0, cmdline: 'node shellper-main.js' },
      { pid: 11, ppid: 10, rssKb: 0, cmdline: 'pnpm test' },
    ];
    const builders = [builder('builder-air-1', '/nope/a'), builder('builder-air-2', '/nope/b')];
    const shellperPids = () => new Map([['builder-air-1', 10]]);

    const read = await gatherBuilderActivity('/ws', builders, { readCensus: async () => census, shellperPids });
    expect(read.get('builder-air-1')!.processes).toEqual([{ pid: 11, kind: 'test', command: 'pnpm test' }]);
    expect(read.get('builder-air-2')!.processes).toBeNull(); // no terminal session row
    expect(read.get('builder-air-2')!.lastTurns).toBeNull();

    const unread = await gatherBuilderActivity('/ws', builders, { readCensus: async () => null, shellperPids });
    expect(unread.get('builder-air-1')!.processes).toBeNull();
  });
});
