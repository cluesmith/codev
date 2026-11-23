/**
 * The orphaned-process API between Tower and `afx` / `codev doctor` (#1915).
 * Windows only: elsewhere Tower answers `supported: false`.
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

export interface OrphanEndTarget {
  terminalId: string;
  pid: number;
  /** The creation time the listing showed; a pid with another creation time is a different process. */
  createdAt: number;
}

export interface OrphanEndResult extends OrphanEndTarget {
  outcome: 'ended' | 'gone' | 'refused' | 'failed';
  reason?: string;
}

export interface OrphansEndResponse {
  supported: boolean;
  results: OrphanEndResult[];
}
