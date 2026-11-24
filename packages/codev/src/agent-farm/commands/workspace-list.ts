/**
 * `afx workspace list` (Spec 1940, Decision 6)
 *
 * Prints every workspace on this Tower with its architects, builders and shells, each as
 * an address ready to paste into `afx send`, so nobody has to guess one. Tower answers for
 * the caller: this command says who is asking, the way `afx send` says who is sending, and
 * prints what comes back. An agent the caller may not address is still listed, with the
 * way to reach it beside it.
 */

import type { AddressBookAgent, AddressBookResponse, AddressBookWorkspace } from '@cluesmith/codev-types';
import { logger } from '../utils/logger.js';
import { getTowerClient } from '../lib/tower-client.js';
import { architectSenderId, detectCurrentBuilderId, detectWorkspaceRoot } from './send.js';
import { olderTowerError } from '../utils/older-tower.js';

export interface WorkspaceListOptions {
  json?: boolean;
}

const INDENT = '  ';
const GAP = '    ';

/**
 * Text from Tower kept to one printable line. Every field Tower sends goes through it
 * before it is printed, the ones that come from checked sources too: one rule for the
 * whole listing, so no field can start a line of its own.
 */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, '?');
}

/** What an agent with no address is shown as: its short form, marked as not an address. */
function unaddressedLabel(agent: AddressBookAgent): string {
  return `(${agent.kind === 'architect' ? `architect:${oneLine(agent.name)}` : oneLine(agent.name)})`;
}

/** What an agent's line starts with: its address, or its short form marked as not one. */
function agentLabel(agent: AddressBookAgent): string {
  return agent.address === null ? unaddressedLabel(agent) : oneLine(agent.address);
}

/** What a workspace's line starts with. */
function workspaceLabel(workspace: AddressBookWorkspace): string {
  return workspace.addressName === null ? '(no address name)' : oneLine(workspace.addressName);
}

/** What follows `live` / `no live terminal` on an agent's line. Nothing for an address ready to paste. */
function agentNote(agent: AddressBookAgent): string {
  if (agent.sendable) return '';
  if (agent.address === null) return 'no address';
  if (agent.reachThrough !== undefined) return `reach through ${oneLine(agent.reachThrough)}`;
  return 'cannot be sent to from here';
}

function workspaceHeader(workspace: AddressBookWorkspace, nameWidth: number): string {
  const name = workspaceLabel(workspace).padEnd(nameWidth);
  return `${name}${GAP}${oneLine(workspace.path)}${workspace.running ? '' : `${GAP}not running`}`;
}

/**
 * The listing as lines: one block per workspace, one address a line. A line that is only
 * an address and `live` / `no live terminal` is ready to paste; anything the caller cannot
 * send to says so after it.
 */
export function formatAddressBook(book: AddressBookResponse): string[] {
  if (book.workspaces.length === 0) return ['No workspaces are registered with this Tower.'];

  const nameWidth = Math.max(...book.workspaces.map((w) => workspaceLabel(w).length));
  const agents = book.workspaces.flatMap((w) => w.agents);
  const addressWidth = Math.max(0, ...agents.map((a) => agentLabel(a).length));

  const lines: string[] = [];
  for (const workspace of book.workspaces) {
    lines.push(workspaceHeader(workspace, nameWidth));
    if (workspace.addressName === null) {
      lines.push(`${INDENT}no address name: ${oneLine(workspace.unaddressableReason ?? 'Tower gave no reason')}`);
    }
    for (const agent of workspace.agents) {
      const address = agentLabel(agent).padEnd(addressWidth);
      const liveness = agent.live ? 'live' : 'no live terminal';
      const note = agentNote(agent);
      lines.push(`${INDENT}${address}${GAP}${note === '' ? liveness : `${liveness.padEnd('no live terminal'.length)}${GAP}${note}`}`);
    }
  }
  return lines;
}

export async function workspaceList(options: WorkspaceListOptions = {}): Promise<void> {
  // Who is asking, exactly as `afx send` says who is sending: the listing is of what THIS
  // caller may send to. A builder worktree whose id cannot be verified is an error here
  // too, not a reason to ask as somebody else (issue #1094).
  let from: string;
  try {
    from = detectCurrentBuilderId() ?? architectSenderId();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const workspace = detectWorkspaceRoot() ?? undefined;

  const client = getTowerClient();
  if (!(await client.isRunning())) {
    logger.error('Tower is not running. Start it with `afx workspace start` first.');
    process.exit(1);
  }

  const outcome = await client.getAddressBook({ workspace, from });
  if (!outcome.ok) {
    logger.error(outcome.unknownRoute ? olderTowerError('has no address book') : outcome.error);
    process.exit(1);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
    return;
  }
  process.stdout.write(`${formatAddressBook(outcome.result).join('\n')}\n`);
}
