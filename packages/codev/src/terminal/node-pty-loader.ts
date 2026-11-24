/**
 * The one way Codev loads node-pty (used by PtySession and shellper).
 *
 * node-pty is a native CommonJS module, so it is loaded with `createRequire`, never a dynamic
 * `import()`. Inside Tower, on Node 22.17 and later in the pnpm workspace, `import('node-pty')`
 * could resolve through the package's pnpm symlink rather than its real path and return a
 * second, empty copy of the module whose `spawn` is undefined (#1944). `require` resolves the
 * real path and returns the single loaded module.
 *
 * A binding that cannot load on Windows surfaces with the supported-versions message (Spec 1658).
 */

import { createRequire } from 'node:module';
import { withNativeLoadExplanation } from '../lib/native-deps.js';

const require = createRequire(import.meta.url);

export function loadNodePty(): typeof import('node-pty') {
  return withNativeLoadExplanation(() => require('node-pty') as typeof import('node-pty'));
}
