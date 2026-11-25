/**
 * Point `os.homedir()` at an empty temp directory for the current test file (Spec 1951).
 *
 * The config loader reads `~/.codev/config.json` as a layer, and the spec recommends that an
 * owner put `check.*` there. A test that loads configuration must not see the developer's own
 * file. `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so both are set, as
 * `src/__tests__/config.test.ts` does.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

export function useFakeHome(): { readonly dir: () => string } {
  let home = '';
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-check-home-')));
    for (const key of ['HOME', 'USERPROFILE']) {
      saved[key] = process.env[key];
      process.env[key] = home;
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { dir: () => home };
}
