/**
 * Spec 1658 Phase 3b: the job helper client against a fake helper process
 * (protocol, readiness, timeouts, degradation, bounded restarts). The real
 * PowerShell helper is covered by windows-job.windows.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  HELPER_READY_TIMEOUT_MS,
  HELPER_REQUEST_TIMEOUT_MS,
  HELPER_SCRIPT,
  WindowsJobHelper,
  encodeHelperCommand,
  sessionJobName,
  terminateSessionJob,
  type HelperProcess,
} from '../lib/windows-job.js';
import { JOB_ASSIGN_BUDGET_MS } from '../terminal/session-manager.js';
import { DEFER_PTY_DEADLINE_MS } from '../terminal/shellper-process.js';

type Responder = (request: Record<string, unknown>) => Record<string, unknown> | null;

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  requests: Record<string, unknown>[] = [];

  constructor(respond: Responder) {
    super();
    let buffer = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        this.requests.push(request);
        const response = respond(request);
        if (response) this.send({ ...response, id: request.id });
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(message) + '\n');
  }

  kill(): void {
    this.killed = true;
  }

  exit(code: number): void {
    this.emit('exit', code);
  }
}

function fakeFactory(opts: { ready?: Record<string, unknown> | null; respond?: Responder } = {}) {
  const spawned: FakeHelper[] = [];
  const spawnHelper = vi.fn(() => {
    const fake = new FakeHelper(opts.respond ?? (() => ({ ok: true })));
    spawned.push(fake);
    const ready = opts.ready === undefined ? { ready: true, languageMode: 'FullLanguage' } : opts.ready;
    if (ready) setImmediate(() => fake.send(ready));
    return fake as unknown as HelperProcess;
  });
  return { spawnHelper, spawned };
}

describe('WindowsJobHelper', () => {
  it('names session jobs in the local namespace', () => {
    expect(sessionJobName('abc')).toBe('Local\\codev-session-abc');
  });

  it('encodes the program as UTF-16LE base64 and never compiles with Add-Type', () => {
    expect(Buffer.from(encodeHelperCommand('ab'), 'base64')).toEqual(Buffer.from('ab', 'utf16le'));
    expect(HELPER_SCRIPT).toContain('DefineDynamicAssembly');
    expect(HELPER_SCRIPT).toContain('AssemblyBuilderAccess]::Run');
    expect(HELPER_SCRIPT).not.toMatch(/Add-Type/i);
    expect(HELPER_SCRIPT).not.toContain('KILL_ON_JOB_CLOSE');
    expect(HELPER_SCRIPT).toContain('0x0800');
    // A terminate checks membership; the shellper's handle is query-only.
    expect(HELPER_SCRIPT).toContain('IsProcessInJob');
    expect(HELPER_SCRIPT).not.toContain('DUPLICATE_SAME_ACCESS');
  });

  it('starts once (single flight) and serves assign and terminate', async () => {
    const f = fakeFactory({
      respond: (req) => {
        if (req.op === 'terminate') return { ok: true, found: true, member: true };
        return { ok: true };
      },
    });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    const [a, b] = await Promise.all([helper.start(), helper.start()]);
    expect([a, b]).toEqual([null, null]);
    expect(await helper.assign('job', 42)).toEqual({ assigned: true });
    expect(await helper.terminate('job', 42)).toEqual({ ok: true, found: true, member: true });
    expect(f.spawnHelper).toHaveBeenCalledTimes(1);
    expect(f.spawned[0].requests.map((r) => [r.op, r.name, r.pid])).toEqual([
      ['assign', 'job', 42],
      ['terminate', 'job', 42],
    ]);
  });

  it('a request before readiness waits for it', async () => {
    const f = fakeFactory();
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    expect(await helper.assign('job', 1)).toEqual({ assigned: true });
  });

  it('reports a refused name with its Win32 code, without throwing', async () => {
    const f = fakeFactory({ respond: () => ({ ok: false, error: 'job name already exists', code: 183 }) });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    expect(await helper.assign('job', 1)).toEqual({ assigned: false, reason: 'job name already exists (Win32 error 183)', helperFailure: false });
  });

  it('a bind failure disables jobs for good and is logged once', async () => {
    const log = vi.fn();
    const f = fakeFactory({ ready: { ready: false, error: 'Cannot invoke method', languageMode: 'ConstrainedLanguage' } });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper, log });
    const first = await helper.assign('job', 1);
    const second = await helper.assign('job', 2);
    expect(first.assigned).toBe(false);
    expect(second.assigned).toBe(false);
    expect(helper.degradedReason).toMatch(/ConstrainedLanguage/);
    expect(f.spawnHelper).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/Per-session job objects disabled/);
  });

  it('a helper that cannot spawn disables jobs', async () => {
    const log = vi.fn();
    const helper = new WindowsJobHelper({
      spawnHelper: () => {
        throw new Error('ENOENT powershell.exe');
      },
      log,
    });
    expect(await helper.start()).toMatch(/ENOENT/);
    expect(helper.degradedReason).toMatch(/ENOENT/);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a helper that exits before readiness disables jobs', async () => {
    const f = fakeFactory({ ready: null });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    const started = helper.start();
    await new Promise((r) => setImmediate(r));
    f.spawned[0].exit(1);
    expect(await started).toMatch(/exited \(code 1\) before it was ready/);
    expect(helper.degradedReason).not.toBeNull();
  });

  it('an assign with no answer times out: the session proceeds without a job, logged once', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const f = fakeFactory({ respond: () => null });
      const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper, log, requestTimeoutMs: 5000 });
      const ready = helper.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(await ready).toBeNull();

      const first = helper.assign('a', 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await first).toEqual({ assigned: false, reason: 'no answer within 5000ms', helperFailure: true });
      const second = helper.assign('b', 2);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await second).assigned).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      // A timeout is not a permanent degradation.
      expect(helper.degradedReason).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a helper that never reports ready times out its start', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFactory({ ready: null });
      const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper, readyTimeoutMs: 20_000 });
      const started = helper.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await started).toMatch(/did not report ready/);
      expect(f.spawned[0].killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an exit after serving fails in-flight requests and restarts on the next one, at most 3 times in the window', async () => {
    let now = 0;
    const log = vi.fn();
    const f = fakeFactory({ respond: () => null });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper, log, now: () => now, maxRestarts: 3, restartWindowMs: 300_000 });

    expect(await helper.start()).toBeNull();
    const inFlight = helper.assign('a', 1);
    await new Promise((r) => setImmediate(r));
    f.spawned[0].exit(0);
    expect(await inFlight).toEqual({ assigned: false, reason: 'the job helper exited', helperFailure: true });

    for (let restart = 1; restart <= 3; restart++) {
      now += 1000;
      expect(await helper.start()).toBeNull();
      f.spawned[restart].exit(0);
    }
    now += 1000;
    expect(await helper.start()).toMatch(/exited 4 times/);
    expect(f.spawnHelper).toHaveBeenCalledTimes(4);
    expect(helper.degradedReason).not.toBeNull();
    expect(log.mock.calls.some((call) => /Per-session job objects disabled/.test(call[0]))).toBe(true);
  });

  it('restarts again once old exits leave the window', async () => {
    let now = 0;
    const f = fakeFactory();
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper, now: () => now, maxRestarts: 1, restartWindowMs: 1000 });
    expect(await helper.start()).toBeNull();
    f.spawned[0].exit(0);
    now = 10;
    expect(await helper.start()).toBeNull();
    f.spawned[1].exit(0);
    now = 5000;
    expect(await helper.start()).toBeNull();
    expect(helper.degradedReason).toBeNull();
  });

  it('stop ends the helper process', async () => {
    const f = fakeFactory();
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    await helper.start();
    helper.stop();
    expect(f.spawned[0].killed).toBe(true);
  });

  it('stop fails requests in flight at once', async () => {
    const f = fakeFactory({ respond: () => null });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    await helper.start();
    const inFlight = helper.assign('a', 1);
    await new Promise((r) => setImmediate(r));
    helper.stop();
    expect(await inFlight).toEqual({ assigned: false, reason: 'the job helper exited', helperFailure: true });
  });

  it('an exit after readiness is logged once; a stop is not', async () => {
    const log = vi.fn();
    const f = fakeFactory();
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper, log });
    await helper.start();
    f.spawned[0].exit(1);
    await helper.start();
    f.spawned[1].exit(1);
    expect(log.mock.calls.map((c) => c[0])).toEqual(['Job helper: the job helper exited (code 1); it restarts on the next request']);

    const quiet = vi.fn();
    const g = fakeFactory();
    const stopped = new WindowsJobHelper({ spawnHelper: g.spawnHelper, log: quiet });
    await stopped.start();
    stopped.stop();
    g.spawned[0].exit(0);
    expect(quiet).not.toHaveBeenCalled();
  });

  it('marks a request refused because jobs are disabled', async () => {
    const f = fakeFactory({ ready: { ready: false, error: 'blocked', languageMode: 'ConstrainedLanguage' } });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    const result = await helper.terminate('job', 1);
    expect(result.disabled).toBe(true);
    expect(result.helperFailure).toBe(true);
  });

  it('a cold helper plus one request fits the create budget, which fits the shellper deadline', () => {
    expect(HELPER_READY_TIMEOUT_MS + HELPER_REQUEST_TIMEOUT_MS).toBeLessThan(JOB_ASSIGN_BUDGET_MS);
    expect(JOB_ASSIGN_BUDGET_MS).toBeLessThan(DEFER_PTY_DEADLINE_MS);
  });

  it('terminateSessionJob uses the given helper', async () => {
    const f = fakeFactory({ respond: () => ({ ok: true, found: false }) });
    const helper = new WindowsJobHelper({ spawnHelper: f.spawnHelper });
    expect(await terminateSessionJob('job', 7, helper)).toEqual({ ok: true, found: false });
  });
});
