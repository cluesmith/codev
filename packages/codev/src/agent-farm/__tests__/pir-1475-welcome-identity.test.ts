/**
 * PIR #1475 — WELCOME identity at the session and delivery seams.
 *
 * Spec 1313 made architect identity restart-SAFE by persisting the launch command
 * on the session row. This makes it AUTHORITATIVE: `PtySession.command` reads
 * through to what the shellper says it actually spawned, and the row becomes a
 * fallback that converges on that truth instead of competing with it.
 *
 * The tests that matter most here are the ones that fail against the obvious-but-
 * wrong implementations:
 *   - identity read through the LIVE client, not snapshotted at attach (a SPAWN
 *     relaunch never re-attaches, so a snapshot silently freezes);
 *   - persisted identity normalized '' -> NULL (persisting '' would convert a
 *     healable legacy row into one that can never resolve a profile again);
 *   - the wrapped builder launch still resolving via `.builder-start.sh`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TerminalManager } from '../../terminal/pty-manager.js';
import type { IShellperClient } from '../../terminal/shellper-client.js';
import { resolveProfileForSession } from '../servers/mailbox-wiring.js';
import { persistableCommand } from '../servers/tower-utils.js';
import { AGY_PROFILE, CLAUDE_PROFILE, CODEX_PROFILE } from '../servers/gate-profiles.js';

/**
 * The client surface these tests touch. Mirrors the production shape: identity is
 * a PAIR that moves together, and `spawn()` refreshes it in place the way
 * `ShellperClient` does when Tower relaunches a PTY without reconnecting.
 */
class FakeShellper extends EventEmitter {
  connected = true;
  lastDataAt = 1000;
  welcomeCommand: string | null;
  welcomeArgs: string[] | null;

  constructor(command: string | null = null, args: string[] | null = null) {
    super();
    this.welcomeCommand = command;
    this.welcomeArgs = command ? (args ?? []) : null;
  }

  write(): boolean { return true; }
  disconnect(): void { this.connected = false; }

  /** Stand-in for a SPAWN relaunch: identity changes, connection does not. */
  spawn(command: string, args: string[] = []): void {
    this.welcomeCommand = command;
    this.welcomeArgs = args;
  }
}

/**
 * A double with NO identity members at all — the `as unknown as IShellperClient`
 * shape used across the existing suites, which yields `undefined` rather than
 * `null`. Consumers must treat it exactly like a legacy shellper.
 */
class LegacyShellper extends EventEmitter {
  connected = true;
  lastDataAt = 1000;
  write(): boolean { return true; }
}

describe('PIR #1475 — PtySession identity precedence', () => {
  let manager: TerminalManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pir1475-session-'));
    manager = new TerminalManager({ workspaceRoot: tmpDir });
  });
  afterEach(() => {
    manager.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function session(command: string | undefined, client: EventEmitter | null) {
    const info = manager.createSessionRaw({ label: 'Architect', cwd: tmpDir, command });
    const s = manager.getSession(info.id)!;
    if (client) s.attachShellper(client as unknown as IShellperClient, Buffer.alloc(0), 4242);
    return s;
  }

  it('prefers the shellper WELCOME identity over the recorded launch command', () => {
    const s = session('codex', new FakeShellper('claude', ['--resume', 'x']));
    expect(s.command).toBe('claude');
    expect(s.launchArgs).toEqual(['--resume', 'x']);
    expect(s.identitySource).toBe('welcome');
  });

  it('falls back to the recorded command for a legacy shellper', () => {
    const s = session('claude', new LegacyShellper());
    expect(s.command).toBe('claude');
    expect(s.identitySource).toBe('config');
  });

  it('falls back for a local (non-shellper) session', () => {
    const s = session('claude', null);
    expect(s.command).toBe('claude');
    expect(s.identitySource).toBe('config');
  });

  it('falls back again after the shellper is detached', () => {
    const s = session('codex', new FakeShellper('claude'));
    expect(s.identitySource).toBe('welcome');
    s.detachShellper();
    expect(s.command).toBe('codex');
    expect(s.identitySource).toBe('config');
  });

  it('tracks a SPAWN relaunch with no re-attach and no reconnect', () => {
    // The regression this design exists to prevent. A snapshot taken at
    // attachShellper passes every other test in this file and fails only here,
    // because #1149 (crash-loop fallback) and #1264 (clean-exit rerun) both
    // re-spawn through the SAME client — attachShellper never runs again.
    const client = new FakeShellper('claude', ['--resume', 'old']);
    const s = session('claude', client);
    expect(s.command).toBe('claude');

    client.spawn('agy', ['--fresh']);

    expect(s.command).toBe('agy');
    expect(s.launchArgs).toEqual(['--fresh']);
    expect(resolveProfileForSession(s)).toBe(AGY_PROFILE);
  });

  it('keeps a legitimately empty argv instead of falling back to config args', () => {
    // Command and args resolve as one unit: having a hydrated command means the
    // hydrated args are the truth, even when that truth is "no arguments".
    const info = manager.createSessionRaw({ label: 'A', cwd: tmpDir, command: 'codex', args: ['--stale'] });
    const s = manager.getSession(info.id)!;
    s.attachShellper(new FakeShellper('claude', []) as unknown as IShellperClient, Buffer.alloc(0), 1);
    expect(s.launchArgs).toEqual([]);
  });
});

describe('PIR #1475 — profile resolution through the real seam', () => {
  let manager: TerminalManager;
  let tmpDir: string;

  beforeEach(() => {
    // Workspace-root shaped: NO `.builder-start.sh`, so the launch-script backstop
    // returns null and identity is the only thing that can resolve a profile.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pir1475-profile-'));
    manager = new TerminalManager({ workspaceRoot: tmpDir });
  });
  afterEach(() => {
    manager.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function attached(command: string | undefined, client: EventEmitter, cwd = tmpDir) {
    const info = manager.createSessionRaw({ label: 'Architect', cwd, command });
    const s = manager.getSession(info.id)!;
    s.attachShellper(client as unknown as IShellperClient, Buffer.alloc(0), 4242);
    return s;
  }

  it('resolves the RUNNING app when the persisted command is wrong', () => {
    // The headline case. Before this change the row decided, and a session whose
    // row said `codex` resolved CODEX_PROFILE while actually running agy — whose
    // screens classify by an entirely different rule.
    const s = attached('codex', new FakeShellper('agy'));
    expect(resolveProfileForSession(s)).toBe(AGY_PROFILE);
  });

  it('resolves the running app when a legacy NULL row was healed to the wrong harness', () => {
    // The concrete live drift: a pre-v16 row heals from the CURRENT config, so an
    // architect launched under the old config and adopted after a config edit gets
    // healed to the new harness while still running the old one.
    const s = attached('codex', new FakeShellper('claude'));
    expect(resolveProfileForSession(s)).toBe(CLAUDE_PROFILE);
  });

  it('falls back to the persisted command for a legacy shellper', () => {
    const s = attached('codex', new LegacyShellper());
    expect(resolveProfileForSession(s)).toBe(CODEX_PROFILE);
  });

  it('still resolves a wrapped builder launch via .builder-start.sh', () => {
    // No-regression: a builder's shellper genuinely spawned the wrapper script, so
    // WELCOME reports `/bin/bash` — same as the row — and the launch-script
    // backstop is what identifies the harness. Hydration must not disturb this.
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pir1475-builder-'));
    const scriptPath = path.join(worktree, '.builder-start.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\nexec claude --dangerously-skip-permissions\n', { mode: 0o755 });
    try {
      const s = attached('/bin/bash', new FakeShellper('/bin/bash', [scriptPath]), worktree);
      expect(s.identitySource).toBe('welcome');
      expect(s.command).toBe('/bin/bash');
      expect(resolveProfileForSession(s)).toBe(CLAUDE_PROFILE);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('documents that a garbled-but-recognizable command still resolves a real profile', () => {
    // NOT a fail-safe claim — the opposite. `resolveProfile` matches by substring
    // (detectHarnessFromCommand: basename.includes('claude')), so a nonsense
    // command containing a known harness name resolves that harness's profile
    // rather than null. Validation of the WELCOME payload is about SHAPE
    // coherence; what makes the value trustworthy is its provenance (an
    // owner-only socket from a PID-validated shellper), not this lookup failing
    // closed. Pinned so the seam is visible if the profile table ever diverges.
    const s = attached('codex', new FakeShellper('not-really-claude-xyz'));
    expect(resolveProfileForSession(s)).toBe(CLAUDE_PROFILE);
  });
});

describe('PIR #1475 — persistable identity', () => {
  let manager: TerminalManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pir1475-persist-'));
    manager = new TerminalManager({ workspaceRoot: tmpDir });
  });
  afterEach(() => {
    manager.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalizes an unknown command to NULL so the legacy self-heal survives', () => {
    // A legacy NULL row adopted with a legacy shellper: createSessionRaw defaults
    // to '', and `'' ?? x` is '' — so persisting the raw value would replace a
    // healable NULL with a value the heal can never displace.
    const info = manager.createSessionRaw({ label: 'Architect', cwd: tmpDir, command: undefined });
    const s = manager.getSession(info.id)!;
    s.attachShellper(new LegacyShellper() as unknown as IShellperClient, Buffer.alloc(0), 1);

    expect(s.command).toBe('');
    expect(persistableCommand(s)).toBeNull();
  });

  it('persists the hydrated identity when the shellper stated one', () => {
    const info = manager.createSessionRaw({ label: 'Architect', cwd: tmpDir, command: 'codex' });
    const s = manager.getSession(info.id)!;
    s.attachShellper(new FakeShellper('claude') as unknown as IShellperClient, Buffer.alloc(0), 1);
    expect(persistableCommand(s)).toBe('claude');
  });

  it('persists the recorded command when there is no hydrated identity', () => {
    const info = manager.createSessionRaw({ label: 'Architect', cwd: tmpDir, command: 'codex' });
    const s = manager.getSession(info.id)!;
    s.attachShellper(new LegacyShellper() as unknown as IShellperClient, Buffer.alloc(0), 1);
    expect(persistableCommand(s)).toBe('codex');
  });

  it('handles a missing session without inventing a value', () => {
    expect(persistableCommand(null)).toBeNull();
    expect(persistableCommand(undefined)).toBeNull();
  });
});
