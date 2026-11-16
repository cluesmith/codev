/**
 * Issue #1482 — resize truth: Tower must not believe a geometry the process never adopted.
 *
 * The render gate classifies a headless mirror of the session's screen, and its verdict is
 * only meaningful if that mirror wraps the way the real TUI does. `PtySession.resize()` used to
 * assign `this.cols`/`this.rows` and resize the mirror on ENTRY, before finding out whether the
 * resize could reach the process — and every caller discarded the boolean that said it could
 * not. A dropped shellper write therefore moved Tower's dimensions and the classification
 * mirror while the kernel winsize, and with it the app's own layout, stayed put. The composer's
 * bounding rule then lands on a different row of the re-wrapped mirror, `findRegionEnd` returns
 * -1, and every message to that agent holds `busy`/`no-region-end` indefinitely.
 *
 * These tests pin the corrected contract:
 *   - applied dimensions move ONLY on a resize that landed;
 *   - the request is not lost when it does not land (spawn and re-attach still honour it);
 *   - the gate mirror never sits at a geometry the process did not take;
 *   - a shellper's WELCOME geometry — the one real measurement available — is adopted on attach.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PtySession, type PtySessionConfig } from '../pty-session.js';
import type { IShellperClient } from '../shellper-client.js';

interface FakeClient extends IShellperClient {
  connectedState: boolean;
  /** Whether `resize()` reports the frame as sent — the #1198 drop signal. */
  resizeLands: boolean;
  /** Every geometry the session asked this client to apply, landed or not. */
  resizeCalls: Array<{ cols: number; rows: number }>;
  setWelcomeGeometry(cols: number | null, rows: number | null): void;
}

function makeFakeClient(): FakeClient {
  const emitter = new EventEmitter() as unknown as FakeClient;
  let welcomeCols: number | null = null;
  let welcomeRows: number | null = null;
  emitter.connectedState = true;
  emitter.resizeLands = true;
  emitter.resizeCalls = [];
  Object.defineProperty(emitter, 'lastDataAt', { get: () => Date.now() });
  Object.defineProperty(emitter, 'connected', { get: () => emitter.connectedState });
  Object.defineProperty(emitter, 'welcomeCols', { get: () => welcomeCols });
  Object.defineProperty(emitter, 'welcomeRows', { get: () => welcomeRows });
  emitter.setWelcomeGeometry = (c, r) => {
    welcomeCols = c;
    welcomeRows = r;
  };
  emitter.write = () => emitter.connectedState;
  emitter.resize = (cols: number, rows: number) => {
    emitter.resizeCalls.push({ cols, rows });
    return emitter.resizeLands;
  };
  return emitter;
}

function makeSession(cols = 80, rows = 24): PtySession {
  const config: PtySessionConfig = {
    id: 'sess-resize',
    command: '',
    args: [],
    cols,
    rows,
    cwd: '/tmp',
    env: {},
    label: 'test',
    logDir: '/tmp',
    diskLogEnabled: false, // avoid touching the filesystem
  };
  return new PtySession(config);
}

/** Attach a client and give the session an output byte, which is what creates the gate mirror. */
function attachWithOutput(session: PtySession, client: FakeClient, seed = 'hello\n'): void {
  session.attachShellper(client, Buffer.from(seed), 4242);
}

describe('PtySession.resize commits only what landed (Issue #1482)', () => {
  it('a landed resize moves the applied dimensions and the gate mirror', () => {
    const session = makeSession();
    const client = makeFakeClient();
    attachWithOutput(session, client);

    expect(session.resize(139, 63)).toBe(true);

    expect(session.info.cols).toBe(139);
    expect(session.info.rows).toBe(63);
    expect(session.gateScreen?.cols).toBe(139);
    expect(session.gateScreen?.rows).toBe(63);
  });

  it('a DROPPED resize leaves both the dimensions and the gate mirror untouched', () => {
    // The defect in one test. A dead shellper socket reports the frame as dropped; before
    // #1482 the session had already assigned the new geometry and re-wrapped the mirror,
    // and the gate then classified a screen the app never drew.
    const session = makeSession();
    const client = makeFakeClient();
    attachWithOutput(session, client);
    session.resize(139, 63); // establish a known-applied geometry
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    client.resizeLands = false;
    expect(session.resize(100, 40)).toBe(false);

    expect(session.info.cols).toBe(139);
    expect(session.info.rows).toBe(63);
    expect(session.gateScreen?.cols).toBe(139);
    expect(session.gateScreen?.rows).toBe(63);
    warn.mockRestore();
  });

  it('a resize with no live client is dropped, not committed', () => {
    // No shellper and no node-pty: `status === 'running'` is true but there is nothing to
    // resize. The old code committed anyway.
    const session = makeSession();
    expect(session.resize(120, 50)).toBe(false);
    expect(session.info.cols).toBe(80);
    expect(session.info.rows).toBe(24);
  });

  it('a dropped resize is still REMEMBERED and re-applied once a connection exists', () => {
    // Declining to commit must not mean discarding the request — that would trade one silent
    // wrong geometry for a silently ignored viewer.
    const session = makeSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Nothing attached yet: the request is recorded but cannot land.
    expect(session.resize(139, 63)).toBe(false);
    expect(session.info.cols).toBe(80);

    // A shellper connects, reporting the geometry it currently has.
    const client = makeFakeClient();
    client.setWelcomeGeometry(80, 24);
    attachWithOutput(session, client);

    // The pending request was re-sent on attach and, having landed, is now applied.
    expect(client.resizeCalls).toContainEqual({ cols: 139, rows: 63 });
    expect(session.info.cols).toBe(139);
    expect(session.info.rows).toBe(63);
    expect(session.gateScreen?.cols).toBe(139);
    warn.mockRestore();
  });
});

describe('PtySession adopts the shellper WELCOME geometry on attach (Issue #1482)', () => {
  it('adopts the reported geometry over its own belief and warns', () => {
    // The post-restart case: Tower's dimensions come back from the database, the shellper's
    // come from the kernel. A measurement beats a memory.
    const session = makeSession(104, 101);
    const client = makeFakeClient();
    client.setWelcomeGeometry(139, 63);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    attachWithOutput(session, client);

    expect(session.info.cols).toBe(139);
    expect(session.info.rows).toBe(63);
    // The mirror is seeded AFTER the adoption, so it renders the replay at the real geometry.
    expect(session.gateScreen?.cols).toBe(139);
    expect(session.gateScreen?.rows).toBe(63);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dimension divergence on attach'));
    warn.mockRestore();
  });

  it('keeps its own geometry when the shellper reports none (older shellper)', () => {
    const session = makeSession(104, 101);
    const client = makeFakeClient();
    client.setWelcomeGeometry(null, null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    attachWithOutput(session, client);

    expect(session.info.cols).toBe(104);
    expect(session.info.rows).toBe(101);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('dimension divergence'));
    warn.mockRestore();
  });

  it('says nothing when the shellper agrees with us', () => {
    const session = makeSession(139, 63);
    const client = makeFakeClient();
    client.setWelcomeGeometry(139, 63);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    attachWithOutput(session, client);

    expect(session.info.cols).toBe(139);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
