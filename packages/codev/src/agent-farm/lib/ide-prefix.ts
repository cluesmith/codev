/**
 * The IDE forward prefix (Issue #1668 §D1) and its matcher. Dependency-free on
 * purpose: the auth seam (`utils/server-utils.ts`) imports it, and it must stay
 * a light leaf (Issue #1869). `ide-record.ts` re-exports both.
 */

/** The fixed Tower prefix that routes to the IDE server (Issue #1668 §D1). */
export const IDE_DEFAULT_PREFIX = '/ide/';

/** True if `pathname` targets the IDE forward prefix (`/ide` or `/ide/…`, never `/ideas`). */
export function matchIdePrefix(pathname: string): boolean {
  const bare = IDE_DEFAULT_PREFIX.replace(/\/$/, ''); // "/ide"
  return pathname === bare || pathname.startsWith(IDE_DEFAULT_PREFIX);
}
