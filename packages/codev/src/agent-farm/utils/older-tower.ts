/**
 * What to say when this CLI meets a Tower, or a global.db, from before it.
 *
 * Right after an upgrade every user is in this state: the new CLI is on the path and the
 * Tower that was already running is the old one, with the old routes and a database it
 * has not migrated. The remedy is the same each time, so it is worded once.
 */

/** Restarts Tower. `afx tower stop` exits 0 when Tower is not running, so this also starts one. */
export const TOWER_RESTART_COMMAND = 'afx tower stop && afx tower start';

/** For a route the running Tower does not have. `lacks` finishes "it …": `has no address book`. */
export function olderTowerError(lacks: string): string {
  return `The running Tower is older than this CLI: it ${lacks}. Restart Tower to pick up the new version: ${TOWER_RESTART_COMMAND}`;
}
