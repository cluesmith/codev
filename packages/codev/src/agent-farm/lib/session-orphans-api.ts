/**
 * The orphaned-process listing between Tower and `afx status` / `codev doctor`
 * (#1915). Read-only: orphans end with their session (closing it, or
 * `afx cleanup`). Windows only: elsewhere Tower answers `supported: false`.
 */

import type { ListedProcess, OrphanProcess } from '../../lib/platform/windows/session-orphans.js';

export type { ListedProcess, OrphanProcess };

export type SessionKind = 'architect' | 'builder' | 'shell';

export interface SessionOrphans {
  workspacePath: string;
  terminalId: string;
  /** Builder id, architect name, or shell name. */
  agent: string;
  kind: SessionKind;
  /** False when the session has no job, so its orphans cannot be listed. */
  job: boolean;
  /** Why this session could not be checked. */
  error?: string;
  orphans: OrphanProcess[];
}

export interface OrphansListing {
  supported: boolean;
  sessions: SessionOrphans[];
}
