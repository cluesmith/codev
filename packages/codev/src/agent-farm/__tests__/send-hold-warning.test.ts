/**
 * Issue #1482 — `afx send` tells the operator when a hold will NOT clear by itself.
 *
 * The held response has always ended "It delivers automatically when the prompt is clear."
 * For a `user-text` hold that is true — a human is at the composer and it clears when they
 * finish. For `no-region-end` / `no-composer-marker` / `no-profile` it is FALSE and
 * misleading: the gate cannot verify that composer at all, and nothing will deliver without
 * intervention. So the CLI adds a warning for exactly that class.
 *
 * The branch is one `if` over `isUnverifiableVerdict`, and it decides whether an operator
 * learns their message is permanently stuck. It is worth pinning on both sides — a warning
 * that fires for the ordinary busy case would train people to ignore it, which is worse than
 * not having it.
 *
 * Mocks the Tower client (the CLI constructs one with no port, so the real thing would reach
 * the developer's live Tower on 4100) and the logger. Everything between them — including the
 * formatter under test — is the real code path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendMessageMock = vi.fn();
const isRunningMock = vi.fn(async () => true);

vi.mock('../lib/tower-client.js', async (importOriginal) => ({
  // Keep every other export real (AGENT_FARM_DIR, DEFAULT_TOWER_PORT, getTowerClient …) —
  // only the client class is replaced, so the CLI cannot reach a live Tower.
  ...(await importOriginal<typeof import('../lib/tower-client.js')>()),
  TowerClient: class {
    isRunning = isRunningMock;
    sendMessage = sendMessageMock;
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    success: vi.fn(), header: vi.fn(), kv: vi.fn(), blank: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(`FATAL: ${msg}`); }),
}));

import { send } from '../commands/send.js';
import { logger } from '../utils/logger.js';

const held = (reason: string, detail: string | undefined) => ({
  ok: true, resolvedTo: 'pir-1482-target', held: true, delivered: false,
  reason, detail, mailboxId: 'row-abc123', bodyLength: 8,
});

/** Every line the CLI printed this run, whatever level it used. */
function output(): string {
  const calls = [
    ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
    ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
  ];
  return calls.map((c) => String(c[0])).join('\n');
}
const warnings = () =>
  (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');

describe('afx send — the unverifiable-hold warning (Issue #1482)', () => {
  // `detectCurrentBuilderId` keys off cwd: inside a `.builders/<id>/` path it insists on
  // resolving a canonical id from global.db and ABORTS if it cannot (#1094 anti-spoofing).
  // The suite runs from the builder worktree that develops this change, so run these cases
  // from a neutral directory — the sender then resolves as `architect`, which is what an
  // operator typing `afx send` in a workspace root actually is.
  const origCwd = process.cwd();
  let neutralDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    isRunningMock.mockResolvedValue(true);
    neutralDir = mkdtempSync(join(tmpdir(), 'send-hold-warning-'));
    process.chdir(neutralDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(neutralDir, { recursive: true, force: true });
  });

  it('shows the verdict as a sub-code on the held line', async () => {
    sendMessageMock.mockResolvedValue(held('busy', 'user-text'));
    await send({ builder: 'pir-1482-target', message: 'hello' });
    expect(output()).toContain('Message held for pir-1482-target (busy:user-text)');
    expect(output()).toContain('mailbox id row-abc123');
  });

  it('does NOT warn when a human is simply at the composer', async () => {
    // The hold is correct and self-clearing. Warning here would be crying wolf.
    sendMessageMock.mockResolvedValue(held('busy', 'user-text'));
    await send({ builder: 'pir-1482-target', message: 'hello' });
    expect(warnings()).not.toContain('could not verify');
  });

  it.each(['no-region-end', 'no-composer-marker'])(
    'DOES warn when the gate could not verify the composer (%s)',
    async (detail) => {
      sendMessageMock.mockResolvedValue(held('busy', detail));
      await send({ builder: 'pir-1482-target', message: 'hello' });
      expect(warnings()).toContain('could not verify that composer');
      expect(warnings()).toContain(detail);
      expect(warnings()).toContain('will not clear by itself');
    }
  );

  it('DOES warn for an unrecognized app (no-profile), which has no detail', async () => {
    // The other member of the defect class, reached via the reason rather than the detail.
    sendMessageMock.mockResolvedValue(held('no-profile', undefined));
    await send({ builder: 'pir-1482-target', message: 'hello' });
    expect(output()).toContain('(no-profile)');
    expect(warnings()).toContain('could not verify that composer');
  });

  it('does NOT warn when there is simply no terminal', async () => {
    // `no-live-pty` is not a classifier failure — a respawned terminal drains the row.
    sendMessageMock.mockResolvedValue(held('no-live-pty', undefined));
    await send({ builder: 'pir-1482-target', message: 'hello' });
    expect(output()).toContain('(no-live-pty)');
    expect(warnings()).not.toContain('could not verify');
  });
});
