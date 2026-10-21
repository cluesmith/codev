/**
 * Regression tests for issue #1814: a check's `timeout_ms` in protocol.json was
 * dropped at load, so every check died at the fixed 5-minute cap; and a timed-out
 * check SIGTERMed only its shell, so a grandchild holding stdout open kept
 * `porch done` waiting forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { loadProtocol, getPhaseChecks } from '../protocol.js';
import { runCheck, runPhaseChecks, type CheckEnv } from '../checks.js';
import { logCheckOverrides } from '../index.js';

const env: CheckEnv = { PROJECT_ID: '1814', PROJECT_TITLE: 'check-timeout' };

function writeProtocol(root: string, checks: Record<string, unknown>, defaults?: unknown): void {
  const dir = path.join(root, 'codev/protocols/timeouts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'protocol.json'),
    JSON.stringify({ name: 'timeouts', defaults, phases: [{ id: 'implement', checks }] }),
  );
}

/** Resolve once `pid` no longer exists, or fail after `withinMs`. */
async function expectProcessGone(pid: number, withinMs = 3000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`process ${pid} still alive ${withinMs}ms after the check ended`);
}

/** A check whose grandchild records its pid, then holds the shell's stdout pipe for 30s. */
function grandchildCommand(pidFile: string): string {
  return `sh -c 'echo $$ > ${pidFile}; exec sleep 30' | cat`;
}

async function readPid(pidFile: string): Promise<number> {
  while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf-8').trim() === '') {
    await new Promise(r => setTimeout(r, 20));
  }
  return Number(fs.readFileSync(pidFile, 'utf-8').trim());
}

describe('bugfix #1814: per-check timeout_ms', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'porch-1814-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a protocol.json timeout_ms reaches the runner and kills the check at that value', async () => {
    writeProtocol(root, { tests_py: { command: 'sleep 3', timeout_ms: 300 } });

    const checks = getPhaseChecks(loadProtocol(root, 'timeouts'), 'implement');
    expect(checks.tests_py.timeout_ms).toBe(300);

    const [result] = await runPhaseChecks(checks, root, env);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Timed out after 0.3s');
    expect(result.duration_ms).toBeLessThan(2500);
  }, 15_000);

  it('a timeout_ms in defaults.checks is parsed too', () => {
    writeProtocol(root, {}, { checks: { tests_py: { command: 'x', timeout_ms: 900_000 } } });

    expect(loadProtocol(root, 'timeouts').checks?.tests_py.timeout_ms).toBe(900_000);
  });

  it('a check without timeout_ms keeps the runner default', async () => {
    writeProtocol(root, { build: { command: 'sleep 3' } });

    const checks = getPhaseChecks(loadProtocol(root, 'timeouts'), 'implement');
    expect(checks.build.timeout_ms).toBeUndefined();

    const [result] = await runPhaseChecks(checks, root, env, 300);
    expect(result.error).toContain('Timed out after 0.3s');
  }, 15_000);

  it('a check timeout_ms takes precedence over the runPhaseChecks default', async () => {
    const [result] = await runPhaseChecks({ slow: { command: 'sleep 3', timeout_ms: 300 } }, root, env, 60_000);
    expect(result.error).toContain('Timed out after 0.3s');
  }, 15_000);

  it.each([0, -1, 1.5, '900000', 2 ** 31])('rejects timeout_ms %j at load', (value) => {
    writeProtocol(root, { tests_py: { command: 'x', timeout_ms: value } });

    expect(() => loadProtocol(root, 'timeouts')).toThrow(/check "tests_py": timeout_ms must be a positive integer/);
  });

  it('a .codev/config.json override can set or inherit timeout_ms', () => {
    writeProtocol(root, { tests_py: { command: 'pytest', timeout_ms: 600_000 }, build: { command: 'make' } });
    const protocol = loadProtocol(root, 'timeouts');

    const raised = getPhaseChecks(protocol, 'implement', { tests_py: { timeout_ms: 900_000 }, build: { timeout_ms: 1000 } });
    expect(raised.tests_py.timeout_ms).toBe(900_000);
    expect(raised.build.timeout_ms).toBe(1000);

    const inherited = getPhaseChecks(protocol, 'implement', { tests_py: { command: 'uv run pytest' } });
    expect(inherited.tests_py).toEqual({ command: 'uv run pytest', cwd: undefined, timeout_ms: 600_000 });

    expect(() => getPhaseChecks(protocol, 'implement', { tests_py: { timeout_ms: -5 } }))
      .toThrow(/porch\.checks\.tests_py: timeout_ms must be a positive integer/);
  });

  it('an override that sets only timeout_ms is announced like any other override', () => {
    writeProtocol(root, { tests_py: { command: 'pytest' } });
    const overrides = { tests_py: { timeout_ms: 900_000 } };
    const checks = getPhaseChecks(loadProtocol(root, 'timeouts'), 'implement', overrides);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logCheckOverrides(['tests_py'], checks, overrides);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('Check "tests_py" overridden: timeout: 900000ms');
    log.mockRestore();
  });
});

describe('bugfix #1814: a timed-out check dies with its whole process tree', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'porch-1814-tree-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('timeout kills grandchildren holding stdout, so the check resolves', async () => {
    const pidFile = path.join(root, 'grandchild.pid');

    const result = await runCheck('tree', grandchildCommand(pidFile), root, env, 300);

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Timed out after 0.3s');
    expect(result.duration_ms).toBeLessThan(3000);
    await expectProcessGone(await readPid(pidFile));
  }, 15_000);

  it('a member that ignores SIGTERM and holds no pipe is SIGKILLed before the check resolves', async () => {
    const pidFile = path.join(root, 'stubborn.pid');
    // The shell dies on SIGTERM and closes the pipes at once; the backgrounded
    // grandchild ignores SIGTERM with its stdio on /dev/null. porch exits right
    // after a failed check, so the runner itself must outlast the escalation.
    const command = `sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 30' >/dev/null 2>&1 & wait`;

    const result = await runCheck('stubborn', command, root, env, 300);

    expect(result.error).toContain('Timed out after 0.3s');
    await expectProcessGone(await readPid(pidFile), 500);
  }, 30_000);

  it("porch's own SIGINT is relayed to the check's process group, then re-raised", async () => {
    const pidFile = path.join(root, 'grandchild.pid');
    const before = new Set(process.listeners('SIGINT'));

    const pending = runCheck('relay', grandchildCommand(pidFile), root, env, 60_000);
    const relay = process.listeners('SIGINT').find(l => !before.has(l));
    expect(relay).toBeDefined();
    const pid = await readPid(pidFile);

    // Swallow only the re-raise at porch itself; group signals go through for real.
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(
      ((target: number, signal?: string | number) =>
        target === process.pid ? true : realKill(target, signal)) as typeof process.kill,
    );

    relay!('SIGINT');
    const result = await pending;

    expect(result.passed).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
    expect(process.listeners('SIGINT')).not.toContain(relay);
    await expectProcessGone(pid);
  }, 15_000);

  it('a check that ends normally removes its signal relay', async () => {
    const before = process.listeners('SIGTERM').length;

    const result = await runCheck('echo', 'echo ok', root, env);

    expect(result.passed).toBe(true);
    expect(process.listeners('SIGTERM')).toHaveLength(before);
  });
});
