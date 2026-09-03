/**
 * PIR #1475 — WELCOME-frame identity, protocol/shellper/client layers.
 *
 * Session identity (which drives the render gate's classifier-profile lookup, and
 * therefore whether `afx send <agent>` can deliver) used to be inferred from the
 * launch command Tower *recorded*. These tests cover the authoritative source: the
 * argv the shellper actually spawned, carried on every WELCOME.
 *
 * Two properties are load-bearing here and each has a dedicated test:
 *   1. `PROTOCOL_VERSION` must NOT be bumped for this — the client rejects any
 *      shellper older than itself, so a bump would disconnect every live
 *      pre-upgrade shellper on the first Tower restart after an upgrade.
 *   2. Identity is ATOMIC — a shape-invalid payload rejects command AND args
 *      together, so no consumer ever sees a valid command paired with garbage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FrameType,
  PROTOCOL_VERSION,
  createFrameParser,
  encodeHello,
  encodeWelcome,
  encodeSpawn,
  parseJsonPayload,
  type ParsedFrame,
  type WelcomeMessage,
} from '../shellper-protocol.js';
import { ShellperProcess, type IShellperPty, type PtyOptions } from '../shellper-process.js';
import { ShellperClient } from '../shellper-client.js';

// --- Harness ---

class MockPty implements IShellperPty {
  pid = 4242;
  spawnArgs: { command: string; args: string[] } | null = null;
  private exitCallback: ((info: { exitCode: number; signal?: number }) => void) | null = null;

  spawn(command: string, args: string[], _options: PtyOptions): void {
    this.spawnArgs = { command, args };
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): void {}
  onExit(callback: (info: { exitCode: number; signal?: number }) => void): void {
    this.exitCallback = callback;
  }
  simulateExit(exitCode: number): void {
    this.exitCallback?.({ exitCode });
  }
}

function tmpSocketPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'test.sock');
}

/** HELLO/WELCOME against a real ShellperProcess; resolves the parsed WELCOME. */
function handshake(sockPath: string): Promise<{ socket: net.Socket; welcome: WelcomeMessage }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const parser = createFrameParser();
    socket.pipe(parser);
    let done = false;
    parser.on('data', (frame: ParsedFrame) => {
      if (!done && frame.type === FrameType.WELCOME) {
        done = true;
        resolve({ socket, welcome: parseJsonPayload<WelcomeMessage>(frame.payload) });
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(encodeHello({ version: PROTOCOL_VERSION, clientType: 'tower' })));
    setTimeout(() => { if (!done) reject(new Error('handshake timeout')); }, 2000);
  });
}

/**
 * A minimal shellper server that replies to HELLO with a caller-supplied WELCOME
 * payload — including deliberately malformed ones, hence the `unknown` shape.
 */
function miniShellper(socketPath: string, welcome: unknown) {
  const server = net.createServer((socket) => {
    const parser = createFrameParser();
    socket.pipe(parser);
    parser.on('data', (frame: ParsedFrame) => {
      if (frame.type === FrameType.HELLO) {
        socket.write(encodeWelcome(welcome as WelcomeMessage));
      }
    });
  });
  server.listen(socketPath);
  return {
    close: () => {
      server.close();
      try { fs.unlinkSync(socketPath); } catch { /* noop */ }
      try { fs.rmdirSync(path.dirname(socketPath)); } catch { /* noop */ }
    },
  };
}

const BASE_WELCOME = { version: PROTOCOL_VERSION, pid: 1234, cols: 80, rows: 24, startTime: 1_700_000_000_000 };

describe('PIR #1475 — WELCOME identity: protocol', () => {
  it('round-trips command and args through encode/parse', () => {
    const frame = encodeWelcome({ ...BASE_WELCOME, command: 'claude', args: ['--resume', 'abc'] });
    const parser = createFrameParser();
    const parsed: ParsedFrame[] = [];
    parser.on('data', (f: ParsedFrame) => parsed.push(f));
    parser.write(frame);

    const welcome = parseJsonPayload<WelcomeMessage>(parsed[0].payload);
    expect(welcome.command).toBe('claude');
    expect(welcome.args).toEqual(['--resume', 'abc']);
  });

  it('parses a legacy WELCOME (no identity fields) with both undefined', () => {
    const frame = encodeWelcome(BASE_WELCOME);
    const parser = createFrameParser();
    const parsed: ParsedFrame[] = [];
    parser.on('data', (f: ParsedFrame) => parsed.push(f));
    parser.write(frame);

    const welcome = parseJsonPayload<WelcomeMessage>(parsed[0].payload);
    expect(welcome.command).toBeUndefined();
    expect(welcome.args).toBeUndefined();
  });

  it('does NOT bump PROTOCOL_VERSION', () => {
    // Tripwire, not trivia: ShellperClient rejects any shellper whose version is
    // LOWER than Tower's, so bumping for this additive change would disconnect
    // every live pre-upgrade shellper on the first restart after an upgrade —
    // killing running architect and builder sessions. The identity fields are
    // optional precisely so the version can stay put.
    //
    // If a LATER change legitimately needs a new version, update this assertion
    // deliberately along with a migration story for live shellpers.
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('PIR #1475 — WELCOME identity: ShellperProcess', () => {
  let socketPath: string;
  let shellper: ShellperProcess | null;
  let sockets: net.Socket[];

  beforeEach(() => {
    socketPath = tmpSocketPath('shellper-identity-');
    shellper = null;
    sockets = [];
  });

  afterEach(() => {
    for (const s of sockets) s.destroy();
    shellper?.shutdown();
    try { fs.unlinkSync(socketPath); } catch { /* noop */ }
    try { fs.rmdirSync(path.dirname(socketPath)); } catch { /* noop */ }
  });

  it('reports the argv it actually spawned', async () => {
    const pty = new MockPty();
    shellper = new ShellperProcess(() => pty, socketPath);
    await shellper.start('claude', ['--resume', 'sess-1'], process.cwd(), {}, 80, 24);

    const { socket, welcome } = await handshake(socketPath);
    sockets.push(socket);

    expect(welcome.command).toBe('claude');
    expect(welcome.args).toEqual(['--resume', 'sess-1']);
  });

  it('reports the NEW argv after a SPAWN frame replaces the PTY', async () => {
    // The relaunch case: recording argv in spawnPty (not start) is what makes a
    // replaced PTY report its current identity instead of its original one.
    const ptys: MockPty[] = [];
    shellper = new ShellperProcess(() => { const p = new MockPty(); ptys.push(p); return p; }, socketPath);
    await shellper.start('claude', ['--resume', 'old'], process.cwd(), {}, 80, 24);

    const first = await handshake(socketPath);
    sockets.push(first.socket);
    expect(first.welcome.command).toBe('claude');

    const spawned = new Promise<void>((resolve) => shellper!.once('spawn', () => resolve()));
    first.socket.write(encodeSpawn({ command: 'codex', args: ['--full-auto'], cwd: process.cwd(), env: {} }));
    await spawned;

    const second = await handshake(socketPath);
    sockets.push(second.socket);
    expect(second.welcome.command).toBe('codex');
    expect(second.welcome.args).toEqual(['--full-auto']);
    expect(ptys[ptys.length - 1].spawnArgs?.command).toBe('codex');
  });
});

describe('PIR #1475 — WELCOME identity: ShellperClient hydration', () => {
  let socketPath: string;
  let cleanups: Array<() => void>;

  beforeEach(() => {
    socketPath = tmpSocketPath('shellper-client-identity-');
    cleanups = [];
  });

  afterEach(() => {
    for (const fn of cleanups) fn();
  });

  async function connectWith(welcome: unknown): Promise<ShellperClient> {
    const server = miniShellper(socketPath, welcome);
    cleanups.push(server.close);
    const client = new ShellperClient(socketPath);
    cleanups.push(() => client.disconnect());
    await client.connect();
    return client;
  }

  it('hydrates a valid identity pair', async () => {
    const client = await connectWith({ ...BASE_WELCOME, command: 'claude', args: ['--resume', 'x'] });
    expect(client.welcomeCommand).toBe('claude');
    expect(client.welcomeArgs).toEqual(['--resume', 'x']);
  });

  it('accepts a command with no args as an empty argv, not a rejection', async () => {
    const client = await connectWith({ ...BASE_WELCOME, command: 'codex' });
    expect(client.welcomeCommand).toBe('codex');
    expect(client.welcomeArgs).toEqual([]);
  });

  it('trims a padded command', async () => {
    const client = await connectWith({ ...BASE_WELCOME, command: '  claude  ', args: [] });
    expect(client.welcomeCommand).toBe('claude');
  });

  it('leaves identity null for a legacy shellper (fields omitted)', async () => {
    // The backward-compat path: an older shellper still running from before the
    // upgrade. Consumers must fall back to the persisted command, not break.
    const client = await connectWith(BASE_WELCOME);
    expect(client.welcomeCommand).toBeNull();
    expect(client.welcomeArgs).toBeNull();
  });

  it('completes the handshake for a legacy WELCOME', async () => {
    const client = await connectWith(BASE_WELCOME);
    expect(client.connected).toBe(true);
  });

  // Atomicity: each malformed shape must null out BOTH fields, never leave a
  // usable command paired with an unusable args list.
  const REJECTED: Array<[string, Record<string, unknown>]> = [
    ['non-string command', { command: 42, args: [] }],
    ['empty command', { command: '', args: [] }],
    ['whitespace-only command', { command: '   ', args: [] }],
    ['over-long command', { command: 'c'.repeat(4097), args: [] }],
    ['non-array args', { command: 'claude', args: 'not-an-array' }],
    ['non-string args element', { command: 'claude', args: ['--ok', 7] }],
    ['too many args', { command: 'claude', args: new Array(257).fill('--x') }],
    ['args exceeding the total budget', { command: 'claude', args: ['a'.repeat(512 * 1024 + 1)] }],
  ];

  for (const [label, identity] of REJECTED) {
    it(`rejects both fields atomically: ${label}`, async () => {
      const client = await connectWith({ ...BASE_WELCOME, ...identity });
      expect(client.welcomeCommand).toBeNull();
      expect(client.welcomeArgs).toBeNull();
    });
  }

  it('measures the args budget in UTF-8 BYTES, not UTF-16 code units', async () => {
    // A 3-byte-per-char argv sized just under the budget in `String.length` is
    // ~1.5 MB on the wire. Counting code units would wave it through; counting
    // bytes rejects it. (Consultation follow-up, PIR #1475.)
    const overBudgetInBytes = '☃'.repeat(200 * 1024); // 200K chars = 600 KB
    const client = await connectWith({
      ...BASE_WELCOME, command: 'claude', args: [overBudgetInBytes],
    });
    expect(client.welcomeCommand).toBeNull();
    expect(client.welcomeArgs).toBeNull();
  });

  // The failure this project shipped once was invisible precisely because a
  // rejected payload and a legacy shellper look identical downstream (both land
  // on source=config). A warning at the point of rejection is what makes a
  // recurrence visible; a legacy shellper must NOT produce one, or the log is
  // noise on every pre-upgrade session. (One connection per test: the helper
  // binds a single socket path per `it`.)
  it('warns when it discards an identity the shellper actually STATED', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = await connectWith({ ...BASE_WELCOME, command: 'claude', args: 'not-an-array' });
      expect(client.welcomeCommand).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('discarding WELCOME identity');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent for a legacy shellper that states no identity at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = await connectWith({ ...BASE_WELCOME });
      expect(client.welcomeCommand).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts a REAL architect argv, whose system prompt is several KB in one argument', async () => {
    // Regression, PIR #1475. An earlier revision capped each argument at 4096
    // chars. Architects launch as
    //   claude --session-id <uuid> --append-system-prompt "<entire role doc>"
    // so one argument is several KB — the cap rejected it, and because rejection
    // is atomic the WHOLE identity was dropped. Every architect silently fell
    // back to the recorded command: the precise case this feature exists to make
    // authoritative, and invisible to every other test here.
    //
    // Caught by running the real thing (dev-approval evidence), not by unit
    // tests — hence this one.
    const roleDoc = '# Role: Architect\n'.repeat(400); // ~6.8 KB, the real shape
    const client = await connectWith({
      ...BASE_WELCOME,
      command: '/usr/local/bin/claude',
      args: ['--session-id', 'bd222bbd-d59f-41ed-93b7-89fb8c0262a7', '--append-system-prompt', roleDoc],
    });
    expect(client.welcomeCommand).toBe('/usr/local/bin/claude');
    expect(client.welcomeArgs?.[3]).toBe(roleDoc);
  });

  it('updates identity immediately on spawn(), with no reconnect', async () => {
    // An ordinary SPAWN relaunch never reconnects the socket, so this in-memory
    // refresh is the only thing that keeps identity current until the next
    // WELCOME — which may not come for the life of the session.
    const client = await connectWith({ ...BASE_WELCOME, command: 'claude', args: [] });
    client.spawn({ command: 'codex', args: ['--full-auto'], cwd: process.cwd(), env: {} });
    expect(client.welcomeCommand).toBe('codex');
    expect(client.welcomeArgs).toEqual(['--full-auto']);
  });

  it('does not adopt an identity from a spawn() the shellper never received', async () => {
    // The update sits after the connected guard: a dropped SPAWN must not leave
    // the client claiming an argv that was never sent.
    const client = await connectWith({ ...BASE_WELCOME, command: 'claude', args: [] });
    client.disconnect();
    client.spawn({ command: 'codex', args: [], cwd: process.cwd(), env: {} });
    expect(client.welcomeCommand).toBe('claude');
  });

  it('accepts a WELCOME carrying unknown future fields (forward compat)', async () => {
    // The mirror of the legacy case: an old Tower JSON.parses a newer shellper's
    // extra keys and ignores them. Asserted here from the parse side, since that
    // is the behavior a new field must not break.
    const client = await connectWith({ ...BASE_WELCOME, command: 'claude', args: [], somethingNew: { a: 1 } });
    expect(client.connected).toBe(true);
    expect(client.welcomeCommand).toBe('claude');
  });
});
