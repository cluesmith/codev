/**
 * Spec 1658 Phase 10: `codev doctor`'s long-path and state-location checks on
 * native Windows, with the platform seam forced to `win32` and injected host
 * values. The section only prints on Windows (doctor.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkWindowsPathsAndState,
  MAX_SAFE_WORKSPACE_ROOT_LENGTH,
  WINDOWS_MAX_PATH,
  type WindowsPathDeps,
} from '../commands/doctor.js';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../lib/platform.js';

const TYPICAL_ROOT = 'C:\\Users\\alexandra\\src\\my-project';

function deps(overrides: Partial<WindowsPathDeps>): WindowsPathDeps {
  return {
    workspaceRoot: TYPICAL_ROOT,
    gitLongPaths: () => 'true',
    relocatedStateDir: null,
    userProfile: 'C:\\Users\\alexandra',
    ...overrides,
  };
}

beforeEach(() => {
  setHostPlatformForTests('win32');
});

afterEach(() => {
  resetHostPlatformForTests();
});

describe('checkWindowsPathsAndState', () => {
  it('keeps the budgets inside MAX_PATH and accepts a typical-depth root', () => {
    expect(MAX_SAFE_WORKSPACE_ROOT_LENGTH).toBeLessThan(WINDOWS_MAX_PATH);
    expect(TYPICAL_ROOT.length).toBeLessThanOrEqual(MAX_SAFE_WORKSPACE_ROOT_LENGTH);
    expect(checkWindowsPathsAndState(deps({}))).toEqual([
      { name: 'Workspace depth', status: 'ok', version: `root is ${TYPICAL_ROOT.length} characters` },
      { name: 'Git core.longpaths', status: 'ok', version: 'true' },
    ]);
  });

  it('warns on a workspace root deep enough to risk MAX_PATH overruns', () => {
    const deep = 'C:\\Users\\alexandra\\OneDrive - Example Corporation\\Documents\\Projects\\clients\\my-project';
    expect(deep.length).toBeGreaterThan(MAX_SAFE_WORKSPACE_ROOT_LENGTH);
    const [depth] = checkWindowsPathsAndState(deps({ workspaceRoot: deep }));
    expect(depth.status).toBe('warn');
    expect(depth.version).toContain(`${deep.length} characters`);
    expect(depth.note).toContain('260-character');
  });

  it('skips the depth check outside a workspace', () => {
    const names = checkWindowsPathsAndState(deps({ workspaceRoot: null })).map((r) => r.name);
    expect(names).toEqual(['Git core.longpaths']);
  });

  it('reports core.longpaths unset or false as a warning with the fix', () => {
    for (const value of [null, 'false']) {
      const longPaths = checkWindowsPathsAndState(deps({ gitLongPaths: () => value })).find((r) => r.name === 'Git core.longpaths');
      expect(longPaths?.status).toBe('warn');
      expect(longPaths?.version).toBe(value ?? 'not set');
      expect(longPaths?.note).toContain('git config --global core.longpaths true');
    }
    const upper = checkWindowsPathsAndState(deps({ gitLongPaths: () => 'TRUE' })).find((r) => r.name === 'Git core.longpaths');
    expect(upper?.status).toBe('ok');
  });

  it('warns when CODEV_AGENT_FARM_DIR relocates state outside the user profile', () => {
    const outside = checkWindowsPathsAndState(deps({ relocatedStateDir: 'D:\\codev-state' }));
    const state = outside.find((r) => r.name === 'State directory');
    expect(state?.status).toBe('warn');
    expect(state?.version).toContain('D:\\codev-state');
    expect(state?.note).toContain('%USERPROFILE%');

    const noProfile = checkWindowsPathsAndState(deps({ relocatedStateDir: 'C:\\Users\\alexandra\\state', userProfile: null }));
    expect(noProfile.find((r) => r.name === 'State directory')?.status).toBe('warn');
  });

  it('accepts state relocated inside the user profile, compared case-insensitively', () => {
    const inside = checkWindowsPathsAndState(deps({ relocatedStateDir: 'c:\\users\\ALEXANDRA\\codev-state' }));
    expect(inside.find((r) => r.name === 'State directory')).toBeUndefined();
  });
});
