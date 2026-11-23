/**
 * Tower's real dependencies for the orphan listing (#1915): its sessions, its
 * job helper, its own and its IDE server's pids, and the process census.
 */

import type { SessionManager } from '../../terminal/session-manager.js';
import { getTowerJobHelper, sessionJobName } from '../../lib/platform/windows/job-objects.js';
import { shellperTransport } from '../../lib/platform/shellper-transport.js';
import { readIdeRecord } from '../lib/ide-record.js';
import { listProcessCensus } from './process-census.js';
import { getTerminalManager, getWorkspaceTerminals } from './tower-terminals.js';
import type { OrphanDeps, OrphanSessionRef } from './session-orphans.js';
import type { SessionKind } from '../lib/session-orphans-api.js';

/** Every shellper-backed session in Tower's workspace registry, with its job name. */
export function towerOrphanSessions(shellperManager: SessionManager | null): OrphanSessionRef[] {
  const sessions: OrphanSessionRef[] = [];
  const terminals = getTerminalManager();
  for (const [workspacePath, entry] of getWorkspaceTerminals()) {
    const groups: Array<[SessionKind, Map<string, string>]> = [
      ['architect', entry.architects],
      ['builder', entry.builders],
      ['shell', entry.shells],
    ];
    for (const [kind, byName] of groups) {
      for (const [agent, terminalId] of byName) {
        const pty = terminals.getSession(terminalId);
        if (!pty || !pty.shellperBacked || pty.shellperSessionId === null) continue;
        const info = shellperManager?.getSessionInfo(pty.shellperSessionId) ?? null;
        const rootPid = info?.pid ?? pty.pid;
        if (!Number.isInteger(rootPid) || rootPid <= 0) continue;
        sessions.push({ workspacePath, terminalId, agent, kind, rootPid, jobName: sessionJobName(info?.shellperSessionId ?? pty.shellperSessionId) });
      }
    }
  }
  return sessions;
}

export function createTowerOrphanDeps(getShellperManager: () => SessionManager | null): OrphanDeps {
  return {
    helper: () => getTowerJobHelper(),
    sessions: () => towerOrphanSessions(getShellperManager()),
    infrastructurePids: () => {
      const pids = [process.pid];
      const helperPid = getTowerJobHelper()?.pid;
      if (typeof helperPid === 'number') pids.push(helperPid);
      const idePid = readIdeRecord()?.pid;
      if (typeof idePid === 'number' && idePid > 0) pids.push(idePid);
      // Every live shellper this Tower manages, registered in a workspace or not.
      const manager = getShellperManager();
      if (manager) {
        for (const id of manager.listSessions().keys()) {
          const pid = manager.getSessionInfo(id)?.pid;
          if (typeof pid === 'number' && pid > 0) pids.push(pid);
        }
      }
      return pids;
    },
    census: () => listProcessCensus(),
    shellperJobName: (cmdline) => shellperTransport().sessionJobName(cmdline),
  };
}
