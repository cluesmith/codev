/**
 * Spec 1313 — architect delivery regression (the shellper-backed identity seam).
 *
 * The #1265 corruption repro (send-mailbox-repro.test.ts) proved the render-gate
 * against a *command-populated double* — a plain object with `command` set. That
 * left a real gap green: shellper-backed sessions are created via
 * `TerminalManager.createSessionRaw`, which used to hardcode `command: ''`. So
 * `resolveProfileForSession` fell back to reading `.builder-start.sh` — a file
 * only builder worktrees have. Architects run in the workspace root with no launch
 * script, so they resolved to `null` and EVERY `afx send architect` held
 * `no-profile` and never delivered (the architect is Spec 1313's primary
 * stakeholder — #1265 is literally the architect's draft).
 *
 * These tests drive delivery against a REAL `createSessionRaw`-backed session
 * (fake shellper client for I/O, real ring buffer, real `PtySession.command`
 * getter) through the REAL `resolveProfileForSession` — not a hand-set double —
 * so the seam that was broken is the seam under test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  deliverAgentMail,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
} from '../servers/mailbox-delivery.js';
import { resolveProfileForSession, classifyAgentScreen } from '../servers/mailbox-wiring.js';
import { TerminalManager } from '../../terminal/pty-manager.js';
import type { IShellperClient } from '../../terminal/shellper-client.js';

const COLS = 110;
const ROWS = 32;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Build a raw \r\n-terminated screen from composer lines (mirrors render-gate.test). */
function screen(...lines: string[]): string {
  return lines.map((l) => l + '\r\n').join('');
}
/** A clean claude composer: marker + a dim placeholder only (idle) → gate: clean. */
const CLEAN_SCREEN = screen(`❯ ${DIM}Try "fix the flaky test"${RESET}`, '──────────────────────');

/**
 * The minimal IShellperClient surface `attachShellper` + the delivery write path
 * touch: `lastDataAt` (hydrated once), `connected` (gates `writable`), `write`
 * (the delivery target), and EventEmitter `on`/`removeAllListeners`.
 */
class FakeShellper extends EventEmitter {
  connected = true;
  lastDataAt = 1000;
  writeData: string[] = [];
  write(data: string | Buffer): boolean {
    this.writeData.push(typeof data === 'string' ? data : data.toString('utf-8'));
    return true;
  }
  disconnect(): void { this.connected = false; }
}

/**
 * A real shellper-backed session: `createSessionRaw` (optionally threading the
 * launch command, as the fixed creation sites now do) + `attachShellper` with a
 * fake client whose replay seeds the ring buffer with `initialScreen`.
 */
function makeRealSession(
  manager: TerminalManager,
  cwd: string,
  command: string | undefined,
  initialScreen: string,
): { session: DeliverySession; shellper: FakeShellper } {
  const info = manager.createSessionRaw({ label: 'Architect', cwd, command });
  const session = manager.getSession(info.id)!;
  const shellper = new FakeShellper();
  // Seed the ring buffer via replay so the render-gate has a screen to classify.
  session.attachShellper(shellper as unknown as IShellperClient, Buffer.from(initialScreen), 4242);
  return { session: session as unknown as DeliverySession, shellper };
}

/** Delivery ports bound to the REAL render-gate + REAL resolveProfileForSession. */
function realSeamPorts(
  session: DeliverySession | null,
  writes: Array<{ msg: string; noEnter: boolean }>,
  broadcasts: DeliveredBroadcast[] = [],
): DeliveryPorts {
  return {
    getSessionForAgent: () => session,
    // The seam under test: production resolution (direct command → profile, then
    // the `.builder-start.sh` fallback), NOT the pure `resolveProfile` the #1265
    // repro used against a command-populated double.
    resolveProfile: (s) => resolveProfileForSession(s),
    // The REAL production classify seam (Spec 1313 round 2): read the session's persistent
    // mirror (seeded here via attachShellper's replay) and classify its viewport.
    classify: (s, prof) => classifyAgentScreen(s, prof),
    writeMessage: (s, msg, noEnter) => {
      writes.push({ msg, noEnter });
      s.write(msg); // drive the real session's write path (fake shellper records it)
      return true; // the write landed (Spec 1313: writeMessage reports delivery success)
    },
    broadcast: (f) => broadcasts.push(f),
    onHeldStateChange: () => {},
    onEscalation: () => {},
    onLiveness: () => {},
    log: () => {},
    now: () => 1000,
  };
}

describe('Spec 1313 — architect (shellper-backed) delivery regression', () => {
  let db: Database.Database;
  let manager: TerminalManager;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    // A workspace-root-shaped cwd with NO `.builder-start.sh` — exactly an
    // architect terminal. The launch-script fallback must return null here, so
    // the ONLY thing that can resolve the profile is the threaded command.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-identity-'));
    manager = new TerminalManager({ workspaceRoot: tmpDir });
  });
  afterEach(() => {
    manager.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    db.close();
  });

  function enqueue(body = 'ship it', formatted = '[architect:main] ship it') {
    return mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'main', body, formattedMessage: formatted },
      1000,
    );
  }

  it('THE FIX: a threaded command makes a real architect session resolve + deliver on a clean prompt', async () => {
    const { session, shellper } = makeRealSession(manager, tmpDir, 'claude', CLEAN_SCREEN);

    // The identity seam is real: createSessionRaw put the command on the session,
    // and production resolution (no launch script in cwd) now returns the CLAUDE
    // profile specifically. `.app` (not `.not.toBeNull()`) — CLAUDE_PROFILE and
    // CODEX_PROFILE share marker/region patterns, so a null-check can't tell a
    // correct mapping from a claude↔codex mix-up.
    expect(session.command).toBe('claude');
    expect(resolveProfileForSession(session)?.app).toBe('claude');

    const writes: Array<{ msg: string; noEnter: boolean }> = [];
    const row = enqueue();
    const result = await deliverAgentMail(realSeamPorts(session, writes), db, '/ws/a', 'main');

    expect(result.delivered).toEqual([row.id]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    expect(writes).toEqual([{ msg: '[architect:main] ship it', noEnter: false }]);
    // The message actually reached the real session's write path.
    expect(shellper.writeData.join('')).toContain('[architect:main] ship it');
  });

  it('a codex architect resolves the CODEX profile (strict mapping, not a claude fallback) and delivers', async () => {
    const { session } = makeRealSession(manager, tmpDir, 'codex', CLEAN_SCREEN);

    // The gate must map `codex` → CODEX_PROFILE, not silently to claude. This is
    // the constraint-10 invariant: identity is strict, never guessed toward claude.
    expect(resolveProfileForSession(session)?.app).toBe('codex');

    const writes: Array<{ msg: string; noEnter: boolean }> = [];
    const row = enqueue('deploy', '[architect:main] deploy');
    const result = await deliverAgentMail(realSeamPorts(session, writes), db, '/ws/a', 'main');
    expect(result.delivered).toEqual([row.id]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
  });

  it('THE BUG (locked): without a threaded command, a real architect session holds no-profile forever', async () => {
    // Reproduces the pre-fix state: createSessionRaw with no command → command ''
    // → and no `.builder-start.sh` in cwd → resolveProfileForSession === null.
    const { session } = makeRealSession(manager, tmpDir, undefined, CLEAN_SCREEN);

    expect(session.command).toBe('');
    expect(resolveProfileForSession(session)).toBeNull();

    const writes: Array<{ msg: string; noEnter: boolean }> = [];
    const row = enqueue();
    const result = await deliverAgentMail(realSeamPorts(session, writes), db, '/ws/a', 'main');

    // A clean-looking prompt is NOT enough: an unresolved identity is held, never guessed.
    expect(result.reason).toBe('no-profile');
    expect(result.delivered).toEqual([]);
    expect(writes).toHaveLength(0);
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
    expect(mailbox.getById(db, row.id)?.reason).toBe('no-profile');
  });

  it('RESTART-SAFE: the launch command round-trips through terminal_sessions so reconcile can restore it', () => {
    // Architects have no launch-script backstop, so surviving a Tower restart
    // depends on the command persisting on the session row (v16). Prove the
    // column round-trips, then that a session rebuilt from it (as the reconcile
    // path does) resolves — i.e. delivery survives restart.
    db.prepare(`
      INSERT INTO terminal_sessions (id, workspace_path, type, role_id, pid, label, cwd, command)
      VALUES (?, ?, 'architect', 'main', 4242, 'Architect', ?, 'claude')
    `).run('t-1', '/ws/a', tmpDir);

    const restored = db.prepare('SELECT command, cwd FROM terminal_sessions WHERE id = ?')
      .get('t-1') as { command: string | null; cwd: string | null };
    expect(restored.command).toBe('claude');

    // Reconstruct exactly as the reconcile path does: createSessionRaw with the
    // persisted command → the render-gate can resolve it again post-restart.
    const { session } = makeRealSession(manager, restored.cwd!, restored.command ?? undefined, CLEAN_SCREEN);
    expect(session.command).toBe('claude');
    expect(resolveProfileForSession(session)?.app).toBe('claude');
  });
});

// ============================================================================
// Source-level guards (mirrors bugfix-506-annotator-worktree-cwd.test.ts).
// The migration runs inside the getGlobalDb() singleton and the reconcile/
// reconnect self-heal lives deep in Tower wiring — both are impractical to drive
// in isolation, so we pin them at the source, exactly as #506 pins the cwd column.
// These catch the two regressions the CMAP review surfaced: a missing version
// bump, and dropping the legacy-row self-heal.
// ============================================================================
describe('Spec 1313 — migration + self-heal source guards', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf-8');

  it('db migration v16 is registered, bumps the version, and adds the command column', () => {
    const dbSrc = read('../db/index.ts');
    // The version constant MUST advance — else a fresh install records only 1..15
    // and the v16 block only converges on a later open (the omission #23 flagged).
    // It now sits at 17 (Spec 1313 round 3 added the not_before mailbox migration);
    // both v16 and v17 must be registered under it.
    expect(dbSrc).toContain('GLOBAL_CURRENT_VERSION = 17');
    expect(dbSrc).toContain('Migration v16');
    expect(dbSrc).toContain('Migration v17');
    expect(dbSrc).toContain('ALTER TABLE terminal_sessions ADD COLUMN command TEXT');
    // Fresh installs get the column from GLOBAL_SCHEMA, not the migration.
    expect(read('../db/schema.ts')).toMatch(/terminal_sessions[\s\S]*command TEXT/);
    // The migration must not blanket-swallow ALTER failures (a real failure would
    // mark v16 done while leaving saveTerminalSession's INSERT pointing at a
    // missing column). It gates on an actual column-existence check instead.
    const v16Block = dbSrc.slice(dbSrc.indexOf('Migration v16'), dbSrc.indexOf('VALUES (16)'));
    expect(v16Block).toContain('PRAGMA table_info(terminal_sessions)');
  });

  it('reconcile and on-the-fly reconnect heal a legacy NULL command from restartOptions', () => {
    // Pre-existing rows persisted before v16 have command = NULL; the reconstruction
    // paths must fall back to restartOptions.command (cmdParts[0] from live config)
    // so an upgraded architect resolves on the first Tower restart, not never.
    const termSrc = read('../servers/tower-terminals.ts');
    const matches = termSrc.match(/dbSession\.command \?\? restartOptions\?\.command/g) ?? [];
    // Two reconstruction paths (reconcile + on-the-fly). Each computes the heal
    // ONCE, as the `identitySeed` the session starts from.
    //
    // This was four before PIR #1475, when each path also repeated the expression
    // at its re-save. The saves now persist the session's own resolved identity
    // instead — the shellper's WELCOME statement when it made one, else this same
    // seed — so the heal is still what a legacy row falls back to, it just is not
    // re-derived at the save. Asserted positively below.
    expect(matches.length).toBe(2);
    expect(termSrc.match(/const identitySeed = dbSession\.command \?\? restartOptions\?\.command \?\? null;/g) ?? [])
      .toHaveLength(2);
  });

  it('both reconstruction paths persist the session identity, normalized away from empty string', () => {
    // PIR #1475. Two properties this guard exists to keep:
    //
    // 1. The re-saves persist what the session REPORTS (hydrated from WELCOME when
    //    available), falling back to the seed only when there is no PtySession.
    // 2. That value goes through `persistableCommand`, which maps '' to NULL.
    //    `createSessionRaw` defaults command to '' for an unknown agent, and the
    //    heal above is `??`, which does not catch '' — so persisting '' would turn
    //    a healable NULL row into a permanently unhealable one.
    const termSrc = read('../servers/tower-terminals.ts');
    expect(termSrc.match(/ptySession \? persistableCommand\(ptySession\) : identitySeed/g) ?? [])
      .toHaveLength(2);
    expect(read('../servers/tower-utils.ts')).toContain('return session?.command || null;');
  });

  it('the in-place session-reconnected re-attach persists identity too', () => {
    // The one attach site with no row rewrite behind it, and the only one where a
    // FRESH client can bring a changed identity to an existing PtySession — so it
    // needs the update helper rather than a save. Missing it would leave the
    // fallback row drifting with no path back to the truth.
    const serverSrc = read('../servers/tower-server.ts');
    const handler = serverSrc.slice(serverSrc.indexOf("shellperManager.on('session-reconnected'"));
    expect(handler).toContain('updateTerminalCommand(ptySession.id, persistableCommand(ptySession))');
  });
});
