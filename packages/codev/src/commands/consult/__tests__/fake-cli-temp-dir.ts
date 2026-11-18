/**
 * Removal of a temp dir that held a fake CLI the test just ran (the agy lane suites).
 *
 * On Windows a freshly executed script can stay open in another process for a while
 * after the fake CLI has exited (seen as EBUSY on rmdir under full-suite load, with no
 * fake process left alive). That holder is the host's, not the product's, so on
 * Windows an EBUSY that outlasts the retries leaves the dir to the OS temp cleanup
 * instead of failing the test. Every other error, and every error on POSIX, throws.
 *
 * Asynchronous on purpose (#1922): a synchronous retry loop blocks the event loop, so
 * the lane's just-killed children cannot be reaped while it waits. Windows has also
 * shown EPERM here under full-suite load; its holder is unconfirmed and tracked in #1923.
 */

import fs from 'node:fs';

export async function removeFakeCliTempDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && code === 'EBUSY') {
      console.warn(`left temp dir ${dir}: still held by the host (${code})`);
      return;
    }
    throw err;
  }
}
