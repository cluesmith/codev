/**
 * Issue #1224: tests for architect session-holder detection & mint-or-reclaim.
 *
 * The critical safety property under test is NEVER-KILL-FOREIGN: only our own
 * identity-matched superseded shellper is ever reaped; a foreign holder (e.g. a
 * claude the user started by hand) is classified foreign and left untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  sessionIdNeedles,
  cmdlineHoldsSession,
  isOwnArchitectShellper,
  classifyArchitectSessionHolder,
  findOwnArchitectShellpers,
  reapShellpers,
  reconcileArchitectSessionHolder,
  type ProcessEntry,
} from '../servers/architect-session-holder.js';

const SID = '166e1c25-fd66-46ed-a81c-5dfcf2295efd';
const WS = '/Users/x/workspace';

/** Build a realistic shellper-main.js process argv line (as `ps` reports it). */
function shellperCmdline(opts: {
  sessionId?: string;
  cwd?: string;
  architectName?: string;
  flag?: string;
}): string {
  const config = {
    command: 'claude',
    args: [opts.flag ?? '--session-id', opts.sessionId ?? SID],
    cwd: opts.cwd ?? WS,
    env: { CODEV_ARCHITECT_NAME: opts.architectName ?? 'main', PATH: '/usr/bin' },
    socketPath: '/tmp/sock/s.sock',
  };
  return `/usr/bin/node /opt/codev/dist/terminal/shellper-main.js ${JSON.stringify(config)}`;
}

/** A bare claude child's shell argv (the foreground-holder case). */
function claudeChildCmdline(sessionId = SID, flag = '--resume'): string {
  return `/usr/bin/claude ${flag} ${sessionId} --append-system-prompt xyz`;
}

describe('sessionIdNeedles / cmdlineHoldsSession (Issue #1224)', () => {
  it('matches the claude-child shell forms', () => {
    expect(cmdlineHoldsSession(`claude --session-id ${SID}`, SID)).toBe(true);
    expect(cmdlineHoldsSession(`claude --resume ${SID}`, SID)).toBe(true);
    expect(cmdlineHoldsSession(`claude --session-id=${SID}`, SID)).toBe(true);
    expect(cmdlineHoldsSession(`claude --resume=${SID}`, SID)).toBe(true);
  });

  it('matches the shellper-parent JSON argv form (the crash-loop remnant)', () => {
    // This is the form a remnant shellper carries while its child is dead.
    expect(cmdlineHoldsSession(shellperCmdline({}), SID)).toBe(true);
    expect(cmdlineHoldsSession(`x "--resume","${SID}" y`, SID)).toBe(true);
  });

  it('does not match an unrelated or bare-substring occurrence', () => {
    expect(cmdlineHoldsSession(`some/path/${SID}/file`, SID)).toBe(false);
    expect(cmdlineHoldsSession(`claude --resume other-id`, SID)).toBe(false);
    expect(sessionIdNeedles(SID)).toContain(`"--session-id","${SID}"`);
  });
});

describe('isOwnArchitectShellper (Issue #1224)', () => {
  it('is true for a shellper matching cwd + CODEV_ARCHITECT_NAME', () => {
    const line = shellperCmdline({ architectName: 'reviewer', cwd: WS });
    expect(isOwnArchitectShellper(line, { workspacePath: WS, architectName: 'reviewer' })).toBe(true);
  });

  it('is false for a non-shellper process (a bare claude child)', () => {
    expect(isOwnArchitectShellper(claudeChildCmdline(), { workspacePath: WS, architectName: 'main' })).toBe(false);
  });

  it('is false when the architect name differs', () => {
    const line = shellperCmdline({ architectName: 'reviewer' });
    expect(isOwnArchitectShellper(line, { workspacePath: WS, architectName: 'main' })).toBe(false);
  });

  it('is false when the cwd differs', () => {
    const line = shellperCmdline({ cwd: '/some/other/ws', architectName: 'main' });
    expect(isOwnArchitectShellper(line, { workspacePath: WS, architectName: 'main' })).toBe(false);
  });
});

describe('classifyArchitectSessionHolder (Issue #1224)', () => {
  const identity = { workspacePath: WS, architectName: 'main' };

  it('classifies our own superseded shellper as reclaimable', () => {
    const list = (): ProcessEntry[] => [{ pid: 18907, cmdline: shellperCmdline({}) }];
    const r = classifyArchitectSessionHolder({ sessionId: SID, identity, list });
    expect(r.reclaimable).toEqual([18907]);
    expect(r.foreign).toBe(false);
  });

  it('NEVER-KILL-FOREIGN: a bare claude holding the id is foreign, not reclaimable', () => {
    const list = (): ProcessEntry[] => [{ pid: 97841, cmdline: claudeChildCmdline() }];
    const r = classifyArchitectSessionHolder({ sessionId: SID, identity, list });
    expect(r.reclaimable).toEqual([]);
    expect(r.foreign).toBe(true);
  });

  it('a shellper for a DIFFERENT identity holding the id is foreign', () => {
    const list = (): ProcessEntry[] => [
      { pid: 500, cmdline: shellperCmdline({ architectName: 'someone-else' }) },
    ];
    const r = classifyArchitectSessionHolder({ sessionId: SID, identity, list });
    expect(r.reclaimable).toEqual([]);
    expect(r.foreign).toBe(true);
  });

  it('ignores processes that do not hold the session and excludes selfPid', () => {
    const list = (): ProcessEntry[] => [
      { pid: 1, cmdline: 'node server.js' },
      { pid: 18907, cmdline: shellperCmdline({}) },
      { pid: 42, cmdline: shellperCmdline({}) }, // would match but is self
    ];
    const r = classifyArchitectSessionHolder({ sessionId: SID, identity, selfPid: 42, list });
    expect(r.reclaimable).toEqual([18907]);
    expect(r.foreign).toBe(false);
  });

  it('returns no holders when the ps scan throws', () => {
    const list = () => { throw new Error('ps failed'); };
    const r = classifyArchitectSessionHolder({ sessionId: SID, identity, list });
    expect(r).toEqual({ reclaimable: [], foreign: false });
  });
});

describe('findOwnArchitectShellpers (Issue #1224)', () => {
  it('finds our shellpers by identity regardless of the session they hold', async () => {
    const list = (): ProcessEntry[] => [
      { pid: 61274, cmdline: shellperCmdline({ sessionId: 'aaa', architectName: 'C', cwd: WS }) },
      { pid: 99, cmdline: shellperCmdline({ sessionId: 'bbb', architectName: 'other', cwd: WS }) },
      { pid: 12, cmdline: claudeChildCmdline() },
    ];
    const pids = await findOwnArchitectShellpers({ identity: { workspacePath: WS, architectName: 'C' }, list });
    expect(pids).toEqual([61274]);
  });
});

describe('reapShellpers (Issue #1224)', () => {
  it('SIGTERMs all, then SIGKILLs survivors, and resolves', async () => {
    const kills: Array<[number, string]> = [];
    let aliveMap: Record<number, boolean> = { 10: true, 20: true };
    const r = reapShellpers([10, 20], {
      kill: (pid, sig) => {
        kills.push([pid, sig]);
        // pid 10 dies on SIGTERM; pid 20 survives until SIGKILL
        if (sig === 'SIGTERM' && pid === 10) aliveMap[10] = false;
        if (sig === 'SIGKILL') aliveMap[pid] = false;
      },
      isAlive: (pid) => aliveMap[pid] ?? false,
      wait: async () => {},
      graceMs: 300,
      pollMs: 100,
    });
    await r;
    expect(kills).toContainEqual([10, 'SIGTERM']);
    expect(kills).toContainEqual([20, 'SIGTERM']);
    // 20 survived the grace window → escalated
    expect(kills).toContainEqual([20, 'SIGKILL']);
    // 10 died on SIGTERM → not escalated
    expect(kills).not.toContainEqual([10, 'SIGKILL']);
  });

  it('is a no-op for an empty pid list', async () => {
    const kill = vi.fn();
    await reapShellpers([], { kill, isAlive: () => false, wait: async () => {} });
    expect(kill).not.toHaveBeenCalled();
  });

  it('confirms death after SIGKILL before resolving (no resume race)', async () => {
    // The holder survives SIGTERM and even the first poll after SIGKILL, then
    // dies. reapShellpers must not resolve until it observes the death — a
    // premature return would let the caller resume while the lock is still held.
    let aliveChecks = 0;
    const kill = vi.fn();
    const waits: number[] = [];
    await reapShellpers([20], {
      kill,
      // alive for SIGTERM grace + one post-SIGKILL poll, dead thereafter.
      isAlive: () => { aliveChecks += 1; return aliveChecks <= 5; },
      wait: async (ms) => { waits.push(ms); },
      graceMs: 300,
      killGraceMs: 400,
      pollMs: 100,
    });
    expect(kill).toHaveBeenCalledWith(20, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(20, 'SIGKILL');
    // It kept polling after SIGKILL rather than returning immediately.
    expect(waits.length).toBeGreaterThan(3);
  });
});

describe('reconcileArchitectSessionHolder (Issue #1224)', () => {
  const identity = { workspacePath: WS, architectName: 'main' };

  it('foreign holder → foreignHolder:true and NEVER reaps', async () => {
    const reap = vi.fn(async () => {});
    const log = vi.fn();
    const list = (): ProcessEntry[] => [{ pid: 97841, cmdline: claudeChildCmdline() }];
    const r = await reconcileArchitectSessionHolder({ sessionId: SID, identity, list, reap, log });
    expect(r.foreignHolder).toBe(true);
    expect(r.reclaimedPids).toEqual([]);
    expect(reap).not.toHaveBeenCalled(); // architect's explicit never-kill-foreign requirement
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('foreign process'));
  });

  it('own superseded shellper → reaps it and allows resume', async () => {
    const reap = vi.fn(async () => {});
    const list = (): ProcessEntry[] => [{ pid: 18907, cmdline: shellperCmdline({}) }];
    const r = await reconcileArchitectSessionHolder({ sessionId: SID, identity, list, reap });
    expect(r.foreignHolder).toBe(false);
    expect(r.reclaimedPids).toEqual([18907]);
    expect(reap).toHaveBeenCalledWith([18907]);
  });

  it('no holder → foreignHolder:false and no reap', async () => {
    const reap = vi.fn(async () => {});
    const list = (): ProcessEntry[] => [{ pid: 1, cmdline: 'node server.js' }];
    const r = await reconcileArchitectSessionHolder({ sessionId: SID, identity, list, reap });
    expect(r.foreignHolder).toBe(false);
    expect(r.reclaimedPids).toEqual([]);
    expect(reap).not.toHaveBeenCalled();
  });

  it('a foreign holder alongside an own shellper still refuses to reap (foreign wins)', async () => {
    const reap = vi.fn(async () => {});
    const list = (): ProcessEntry[] => [
      { pid: 18907, cmdline: shellperCmdline({}) },
      { pid: 97841, cmdline: claudeChildCmdline() },
    ];
    const r = await reconcileArchitectSessionHolder({ sessionId: SID, identity, list, reap });
    expect(r.foreignHolder).toBe(true);
    expect(reap).not.toHaveBeenCalled();
  });
});
