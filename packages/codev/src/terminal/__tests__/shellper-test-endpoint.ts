/**
 * Listen/connect addresses for shellper transport tests (Spec 1658).
 *
 * The product hands one resolved endpoint string to both the shellper (listen)
 * and the client (connect): a socket file on POSIX, a `\\.\pipe\` name on
 * Windows (see `resolveShellperEndpoint`). Node's net layer on Windows listens
 * only on named pipes, so a test that binds a `.sock` file path there never
 * listens and its client fails with `connect ENOENT`. These helpers give a test
 * the address the real host transport accepts, used for both sides.
 *
 * This follows the HOST (`process.platform`), not the platform seam: a test may
 * force the seam to either platform to exercise a product branch, but the
 * socket underneath is always the host's own transport.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const onWindowsHost = process.platform === 'win32';

/** A fresh, unguessable pipe name in the test namespace. */
function testPipeName(): string {
  return `\\\\.\\pipe\\codev-test-shellper-${crypto.randomUUID()}`;
}

/** The endpoint for `name` in an existing directory (a pipe on a Windows host). */
export function testEndpointIn(dir: string, name: string): string {
  if (onWindowsHost) {
    return testPipeName();
  }
  return path.join(dir, name);
}

/**
 * A fresh endpoint in its own temp directory (a pipe, with no directory, on a
 * Windows host). Callers remove the socket file and its parent directory as
 * before; both are no-ops for a pipe.
 */
export function tmpTestEndpoint(prefix: string): string {
  if (onWindowsHost) {
    return testPipeName();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'test.sock');
}
