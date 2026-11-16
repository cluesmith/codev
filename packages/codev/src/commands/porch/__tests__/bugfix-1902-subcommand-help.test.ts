/**
 * Regression test for #1902 (found while verifying it): `porch <command> --help` executed the
 * command. Checking every command the prompts name with `--help` ran `porch done --help`,
 * which ran `porch done` on the auto-detected project — build and test checks included — and
 * would have gone on to `porch gate --help` requesting a gate.
 *
 * `--help` / `-h` after any subcommand now prints the help text and returns without touching
 * project state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli } from '../index.js';

async function runHelp(args: string[]): Promise<{ stdout: string; exited: number | null; cwdFiles: string[] }> {
  // An empty directory: if the subcommand ran, project resolution or init would fail or write.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-help-1902-'));
  const origCwd = process.cwd();
  const out: string[] = [];
  let exited: number | null = null;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    // Keep the FIRST exit: the mock throws to unwind, and cli()'s own catch then exits 1.
    if (exited === null) exited = code ?? 0;
    throw new Error('__process_exit__');
  }) as never);
  try {
    process.chdir(tmp);
    await cli(args).catch(() => { /* __process_exit__ */ });
    return { stdout: out.join('\n'), exited, cwdFiles: fs.readdirSync(tmp) };
  } finally {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('porch <command> --help (#1902)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['done', '--help'],
    ['gate', '--help'],
    ['next', '--help'],
    ['check', '-h'],
    ['init', '--help'],
    ['approve', '--help'],
    ['rollback', '--help'],
    ['verify', '--help'],
    ['status', '--help'],
  ])('porch %s %s prints help and runs nothing', async (...args) => {
    const { stdout, exited, cwdFiles } = await runHelp(args);
    expect(stdout).toContain('porch - Protocol Orchestrator');
    expect(stdout).toContain('approve <id> <gate> --a-human-explicitly-approved-this');
    expect(exited).toBeNull();
    expect(cwdFiles).toEqual([]);
  });

  it('a bare unknown command still prints help and exits 1', async () => {
    const { stdout, exited } = await runHelp(['bogus']);
    expect(stdout).toContain('porch - Protocol Orchestrator');
    expect(exited).toBe(1);
  });

  it('`porch --help` still exits 0', async () => {
    const { exited } = await runHelp(['--help']);
    expect(exited).toBe(0);
  });
});
