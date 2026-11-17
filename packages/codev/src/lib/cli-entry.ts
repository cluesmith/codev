/**
 * Whether `codev` was run as a command, not imported (by `consult`, `team` or a
 * test). `bin/codev.js` imports `dist/cli.js`, so `process.argv[1]` names the bin.
 *
 * On Windows `process.argv[1]` uses backslashes (`C:\...\bin\codev.js`) and
 * `import.meta.url` is `file:///C:/...`, so the POSIX comparisons never match
 * there and the CLI exited 0 without parsing anything (Spec 1658).
 */

import { pathToFileURL } from 'node:url';
import { isWindows } from './platform.js';

export function isCodevEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (isWindows()) {
    if (argv1 === undefined) {
      return false;
    }
    return /[\\/]codev(\.js)?$/i.test(argv1) || pathToFileURL(argv1).href === moduleUrl;
  }
  return moduleUrl === `file://${argv1}` ||
    argv1?.endsWith('/codev.js') === true ||
    argv1?.endsWith('/codev') === true;
}
