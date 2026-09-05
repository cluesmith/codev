/**
 * PtySession's input observation for the delivery gate (Issue #1473).
 *
 * The gate had no input signal at all: `bytesWritten` counts OUTPUT and `lastDataAt` tracks
 * OUTPUT, so a keystroke was invisible until the TUI happened to echo it. These tests pin the
 * two signals that close that, and — just as importantly — the things that must NOT change:
 * the PTY still receives every byte verbatim, and the delivery's own write moves nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ptyWrites: string[] = [];

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn((data: string) => { ptyWrites.push(data); }),
      resize: vi.fn(),
      pid: 4242,
      kill: vi.fn(),
    })),
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, mkdirSync: vi.fn(), openSync: vi.fn(() => 99), writeSync: vi.fn(), closeSync: vi.fn() };
});

import { PtySession } from '../pty-session.js';

const ESC = '\x1b';
const DA_REPLY = `${ESC}[?1;2c`;

let now = 1_000_000;
const clock = (): number => now;

async function liveSession(id = 'sig-1'): Promise<PtySession> {
  const session = new PtySession({
    id,
    command: '/bin/bash',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: {},
    label: 'test',
    logDir: '/tmp/logs',
    diskLogEnabled: false,
    clock,
  });
  await session.spawn();
  return session;
}

describe('PtySession input signal (Issue #1473)', () => {
  beforeEach(() => {
    ptyWrites.length = 0;
    now = 1_000_000;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('inputSeq', () => {
    it('starts at 0 and is monotone across writes', async () => {
      const session = await liveSession();
      expect(session.inputSeq).toBe(0);
      session.write('ab');
      expect(session.inputSeq).toBe(2);
      session.write('cde');
      expect(session.inputSeq).toBe(5);
    });

    it('advances by the chunk length on an external write, and moves lastInputAt', async () => {
      const session = await liveSession();
      now = 2_000_000;
      session.write('hello');
      expect(session.inputSeq).toBe(5);
      expect(session.lastInputAt).toBe(2_000_000);
    });

    it('moves NEITHER signal for a delivery write', async () => {
      const session = await liveSession();
      session.write('typed');
      const seqAfterHuman = session.inputSeq;
      const atAfterHuman = session.lastInputAt;

      now = 9_000_000;
      session.write('[FROM architect]\nbody line\n', 'delivery');
      session.write('\r', 'delivery');

      expect(session.inputSeq).toBe(seqAfterHuman);
      expect(session.lastInputAt).toBe(atAfterHuman);
    });

    it('defaults to counting — an unlabelled write is treated as foreign input', async () => {
      // The failure this inversion exists to prevent is a NEW input path that forgets to
      // announce itself. Over-counting is a self-correcting hold; under-counting writes a
      // message onto somebody's draft.
      const session = await liveSession();
      session.write('x');
      expect(session.inputSeq).toBe(1);
    });

    it('still bumps when the write is DROPPED', async () => {
      // The question is "did a foreign writer put input at this session?", not "did it land".
      const session = await liveSession();
      session.kill();
      const before = session.inputSeq;
      expect(session.write('typed after death')).toBe(false);
      expect(session.inputSeq).toBeGreaterThan(before);
    });
  });

  describe('terminal replies are filtered out of the signal but NOT out of the PTY', () => {
    it('a DA reply moves neither signal', async () => {
      const session = await liveSession();
      now = 3_000_000;
      session.write(DA_REPLY);
      expect(session.inputSeq).toBe(0);
      expect(session.lastInputAt).toBe(0);
    });

    it('handleUserInput(DA reply) leaves inputSeq unchanged AND writes it to the PTY verbatim', async () => {
      // This is the one way the change could break every attached terminal: applications
      // BLOCK waiting on their DA/DSR answers. Signal-only means signal-only.
      const session = await liveSession();
      session.handleUserInput(DA_REPLY);
      expect(session.inputSeq).toBe(0);
      expect(ptyWrites).toContain(DA_REPLY);
    });

    it('keeps the human residue of a mixed chunk and still writes the whole chunk', async () => {
      const session = await liveSession();
      const chunk = `a${ESC}[12;40Rb`;
      session.write(chunk);
      expect(session.inputSeq).toBe(2); // 'a' + 'b'
      expect(ptyWrites).toContain(chunk);
    });

    it('counts a mouse report — a click can change the composer', async () => {
      const session = await liveSession();
      session.write(`${ESC}[<0;10;5M`);
      expect(session.inputSeq).toBeGreaterThan(0);
    });
  });

  describe('handleUserInput still drives composing/submit', () => {
    it('records input and marks composing for a plain keystroke', async () => {
      const session = await liveSession();
      now = 4_000_000;
      session.handleUserInput('h');
      expect(session.composing).toBe(true);
      expect(session.inputSeq).toBe(1);
      expect(session.lastInputAt).toBe(4_000_000);
    });

    it('clears composing on Enter and still counts the Enter as input', async () => {
      const session = await liveSession();
      session.handleUserInput('hi');
      session.handleUserInput('\r');
      expect(session.composing).toBe(false);
      expect(session.inputSeq).toBe(3);
    });
  });

  describe('the injectable clock', () => {
    it('is what lets a fake gate clock and a real PtySession share a time base', async () => {
      const session = await liveSession();
      now = 500;
      session.write('k');
      expect(session.lastInputAt).toBe(500);
      now = 900;
      expect(session.isUserIdle(300)).toBe(true);
      expect(session.isUserIdle(500)).toBe(false);
    });
  });
});
