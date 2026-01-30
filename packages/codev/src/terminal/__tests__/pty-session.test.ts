import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtySession } from '../pty-session.js';
import type { PtySessionConfig } from '../pty-session.js';

// Mock node-pty
const mockPty = {
  pid: 12345,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPty),
}));

function makeConfig(overrides?: Partial<PtySessionConfig>): PtySessionConfig {
  return {
    id: 'test-session-id',
    command: '/bin/bash',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: { PATH: '/usr/bin', HOME: '/tmp', SHELL: '/bin/bash', TERM: 'xterm-256color' },
    label: 'test-session',
    logDir: path.join(os.tmpdir(), 'pty-session-test-logs'),
    diskLogEnabled: false, // Disable disk logging for unit tests
    ringBufferLines: 100,
    reconnectTimeoutMs: 1000,
    ...overrides,
  };
}

describe('PtySession', () => {
  let session: PtySession;
  let dataCallback: (data: string) => void;
  let exitCallback: (e: { exitCode: number }) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPty.onData.mockImplementation((cb: (data: string) => void) => { dataCallback = cb; });
    mockPty.onExit.mockImplementation((cb: (e: { exitCode: number }) => void) => { exitCallback = cb; });

    session = new PtySession(makeConfig());
    await session.spawn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns with correct properties', () => {
    expect(session.id).toBe('test-session-id');
    expect(session.label).toBe('test-session');
    expect(session.status).toBe('running');
    expect(session.pid).toBe(12345);
  });

  it('returns session info', () => {
    const info = session.info;
    expect(info.id).toBe('test-session-id');
    expect(info.pid).toBe(12345);
    expect(info.cols).toBe(80);
    expect(info.rows).toBe(24);
    expect(info.label).toBe('test-session');
    expect(info.status).toBe('running');
    expect(info.createdAt).toBeTruthy();
  });

  it('writes data to pty', () => {
    session.write('hello');
    expect(mockPty.write).toHaveBeenCalledWith('hello');
  });

  it('resizes pty', () => {
    session.resize(120, 40);
    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    expect(session.info.cols).toBe(120);
    expect(session.info.rows).toBe(40);
  });

  it('captures pty output in ring buffer', () => {
    dataCallback('line1\nline2\n');
    const all = session.ringBuffer.getAll();
    expect(all).toContain('line1');
    expect(all).toContain('line2');
  });

  it('broadcasts data to attached clients', () => {
    const client = { send: vi.fn() };
    session.attach(client);
    dataCallback('hello');
    expect(client.send).toHaveBeenCalledWith('hello');
  });

  it('replays ring buffer on attach', () => {
    dataCallback('line1\nline2');
    const client = { send: vi.fn() };
    const replay = session.attach(client);
    expect(replay.length).toBeGreaterThan(0);
  });

  it('removes client on detach', () => {
    const client = { send: vi.fn() };
    session.attach(client);
    session.detach(client);
    expect(session.clientCount).toBe(0);
  });

  it('handles pty exit', () => {
    const exitSpy = vi.fn();
    session.on('exit', exitSpy);
    exitCallback({ exitCode: 0 });
    expect(session.status).toBe('exited');
    expect(session.info.exitCode).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('handles failed send to client gracefully', () => {
    const client = {
      send: vi.fn(() => { throw new Error('closed'); }),
    };
    session.attach(client);
    // Should not throw
    dataCallback('test');
    expect(session.clientCount).toBe(0); // Client removed after error
  });

  it('starts disconnect timer when last client detaches', () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.fn();
    session.on('timeout', timeoutSpy);

    const client = { send: vi.fn() };
    session.attach(client);
    session.detach(client);

    vi.advanceTimersByTime(1000);
    expect(timeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels disconnect timer when new client attaches', () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.fn();
    session.on('timeout', timeoutSpy);

    const client1 = { send: vi.fn() };
    const client2 = { send: vi.fn() };
    session.attach(client1);
    session.detach(client1); // starts timer

    session.attach(client2); // cancels timer
    vi.advanceTimersByTime(2000);
    expect(timeoutSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('supports resume with sequence number', () => {
    dataCallback('a\nb\nc\nd');
    const client = { send: vi.fn() };
    const seq = session.ringBuffer.currentSeq;
    dataCallback('e\nf');
    const replay = session.attachResume(client, seq);
    expect(replay).toEqual(['e', 'f']);
  });
});
