/**
 * Whether a test may stop the Tower on its port (#1922): only when the port is held
 * exclusively by the PIDs of the Tower that test started. Unknown listeners (`null`, the
 * query failed), no listeners, or any foreign PID all mean "do not stop": the
 * developer's live Tower is never a test's to stop.
 */
export function holdsOnlyOwnTower(listeners: number[] | null, ownPids: readonly number[]): boolean {
  if (listeners === null || listeners.length === 0 || ownPids.length === 0) return false;
  return listeners.every((pid) => ownPids.includes(pid));
}
