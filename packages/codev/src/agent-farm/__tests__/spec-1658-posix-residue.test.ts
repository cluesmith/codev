/**
 * Spec 1658, Phase 10: the POSIX-residue sites, with the Windows branch forced
 * through the platform seam. POSIX behavior is covered by each site's own
 * existing tests.
 */
// spec-1658-tmp: opaque (/tmp/ws and /private/tmp/ws are strings fed to isTempDirectory, which compares them with string ops)

import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resetHostPlatformForTests, setHostPlatformForTests } from '../../lib/platform.js';
import { isTempDirectory } from '../servers/tower-utils.js';
import { harnessFromLaunchScript, type ContextFsPort } from '../commands/reset/context.js';
import { matchBuilderRow } from '../utils/builder-worktree-identity.js';

afterEach(() => {
  resetHostPlatformForTests();
});

function launchScript(content: string): ContextFsPort {
  return { read: () => content } as unknown as ContextFsPort;
}

describe('isTempDirectory on Windows', () => {
  it('counts the host temp dir, case-insensitively, and not the POSIX roots', () => {
    setHostPlatformForTests('win32');
    expect(isTempDirectory(path.join(tmpdir(), 'ws'))).toBe(true);
    expect(isTempDirectory(path.join(tmpdir(), 'ws').toUpperCase())).toBe(true);
    expect(isTempDirectory('/tmp/ws')).toBe(false);
    expect(isTempDirectory('/private/tmp/ws')).toBe(false);
    expect(isTempDirectory(tmpdir() + '-other/ws')).toBe(false);
  });
});

describe('harnessFromLaunchScript with a Windows command path', () => {
  it('reads C:\\tools\\claude.exe as claude on Windows', () => {
    setHostPlatformForTests('win32');
    const script = '#!/bin/bash\ncd /c/ws\n"C:\\tools\\claude.exe" --model x\n';
    expect(harnessFromLaunchScript(launchScript(script), 'C:\\ws')).toBe('claude');
  });

  it('keeps the POSIX basename rule on POSIX', () => {
    setHostPlatformForTests('linux');
    expect(harnessFromLaunchScript(launchScript('/usr/local/bin/codex --x\n'), '/ws')).toBe('codex');
    expect(harnessFromLaunchScript(launchScript('claude.exe --x\n'), '/ws')).toBeNull();
  });
});

describe('matchBuilderRow legacy tail match on Windows', () => {
  it('matches a backslash worktree path by its last segment', () => {
    setHostPlatformForTests('win32');
    const rows = [{ id: 'b1', worktree: 'D:\\elsewhere\\.builders\\spir-7' }];
    const row = matchBuilderRow(rows, { workspacePath: 'C:\\ws', worktreeDirName: 'spir-7' });
    expect(row).toBe(rows[0]);
  });
});
