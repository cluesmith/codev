/**
 * Builder activity for `afx status --activity` (#1893): what a builder's agent
 * last did, read from its session transcript, and which test or review
 * processes are running under its terminal. Everything here is read-only.
 *
 * Every field degrades to `null` ("unknown") on its own: a builder on a harness
 * whose transcript we cannot locate (codex, agy, an unpinned session), an
 * unreadable file, or a process table that cannot be read in time never fails
 * the command or blanks the other fields.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Builder } from '../types.js';
import { findSessionFile } from '../utils/claude-session-discovery.js';
import { getGlobalDb } from '../db/index.js';
import { normalizeWorkspacePath } from '../servers/tower-utils.js';
import { processes, type ProcessCensusEntry } from '../../lib/platform/processes.js';

/** How much of a transcript's end is read: enough for several turns, bounded for huge files. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** Transcript lines shown per builder. */
export const LAST_TURN_COUNT = 3;
const TURN_LINE_WIDTH = 100;
/** The process table is read once for all builders and given up on after this long. */
export const CENSUS_TIMEOUT_MS = 3000;

export interface WorktreeProcess {
  pid: number;
  kind: 'test' | 'review';
  command: string;
}

/** Per-builder activity. `null` in any field means unknown. */
export interface BuilderActivity {
  /** ISO time the agent's session transcript was last written. */
  sessionWrittenAt: string | null;
  /** The transcript's last few messages, oldest first, one line each. */
  lastTurns: string[] | null;
  /** Whether the agent's last reply was an API error. */
  apiError: boolean | null;
  /** Test or review processes running under the builder's terminal. */
  processes: WorktreeProcess[] | null;
}

export interface TranscriptSummary {
  lastTurns: string[];
  apiError: boolean | null;
}

// ---------------------------------------------------------------------------
// Session transcript
// ---------------------------------------------------------------------------

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TURN_LINE_WIDTH ? `${flat.slice(0, TURN_LINE_WIDTH - 1)}…` : flat;
}

function toolCallLine(block: { name?: unknown; input?: unknown }): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = block.input && typeof block.input === 'object' ? Object.values(block.input) : [];
  const arg = input.find((v): v is string => typeof v === 'string');
  return arg === undefined ? name : `${name}(${arg})`;
}

/** One display line for a transcript message, or null for messages that say nothing (tool results, thinking). */
function messageLine(entry: Record<string, any>): string | null {
  const role = entry.type as 'user' | 'assistant';
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim() ? oneLine(`${role}: ${content}`) : null;
  if (!Array.isArray(content)) return null;
  const text = content.find((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
  if (text) return oneLine(`${role}: ${text.text}`);
  const tool = content.find((b) => b?.type === 'tool_use');
  if (tool) return oneLine(`tool: ${toolCallLine(tool)}`);
  return null;
}

/**
 * Summarize the end of a Claude Code session transcript (JSONL). The first line
 * is dropped when `partial`, since a tail read starts mid-line. `apiError` is
 * read off the last assistant message (`isApiErrorMessage`), and is null when
 * the text holds no assistant message.
 */
export function summarizeTranscript(text: string, partial: boolean): TranscriptSummary {
  const lines = text.split('\n');
  if (partial) lines.shift();
  const turns: string[] = [];
  let apiError: boolean | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isSidechain === true || entry.isMeta === true) continue;
    if (entry.type === 'assistant') apiError = entry.isApiErrorMessage === true;
    const turn = messageLine(entry);
    if (turn !== null) turns.push(turn);
  }
  return { lastTurns: turns.slice(-LAST_TURN_COUNT), apiError };
}

function readTail(file: string, size: number): { text: string; partial: boolean } {
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return { text: buffer.toString('utf-8'), partial: length < size };
}

/**
 * Read a builder's session activity. The session is the one the builder's
 * launch loop pinned in `<worktree>/.builder-session-id`; a builder without
 * that file (a harness with no pinned Claude session) or whose transcript
 * cannot be read reports every field as null.
 */
export function readSessionActivity(
  worktree: string,
  opts?: { homeDir?: string },
): Pick<BuilderActivity, 'sessionWrittenAt' | 'lastTurns' | 'apiError'> {
  const unknown = { sessionWrittenAt: null, lastTurns: null, apiError: null };
  try {
    const sessionId = readFileSync(join(worktree, '.builder-session-id'), 'utf-8').trim();
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return unknown;
    const file = findSessionFile(worktree, sessionId, opts);
    if (file === null) return unknown;
    const stat = statSync(file);
    const { text, partial } = readTail(file, stat.size);
    return { sessionWrittenAt: stat.mtime.toISOString(), ...summarizeTranscript(text, partial) };
  } catch {
    return unknown;
  }
}

// ---------------------------------------------------------------------------
// Processes under a builder's terminal
// ---------------------------------------------------------------------------

/** Runtimes whose next word is the program they run (`node …/vitest.mjs`, `python -m pytest`). */
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'deno', 'npx', 'pnpx', 'bunx']);
const TEST_RUNNERS = new Set(['vitest', 'jest', 'mocha', 'playwright', 'pytest']);
/** Package managers and toolchains that run tests as a subcommand (`pnpm test`, `go test`). */
const TEST_LAUNCHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'go', 'cargo']);
/** How far past a launcher its `test` subcommand may sit (`pnpm --filter pkg test`). */
const SUBCOMMAND_WINDOW = 4;

function commandWord(token: string): string {
  return basename(token.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.(m?js|cjs|cmd|exe)$/, '');
}

/**
 * Classify a process by the program it runs: `consult` is a review; a test
 * runner, or a package manager / toolchain running `test`, is a test. The
 * program is the first argv word that is neither a flag nor an interpreter, so
 * an agent whose argv carries its prompt text classifies as the agent, never by
 * the words of its prompt. Returns the kind and the command from the program
 * on, or null.
 */
export function classifyProcess(cmdline: string): Omit<WorktreeProcess, 'pid'> | null {
  // Windows command lines quote paths that contain spaces.
  const tokens = (cmdline.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  let i = 0;
  while (i < tokens.length && (tokens[i].startsWith('-') || INTERPRETERS.has(commandWord(tokens[i])))) i++;
  if (i >= tokens.length) return null;
  const program = commandWord(tokens[i]);
  const args = tokens.slice(i + 1);
  let kind: WorktreeProcess['kind'] | null = null;
  if (program === 'consult') kind = 'review';
  else if (TEST_RUNNERS.has(program)) kind = 'test';
  else if (TEST_LAUNCHERS.has(program) && args.slice(0, SUBCOMMAND_WINDOW).some((a) => /^test(:|$)/.test(a))) kind = 'test';
  if (kind === null) return null;
  return { kind, command: oneLine([program, ...args].join(' ')) };
}

/**
 * The test and review processes descended from `rootPid` (a builder's
 * shellper). The topmost match of each branch is reported, so `pnpm test` is
 * listed and not also the `vitest` it started. An empty list when the root is
 * no longer running.
 */
export function processesUnder(census: ProcessCensusEntry[], rootPid: number): WorktreeProcess[] {
  const children = new Map<number, ProcessCensusEntry[]>();
  for (const entry of census) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  if (!census.some((e) => e.pid === rootPid)) return [];
  const found: WorktreeProcess[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    const match = classifyProcess(entry.cmdline);
    if (match) {
      found.push({ pid: entry.pid, ...match });
      continue;
    }
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return found;
}

/** The process table, or null when it cannot be read within `timeoutMs`. */
export async function readCensus(
  timeoutMs: number = CENSUS_TIMEOUT_MS,
  census: () => Promise<ProcessCensusEntry[]> = () => processes().census(),
): Promise<ProcessCensusEntry[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  try {
    const entries = await Promise.race([census().catch(() => null), timeout]);
    // An empty table means the read failed (POSIX resolves [] on a `ps` error).
    return entries && entries.length > 0 ? entries : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Each builder terminal's shellper pid, keyed by lowercased builder id. Empty when unreadable. */
export function builderShellperPids(workspacePath: string): Map<string, number> {
  const pids = new Map<string, number>();
  try {
    const rows = getGlobalDb()
      .prepare(
        "SELECT role_id, shellper_pid FROM terminal_sessions WHERE workspace_path = ? AND type = 'builder' AND role_id IS NOT NULL AND shellper_pid IS NOT NULL",
      )
      .all(normalizeWorkspacePath(workspacePath)) as Array<{ role_id: string; shellper_pid: number }>;
    for (const row of rows) pids.set(row.role_id.toLowerCase(), row.shellper_pid);
  } catch {
    // DB unreadable — every builder's processes stay unknown.
  }
  return pids;
}

export interface ActivitySources {
  readCensus?: () => Promise<ProcessCensusEntry[] | null>;
  shellperPids?: (workspacePath: string) => Map<string, number>;
  homeDir?: string;
}

/** Gather activity for each builder, keyed by builder id. One process-table read serves them all. */
export async function gatherBuilderActivity(
  workspacePath: string,
  builders: Builder[],
  sources: ActivitySources = {},
): Promise<Map<string, BuilderActivity>> {
  const result = new Map<string, BuilderActivity>();
  if (builders.length === 0) return result;
  const census = await (sources.readCensus ?? (() => readCensus()))();
  const rootPids = (sources.shellperPids ?? builderShellperPids)(workspacePath);
  for (const builder of builders) {
    const rootPid = rootPids.get(builder.id.toLowerCase());
    let running: WorktreeProcess[] | null = null;
    if (census !== null && rootPid !== undefined) running = processesUnder(census, rootPid);
    result.set(builder.id, {
      ...readSessionActivity(builder.worktree, { homeDir: sources.homeDir }),
      processes: running,
    });
  }
  return result;
}
