/**
 * Process bootstrap: setup that must run in every Codev process before any
 * other code.
 *
 * This is a side-effect module. Every Codev process entry point (each
 * `bin/*.js`, `tower-server.ts`, `shellper-main.ts`) imports it FIRST, so it
 * runs before any other module loads; `process-bootstrap.test.ts` enforces the
 * import order. Keep it, and everything it imports, free of other imports and
 * of anything that spawns, so nothing can run ahead of it.
 *
 * Today it holds one step: on Windows, never run a program from the current
 * folder (#1911, `platform/windows/exe-search.ts`).
 */

import { hardenExeSearch } from './platform/windows/exe-search.js';

/** Apply every bootstrap step for the given platform to the given environment. */
export function bootstrapProcess(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  if (platform === 'win32') {
    hardenExeSearch(env);
  }
}

bootstrapProcess(process.platform, process.env);
