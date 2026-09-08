/**
 * Interrupt command — send a bare ESC keystroke into a builder's PTY (Spec 1273).
 *
 * This is the only recovery that reaches a builder *mid-turn*. When a builder
 * chains foreground waits inside one turn, every `afx send` — including the
 * architect's order to stop — queues unread until the turn ends. ESC interrupts
 * the running tool, ends the turn, and the queued messages then process.
 *
 * Verified in production (shannon workspace, 2026-07-27): a builder wedged for
 * 45+ minutes on a wait for a file whose producer had already died resumed
 * within two minutes of receiving ESC. Until now that recipe
 * (`afx send <builder> --raw "$(printf '\x1b')"`) lived only in architect lore
 * and had to be discovered under pressure.
 *
 * Addressing, workspace detection and sender identity are reused verbatim from
 * `afx send` — there is exactly one address resolver. "Verbatim" is literal: the
 * sender comes from `detectCurrentBuilderId()` / `architectSenderId()`, the same two
 * functions `afx send` calls, so one actor has one `from_agent` form across all three
 * commands (issue #1478).
 */

import type { InterruptOptions } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { TowerClient } from '../lib/tower-client.js';
import { detectWorkspaceRoot, detectCurrentBuilderId, architectSenderId } from './send.js';

export async function interrupt(options: InterruptOptions): Promise<void> {
  const target = options.builder;

  if (!target) {
    fatal('Must specify a builder. Usage: afx interrupt <builder>');
  }

  logger.header('Sending Interrupt (ESC)');

  const workspace = detectWorkspaceRoot() ?? undefined;

  // Same identity rule as `afx send`: in a confirmed builder worktree an
  // unverifiable canonical id aborts rather than sending as an unverified
  // sender, which Tower would silently route to 'main' (issue #1094).
  let from: string;
  try {
    from = detectCurrentBuilderId() ?? architectSenderId();
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }

  const client = new TowerClient();
  if (!(await client.isRunning())) {
    fatal('Tower is not running. Start it with: afx tower start');
  }

  try {
    // `message` carries the ESC byte so the route's non-empty validation is
    // satisfied and both this command and the manual `--raw` recipe exercise the
    // same byte. `escape` is what makes delivery immediate and unformatted.
    const result = await client.sendMessage(target, '\x1b', {
      from,
      workspace,
      fromWorkspace: workspace,
      escape: true,
      noEnter: options.noEnter,
    });

    if (!result.ok) {
      throw new Error(result.error || 'Unknown error');
    }

    logger.success(`Interrupt (ESC) sent to ${result.resolvedTo ?? target}`);
    if (!options.noEnter) {
      logger.info('Enter followed the ESC — any messages queued during the turn should now process.');
    }
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}
