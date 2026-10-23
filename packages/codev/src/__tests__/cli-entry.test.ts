/**
 * Spec 1658: `codev` recognises being run as a command on every host. On Windows
 * it once exited 0 without parsing anything, because the entry check compared
 * POSIX-shaped paths only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { isCodevEntrypoint } from '../lib/cli-entry.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../lib/platform.js';

const CLI_URL_POSIX = 'file:///usr/lib/node_modules/@cluesmith/codev/dist/cli.js';
const CLI_URL_WIN = 'file:///C:/Users/me/AppData/Roaming/npm/node_modules/@cluesmith/codev/dist/cli.js';

afterEach(() => {
  resetHostPlatformForTests();
});

describe('isCodevEntrypoint', () => {
  it('POSIX: the bin path and a bare codev symlink are the entry; an importer is not', () => {
    setHostPlatformForTests('linux');
    expect(isCodevEntrypoint('/usr/lib/node_modules/@cluesmith/codev/bin/codev.js', CLI_URL_POSIX)).toBe(true);
    expect(isCodevEntrypoint('/usr/local/bin/codev', CLI_URL_POSIX)).toBe(true);
    expect(isCodevEntrypoint('/usr/lib/node_modules/@cluesmith/codev/dist/cli.js', CLI_URL_POSIX)).toBe(true);
    expect(isCodevEntrypoint('/usr/lib/node_modules/@cluesmith/codev/bin/consult.js', CLI_URL_POSIX)).toBe(false);
    expect(isCodevEntrypoint(undefined, CLI_URL_POSIX)).toBe(false);
  });

  it('Windows: the npm shim runs bin\\codev.js with a backslash path', () => {
    setHostPlatformForTests('win32');
    expect(isCodevEntrypoint('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@cluesmith\\codev\\bin\\codev.js', CLI_URL_WIN)).toBe(true);
    expect(isCodevEntrypoint('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@cluesmith\\codev\\bin\\CODEV.JS', CLI_URL_WIN)).toBe(true);
    expect(isCodevEntrypoint('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@cluesmith\\codev\\bin\\consult.js', CLI_URL_WIN)).toBe(false);
    expect(isCodevEntrypoint(undefined, CLI_URL_WIN)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('Windows: dist\\cli.js run directly is the entry', () => {
    const cli = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@cluesmith\\codev\\dist\\cli.js';
    expect(isCodevEntrypoint(cli, CLI_URL_WIN)).toBe(true);
  });
});
