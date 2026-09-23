/**
 * Runtime behavior of the Workspace Trust declaration (#1727).
 *
 * VS Code — not the extension — does the withholding: for a setting flagged
 * `restricted`, `getConfiguration('codev').get(key)` returns the user/global
 * value (ignoring workspace scope) while the folder is untrusted, and the
 * workspace value once trusted. These tests assert the extension reads the
 * Tower endpoint through `getConfiguration` (so that substitution applies)
 * rather than bypassing it, and that trust state never diverts workspace-path
 * resolution toward $HOME (the #1722 interaction: the two fixes must not
 * regress each other).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// --- vscode mock modelling VS Code's restricted-config substitution --------

let isTrusted = true;
let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;

// Values a hostile cloned repo put in workspace scope vs. the safe global
// values. When untrusted, VS Code hands the extension the global value for a
// restricted key.
const WORKSPACE_SCOPE: Record<string, unknown> = {
  towerHost: 'evil.example',
  towerPort: 6666,
  workspacePath: '',
};
const GLOBAL_SCOPE: Record<string, unknown> = {
  towerHost: 'localhost',
  towerPort: 4100,
  workspacePath: '',
};
const RESTRICTED = new Set(['towerHost', 'towerPort', 'workspacePath', 'autoStartTower']);

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() { return isTrusted; },
    get workspaceFolders() { return workspaceFolders; },
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => {
        // Restricted key + untrusted folder → VS Code returns the global
        // value, never the workspace one.
        const scope = (RESTRICTED.has(key) && !isTrusted) ? GLOBAL_SCOPE : WORKSPACE_SCOPE;
        if (key in scope) {
          const v = scope[key];
          return v === undefined ? fallback : v;
        }
        return fallback;
      },
    }),
  },
}));

import { detectWorkspacePath, getTowerAddress } from '../workspace-detector.js';

let root: string;

beforeEach(() => {
  isTrusted = true;
  workspaceFolders = undefined;
  root = mkdtempSync(join(tmpdir(), 'codev-trust-'));
});

describe('getTowerAddress under Workspace Trust', () => {
  it('reads the safe global endpoint while the folder is untrusted', () => {
    isTrusted = false;
    // Even though workspace scope points the endpoint at evil.example:6666,
    // the extension reads through getConfiguration, so it gets localhost:4100.
    expect(getTowerAddress()).toEqual({ host: 'localhost', port: 4100 });
  });

  it('honors the workspace endpoint once the folder is trusted', () => {
    isTrusted = true;
    expect(getTowerAddress()).toEqual({ host: 'evil.example', port: 6666 });
  });
});

describe('workspace-path resolution is trust-independent (#1722 interaction)', () => {
  it('resolves a real codev project to itself, not $HOME, while untrusted', () => {
    isTrusted = false;
    mkdirSync(join(root, 'codev'));
    workspaceFolders = [{ uri: { fsPath: root } }];

    const detected = detectWorkspacePath();
    expect(detected).toBe(root);
    expect(detected).not.toBe(homedir());
    rmSync(root, { recursive: true, force: true });
  });

  it('does not adopt any workspace for a plain untrusted project', () => {
    isTrusted = false;
    // No codev/ marker: a plain cloned repo opened untrusted must resolve to
    // null (not $HOME, not the folder), exactly as when trusted.
    workspaceFolders = [{ uri: { fsPath: root } }];
    expect(detectWorkspacePath()).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});
