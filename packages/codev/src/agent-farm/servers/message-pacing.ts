/**
 * Resolve per-harness message pacing for a target terminal (Issue #1201).
 *
 * Kimi PTYs need a longer delayed-Enter than the message-write defaults (an
 * 80ms Enter is swallowed by paste detection; 1s submits — observed), so every
 * delivery path (`afx send` direct + buffered, cron) resolves pacing before
 * writing.
 *
 * Resolution order:
 *  1. Worktree marker — every Kimi launch shape persists
 *     `.builder-kimi-session` in its cwd (seed/resume write the session id;
 *     the bare no-role/no-prompt shape touches it empty). This is
 *     deliberately checked FIRST: it is override-proof (correct even when the
 *     builder was spawned via `--builder-cmd kimi` against a workspace whose
 *     config says claude) and survives Tower restarts, since it lives on disk
 *     next to the session. The probe is existence-based, NOT content-based —
 *     an empty marker (bare shape) must still resolve Kimi pacing.
 *  2. Config-resolved harness for the terminal's registered role (builder /
 *     architect) in its workspace — covers config-driven spawns and any future
 *     harness that sets `messagePacing`.
 *  3. undefined → message-write defaults.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBuilderHarness, getArchitectHarness } from '../utils/config.js';
import { KIMI_HARNESS, KIMI_SESSION_FILE } from '../utils/harness.js';
import { getTerminalSessionById } from './tower-terminals.js';
import type { MessagePacing } from './message-write.js';

export function resolvePacingForSession(
  session: { id: string; cwd?: string },
): MessagePacing | undefined {
  // Pacing is advisory: any failure here (missing DB, unknown harness name,
  // fs error) must degrade to default pacing, never break message delivery.
  try {
    const row = getTerminalSessionById(session.id);

    // 1. Kimi worktree marker in the terminal's cwd (live session's cwd, else
    //    the persisted row's — a rehydrated session may only have the latter).
    const cwd = session.cwd || row?.cwd || null;
    if (cwd && existsSync(join(cwd, KIMI_SESSION_FILE))) {
      return KIMI_HARNESS.messagePacing;
    }

    // 2. Config-resolved harness for the registered terminal role.
    if (!row?.workspace_path) return undefined;
    if (row.type === 'builder') {
      return getBuilderHarness(row.workspace_path).messagePacing;
    }
    if (row.type === 'architect') {
      return getArchitectHarness(row.workspace_path).messagePacing;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
