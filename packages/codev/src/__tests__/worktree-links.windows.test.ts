/**
 * Spec 1658 Phase 7, native Windows only (the on-demand `windows.yml` targeted
 * job; it skips everywhere else). Real links and real removal:
 *
 * - Scenario 11: without symlink permission (forced through the probe, since
 *   the runner account may create symlinks), a directory becomes a junction and
 *   a file a hard link, both writing through to the workspace root. With the
 *   probe left to the host, a symlink is made when it reports one allowed.
 *   A file on another volume, when the runner has one, is copied.
 * - Scenario 6a: removal while another process holds the worktree (a child's
 *   working directory, an open file) succeeds once the handles are released,
 *   and never deletes what a junction or hard link points at.
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorktreeLink,
  removeWorktreeDirectory,
  setSymlinkProbeForTests,
} from '../agent-farm/lib/worktree-links.js';

const onWindows = process.platform === 'win32';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-links-'));

afterEach(() => {
  setSymlinkProbeForTests(null);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A workspace root with a data directory and an env file, and an empty worktree. */
function fixture(name: string) {
  const root = path.join(workDir, name);
  const workspace = path.join(root, 'workspace');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'data', 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(workspace, '.env'), 'A=1\n');
  fs.mkdirSync(worktree, { recursive: true });
  return { workspace, worktree };
}

describe.skipIf(!onWindows)('worktree links on native Windows', () => {
  it('scenario 11: junction and hard link without symlink permission, both writing through', () => {
    const { workspace, worktree } = fixture('no-symlinks');
    setSymlinkProbeForTests(false);

    const dataLink = path.join(worktree, 'data');
    const envLink = path.join(worktree, '.env');
    expect(createWorktreeLink(path.join(workspace, 'data'), dataLink, 'directory', 'dir')).toBe('junction');
    expect(createWorktreeLink(path.join(workspace, '.env'), envLink, 'file')).toBe('hardlink');

    expect(fs.lstatSync(dataLink).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dataLink, 'keep.txt'), 'utf8')).toBe('keep');
    fs.writeFileSync(path.join(dataLink, 'new.txt'), 'from worktree');
    expect(fs.readFileSync(path.join(workspace, 'data', 'new.txt'), 'utf8')).toBe('from worktree');

    expect(fs.statSync(envLink).nlink).toBe(2);
    fs.appendFileSync(envLink, 'B=2\n');
    expect(fs.readFileSync(path.join(workspace, '.env'), 'utf8')).toBe('A=1\nB=2\n');
  });

  it('scenario 11: the probe decides, and a symlink is made when it is allowed', () => {
    const { workspace, worktree } = fixture('probe');
    const dataLink = path.join(worktree, 'data');
    const method = createWorktreeLink(path.join(workspace, 'data'), dataLink, 'directory', 'dir');
    console.log(`LINK-METHOD directory=${method}`);
    expect(['symlink', 'junction']).toContain(method);
    expect(fs.lstatSync(dataLink).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dataLink, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('copies a file from another volume when no hard link is possible', (ctx) => {
    const otherVolume = ['D:\\', 'E:\\'].find((drive) => {
      if (drive[0].toLowerCase() === workDir[0].toLowerCase()) return false;
      try {
        fs.accessSync(drive, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (!otherVolume) ctx.skip();
    const source = fs.mkdtempSync(path.join(otherVolume as string, 'codev-1658-volume-'));
    try {
      fs.writeFileSync(path.join(source, '.env'), 'A=1\n');
      const { worktree } = fixture('cross-volume');
      setSymlinkProbeForTests(false);
      expect(createWorktreeLink(path.join(source, '.env'), path.join(worktree, '.env'), 'file')).toBe('copy');
      expect(fs.readFileSync(path.join(worktree, '.env'), 'utf8')).toBe('A=1\n');
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it('scenario 6a: removal waits out held handles and leaves link targets intact', async () => {
    const { workspace, worktree } = fixture('removal');
    setSymlinkProbeForTests(false);
    createWorktreeLink(path.join(workspace, 'data'), path.join(worktree, 'data'), 'directory', 'dir');
    createWorktreeLink(path.join(workspace, '.env'), path.join(worktree, '.env'), 'file');
    const busyDir = path.join(worktree, 'node_modules', 'pkg');
    fs.mkdirSync(busyDir, { recursive: true });
    fs.writeFileSync(path.join(busyDir, 'index.js'), 'x');

    // A process whose working directory is inside the worktree, gone after 1.5s.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { cwd: busyDir, windowsHide: true });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    await once(holder, 'spawn');
    // And an open handle on a file, released after 1s.
    const fd = fs.openSync(path.join(worktree, 'held.log'), 'w');
    setTimeout(() => fs.closeSync(fd), 1000);

    const started = Date.now();
    await removeWorktreeDirectory(worktree);
    console.log(`REMOVAL-MS ${Date.now() - started}`);
    await exited;

    expect(fs.existsSync(worktree)).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'data', 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(workspace, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('scenario 6a: a handle held past every retry fails naming the blocking path', async () => {
    const { worktree } = fixture('stuck');
    const busyDir = path.join(worktree, 'stuck-dir');
    fs.mkdirSync(busyDir);
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: busyDir, windowsHide: true });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    try {
      await once(holder, 'spawn');
      await expect(removeWorktreeDirectory(worktree, { retryDelaysMs: [50, 50] })).rejects.toThrow('stuck-dir');
    } finally {
      holder.kill();
      await exited;
    }
  });
});
