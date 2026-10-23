/**
 * Spec 1658 Phase 3b: SessionManager and the per-session Job Object (seam
 * forced to `win32`; spawn, endpoint wait and client mocked; injected helper).
 *
 * - The shellper is launched with `deferPty`, and its job is assigned before
 *   the client connects (whose HELLO spawns the PTY).
 * - A helper failure or refusal never fails the create: helper-wide failures
 *   are left to the helper's own single log line, a per-session refusal is
 *   logged here.
 * - POSIX never asks for a job, and its launch config is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobAssignOutcome, WindowsJobHelper } from '../../lib/windows-job.js';

const events: string[] = [];
const launches: Array<Record<string, unknown>> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      launches.push(JSON.parse(args[1]) as Record<string, unknown>);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void; unref: () => void };
      child.stdout = new PassThrough();
      child.kill = () => {};
      child.unref = () => {};
      setImmediate(() => child.stdout.write(JSON.stringify({ pid: 777, startTime: 1 })));
      return child;
    }),
  };
});

vi.mock('../shellper-endpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shellper-endpoint.js')>();
  return { ...actual, waitForEndpoint: vi.fn(async () => {}) };
});

vi.mock('../shellper-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shellper-client.js')>();
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeClient extends Emitter {
    async connect() {
      events.push('connect');
      return { pid: 778, cols: 80, rows: 24, startTime: 1, version: 1 };
    }
    disconnect() {}
  }
  return { ...actual, ShellperClient: FakeClient };
});

const { SessionManager, JOB_ASSIGN_BUDGET_MS } = await import('../session-manager.js');
const { resetHostPlatformForTests, setHostPlatformForTests } = await import('../../lib/platform.js');

let socketDir: string;

function fakeHelper(outcome: JobAssignOutcome) {
  const assign = vi.fn(async (name: string, pid: number) => {
    events.push(`assign ${name} ${pid}`);
    return outcome;
  });
  return { helper: { assign } as unknown as WindowsJobHelper, assign };
}

function newManager(logs: string[], helper: WindowsJobHelper | null) {
  return new SessionManager({
    socketDir,
    shellperScript: '/nonexistent.js',
    nodeExecutable: process.execPath,
    logger: (msg) => logs.push(msg),
    jobHelper: () => helper,
  });
}

const createOpts = () => ({ sessionId: 'sess-j', command: 'cmd', args: [], cwd: os.tmpdir(), env: {}, cols: 80, rows: 24 });

beforeEach(() => {
  events.length = 0;
  launches.length = 0;
  socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smjob-'));
});

afterEach(() => {
  resetHostPlatformForTests();
  fs.rmSync(socketDir, { recursive: true, force: true });
});

describe('SessionManager per-session job (Windows)', () => {
  it('launches with deferPty and assigns the job before connecting', async () => {
    setHostPlatformForTests('win32');
    const { helper } = fakeHelper({ assigned: true });
    const manager = newManager([], helper);

    await manager.createSession(createOpts());

    expect(launches[0].deferPty).toBe(true);
    expect(events).toEqual(['assign Local\\codev-session-sess-j 777', 'connect']);
  });

  it('a per-session refusal is logged and the session is still created', async () => {
    setHostPlatformForTests('win32');
    const { helper } = fakeHelper({ assigned: false, reason: 'job name already exists (Win32 error 183)', helperFailure: false });
    const logs: string[] = [];
    const manager = newManager(logs, helper);

    await manager.createSession(createOpts());

    expect(events).toEqual(['assign Local\\codev-session-sess-j 777', 'connect']);
    expect(logs.filter((l) => l.includes('started without a job object'))).toEqual([
      'Session sess-j: started without a job object: job name already exists (Win32 error 183)',
    ]);
  });

  it('a helper-wide failure (timeout, disabled) is not logged per session', async () => {
    setHostPlatformForTests('win32');
    const { helper } = fakeHelper({ assigned: false, reason: 'no answer within 5000ms', helperFailure: true });
    const logs: string[] = [];
    await newManager(logs, helper).createSession(createOpts());
    expect(events).toContain('connect');
    expect(logs.some((l) => l.includes('without a job object'))).toBe(false);
  });

  it('an assign that outlasts the budget is abandoned: the session connects in time, logged', async () => {
    setHostPlatformForTests('win32');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const helper = { assign: vi.fn(() => new Promise(() => {})) } as unknown as WindowsJobHelper;
      const logs: string[] = [];
      const created = newManager(logs, helper).createSession(createOpts());
      await vi.advanceTimersByTimeAsync(JOB_ASSIGN_BUDGET_MS);
      await created;
      expect(events).toEqual(['connect']);
      expect(logs).toContain(`Session sess-j: started without a job object: no job assigned within ${JOB_ASSIGN_BUDGET_MS}ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no helper, sessions start without a job and that is logged once', async () => {
    setHostPlatformForTests('win32');
    const logs: string[] = [];
    const manager = newManager(logs, null);
    await manager.createSession(createOpts());
    await manager.createSession({ ...createOpts(), sessionId: 'sess-k' });
    expect(logs.filter((l) => l.includes('No job helper'))).toHaveLength(1);
  });
});

describe('SessionManager per-session job (POSIX)', () => {
  it('never asks for a job and launches without deferPty', async () => {
    setHostPlatformForTests('linux');
    const { helper, assign } = fakeHelper({ assigned: true });
    await newManager([], helper).createSession(createOpts());
    expect(assign).not.toHaveBeenCalled();
    expect(launches[0].deferPty).toBeUndefined();
    expect(events).toEqual(['connect']);
  });
});
