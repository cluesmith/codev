/**
 * Parent directory for test socket dirs.
 *
 * spec-1658-tmp: sun_path (POSIX uses /tmp directly, not os.tmpdir(), because
 * macOS per-user tmpdir paths are too long for Unix sockets: sun_path max is
 * about 104 bytes. Windows uses os.tmpdir(): its sockets are named pipes, with
 * no path-length limit tied to the directory.)
 */

import { tmpdir } from 'node:os';

export function socketTempRoot(): string {
  if (process.platform === 'win32') {
    return tmpdir();
  }
  // POSIX: short root for Unix-socket paths (sun_path limit).
  return '/tmp';
}
