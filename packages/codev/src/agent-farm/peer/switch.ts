/**
 * The remote-messaging switch (Spec 1967; approved spec Decision 4, "The switch").
 *
 * One switch covers sending and receiving. It starts off: a fresh install, and one just
 * upgraded, read it as off (`peer/store.ts`). While it is off this Tower makes no relay call
 * and accepts none. Turning it on is a human's act, made with the flag `porch approve` takes
 * (Decision 9); turning it off only narrows access and needs nothing.
 *
 * The switch is read by the receiving checks (phase 6) and the sending checks (phase 8);
 * phase 7 adds telling Codev Cloud when it changes. This module only reads and sets it.
 */

import type Database from 'better-sqlite3';
import type { PeerSwitchState } from '@cluesmith/codev-types';
import { readRemoteMessaging, writeRemoteMessaging, type RemoteMessagingSetting } from './store.js';

/**
 * The flag that marks a trust-widening act as a human's (Decision 9): `afx peer on` and
 * `afx peer grant` take it, as `porch approve` does. A convention, not a barrier
 * (Decision 4): role files tell agents not to run these unprompted.
 */
export const HUMAN_APPROVAL_FLAG = '--a-human-explicitly-approved-this';

/** What a request to set the switch did. */
export interface SwitchChange {
  state: PeerSwitchState;
  /** False when the switch was already in the state asked for; nothing is written then. */
  changed: boolean;
  /** When a human last turned it on or off; `null` if never. */
  changedAt: number | null;
}

/** The switch as it stands. */
export function readSwitch(db: Database.Database): RemoteMessagingSetting {
  return readRemoteMessaging(db);
}

/** Is remote messaging on? Off unless a human has turned it on. */
export function isRemoteMessagingOn(db: Database.Database): boolean {
  return readRemoteMessaging(db).state === 'on';
}

/**
 * Turn the switch on or off. Asking for the state it is already in changes nothing, so the
 * time it last changed stays the time a human last changed it. Whether the caller may turn
 * it on is the route's check, not this function's.
 */
export function setSwitch(db: Database.Database, state: PeerSwitchState, now: number): SwitchChange {
  return db.transaction((): SwitchChange => {
    const current = readRemoteMessaging(db);
    if (current.state === state) return { state, changed: false, changedAt: current.changedAt };
    writeRemoteMessaging(db, state, now);
    return { state, changed: true, changedAt: now };
  })();
}
