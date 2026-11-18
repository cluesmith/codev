/**
 * Removal of a temp dir that held a fake CLI the test just ran (the agy lane suites).
 *
 * On Windows a freshly executed script can stay open in another process for a while
 * after the fake CLI has exited (seen as EBUSY on rmdir under full-suite load, with no
 * fake process left alive). That holder is the host's, not the product's, so on
 * Windows an EBUSY that outlasts the retries leaves the dir to the OS temp cleanup
 * instead of failing the test. Every other error, and every error on POSIX, throws.
 *
 * Windows also shows EPERM here under full-suite load on a developer machine (#1922):
 * no process referencing the dir was alive when it fired, and the dir was free minutes
 * later. The holder is UNCONFIRMED (real-time AV scanning of the just-written scripts
 * is a suspect, not a finding) and is tracked in #1923. Until it is named, Windows
 * gets a longer bounded retry (~10s, rmSync retries EPERM and EBUSY alike); an EPERM
 * that outlasts it still fails the test.
 */

import fs from 'node:fs';

const RETRY = process.platform === 'win32'
  ? { maxRetries: 50, retryDelay: 200 }
  : { maxRetries: 20, retryDelay: 100 };

export function removeFakeCliTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, ...RETRY });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && code === 'EBUSY') {
      console.warn(`left temp dir ${dir}: still held by the host (${code})`);
      return;
    }
    throw err;
  }
}
