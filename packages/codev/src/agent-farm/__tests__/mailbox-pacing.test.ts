/**
 * Per-harness message pacing on the mailbox delivery path (Issue #1201).
 *
 * Kimi's paste-detection window swallows an Enter sent 80ms after the message body
 * (the message-write default), so a Kimi builder's mail is typed but never
 * submitted unless delivery uses its ~1s Enter. Spec 1313 made `afx send`
 * mailbox-first, which moved every delivery through `DeliveryPorts.writeMessage` —
 * so that is where pacing is resolved.
 *
 * These tests replace the retired `message-pacing.test.ts`. The old design probed the
 * worktree for a `.builder-kimi` marker, which obliged EVERY launch shape to remember
 * to write one; the bare shape forgot, which is the bug PR #1203's maintainer review
 * found. Pacing now reads the harness out of the generated `.builder-start.sh` — the
 * same signal the render gate resolves, and one that cannot be forgotten because the
 * launcher itself is the artifact.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarnessForSession, resolvePacingForSession, makeDeliveryPorts } from '../servers/mailbox-wiring.js';
import { KIMI_HARNESS, CLAUDE_HARNESS } from '../utils/harness.js';
import type { DeliverySession } from '../servers/mailbox-delivery.js';
import { BRACKETED_PASTE } from '../servers/message-write.js';

/** A delivery session with only the fields pacing resolution reads. */
function session(command: string, cwd: string): DeliverySession {
  return {
    bytesWritten: 0,
    info: { cols: 110, rows: 32 },
    command,
    launchArgs: [],
    cwd,
    writable: true,
    write: () => true,
  };
}

describe('mailbox pacing resolution (Issue #1201)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pacing-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Write a launch script the way spawn-worktree does. */
  function writeLaunchScript(body: string): void {
    const p = join(dir, '.builder-start.sh');
    writeFileSync(p, body, 'utf-8');
    chmodSync(p, '755');
  }

  // A real builder's `command` is the SHELL running .builder-start.sh, never the
  // agent — so the direct check misses and the launch script is what answers.
  it('resolves kimi through the launch script for a wrapped builder', () => {
    writeLaunchScript(KIMI_HARNESS.buildBuilderLaunchScript!({
      worktreePath: dir, baseCmd: 'kimi', roleFragment: "--agent-file '/x/role.md'",
      taskFile: join(dir, '.builder-prompt.txt'), builderId: 'pir-1201',
    }));
    const s = session('/bin/bash', dir);
    expect(resolveHarnessForSession(s)).toBe('kimi');
    expect(resolvePacingForSession(s)).toEqual(KIMI_HARNESS.messagePacing);
    expect(resolvePacingForSession(s)?.enterDelayMs).toBeGreaterThanOrEqual(1000);
  });

  // The bare shape is the one the marker-file design missed (PR #1203 review): an
  // override spawn with no role and no task. It must still pace as kimi.
  it('resolves kimi for the BARE launch shape too — the shape the old marker probe missed', () => {
    writeLaunchScript(KIMI_HARNESS.buildBuilderLaunchScript!({
      worktreePath: dir, baseCmd: 'kimi', roleFragment: '', taskFile: null,
    }));
    expect(resolvePacingForSession(session('/bin/bash', dir))).toEqual(KIMI_HARNESS.messagePacing);
  });

  // The override case the maintainer found: `--builder-cmd kimi` against a workspace
  // whose config says claude. Resolution never consults config — only the generated
  // script — so the override cannot be lost.
  it('is override-proof: config is never consulted, only the generated script', () => {
    writeLaunchScript('#!/bin/bash\ncd "/wt"\nwhile true; do\n  kimi --yolo\ndone\n');
    expect(resolveHarnessForSession(session('/bin/bash', dir))).toBe('kimi');
  });

  it('leaves claude builders on the message-write defaults', () => {
    writeLaunchScript('#!/bin/bash\ncd "/wt"\nwhile true; do\n  claude --dangerously-skip-permissions\ndone\n');
    const s = session('/bin/bash', dir);
    expect(resolveHarnessForSession(s)).toBe('claude');
    expect(CLAUDE_HARNESS.messagePacing).toBeUndefined();
    expect(resolvePacingForSession(s)).toBeUndefined();
  });

  it('resolves an unwrapped session straight from its command', () => {
    expect(resolveHarnessForSession(session('kimi --yolo', dir))).toBe('kimi');
    expect(resolvePacingForSession(session('/opt/bin/kimi', dir))).toEqual(KIMI_HARNESS.messagePacing);
  });

  // Command position matters: the probe must not be fooled by a harness name that
  // appears as an ARGUMENT. The kimi script's own session probe runs
  // `node -e '…KIMI_CODE_HOME…'`, which names kimi inside a string.
  it('matches on command position, not substrings inside arguments', () => {
    writeLaunchScript('#!/bin/bash\nnode -e \'process.env.KIMI_CODE_HOME\'\nclaude\n');
    expect(resolveHarnessForSession(session('/bin/bash', dir))).toBe('claude');
  });

  // Pacing is an optimization, never a precondition for delivery. A prior iteration
  // of this feature caused a 500 on /api/send by not being total; every failure path
  // must degrade to default timing instead of throwing into the delivery path.
  it('is advisory and TOTAL — every failure path degrades to defaults, never throws', () => {
    // No launch script at all.
    expect(resolvePacingForSession(session('/bin/bash', dir))).toBeUndefined();
    // A cwd that does not exist.
    expect(resolvePacingForSession(session('/bin/bash', '/nonexistent/path'))).toBeUndefined();
    // An unrecognized agent.
    writeLaunchScript('#!/bin/bash\nsome-other-agent --flag\n');
    expect(resolvePacingForSession(session('/bin/bash', dir))).toBeUndefined();
    // A RETIRED built-in name still resolves as a name but has no provider — the
    // lookup must return undefined rather than dereferencing nothing (#1338).
    expect(resolveHarnessForSession(session('gemini', dir))).toBe('gemini');
    expect(resolvePacingForSession(session('gemini', dir))).toBeUndefined();
  });

  // `getBuiltinHarness` uses an own-property check; a bare index would hand back
  // Object.prototype members as bogus "providers" for a user-controlled name.
  it('never treats an inherited Object key as a harness', () => {
    expect(resolvePacingForSession(session('constructor', dir))).toBeUndefined();
    expect(resolvePacingForSession(session('toString', dir))).toBeUndefined();
  });
});

/**
 * The resolver being correct is not the same as the resolver being WIRED.
 *
 * That distinction is not theoretical here: this seam has silently come unwired twice. Issue
 * #1365 replaced `writeMessagePaced` with `submitMessagePaced` and moved the parameter list;
 * Issue #1567 then inserted `strategy` into the exact slot pacing had occupied. Both times every
 * test in the block above kept passing, because they all call `resolvePacingForSession` directly
 * and none of them go through the port the delivery path actually uses.
 *
 * So this exercises the real binding — `makeDeliveryPorts().writeMessage` — and observes the wire,
 * not an argument. It costs about a second of real time, which is the price of testing a delay.
 */
describe('pacing is wired into the delivery port, not merely resolvable', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pacing-wire-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A session that records when each write reached the "PTY". */
  function recordingSession(cwd: string) {
    const writes: Array<{ data: string; at: number }> = [];
    const s = {
      id: 'terminal-under-test',
      bytesWritten: 0,
      info: { cols: 110, rows: 32 },
      command: '/bin/bash .builder-start.sh',
      launchArgs: [],
      cwd,
      writable: true,
      lastDataAt: 0,
      write: (data: string) => { writes.push({ data, at: Date.now() }); return true; },
    };
    return { session: s as unknown as DeliverySession, writes };
  }

  /** Gap between the last body write and the Enter that submits it. */
  async function enterGapMs(cwd: string): Promise<number> {
    const { session: sess, writes } = recordingSession(cwd);
    const ports = makeDeliveryPorts(() => {});
    // A long frame — the branch a real formatted `afx send` takes, and the one whose Enter
    // delay (PASTE_ENTER_DELAY_MS = 80) is exactly the value Kimi swallows.
    const body = 'line one\nline two\nline three\nline four';
    const result = await ports.writeMessage(sess, body, false, () => null, BRACKETED_PASTE);
    expect(result).toEqual({ status: 'written' });
    const enter = writes.at(-1)!;
    expect(enter.data).toBe('\r');
    return enter.at - writes[writes.length - 2]!.at;
  }

  it('a kimi builder gets its ~1s Enter through the real port', async () => {
    writeFileSync(join(dir, '.builder-start.sh'), '#!/bin/bash\nwhile true; do\n  kimi --yolo\ndone\n', 'utf-8');
    chmodSync(join(dir, '.builder-start.sh'), '755');
    const gap = await enterGapMs(dir);
    // Pinned generously against timer jitter: the point is 1000 vs 80, not the exact value.
    expect(gap).toBeGreaterThan(500);
    expect(KIMI_HARNESS.messagePacing?.enterDelayMs).toBe(1000);
  }, 20_000);

  it('a claude builder is left on the default, so pacing is targeted and not global', async () => {
    writeFileSync(join(dir, '.builder-start.sh'), '#!/bin/bash\nwhile true; do\n  claude --foo\ndone\n', 'utf-8');
    chmodSync(join(dir, '.builder-start.sh'), '755');
    const gap = await enterGapMs(dir);
    expect(gap).toBeLessThan(400);
    expect(CLAUDE_HARNESS.messagePacing).toBeUndefined();
  }, 20_000);
});
