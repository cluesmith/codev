/**
 * Spec 1658, finding M6: on Windows the Fleet view must still recognise this
 * window's workspace when Tower reports the directory's canonical spelling
 * (`C:\repo`) and VS Code's `uri.fsPath` lower-cases the drive letter (`c:\repo`).
 */

import { describe, it, expect } from 'vitest';
import { isSameWorkspacePath } from '../views/fleet-order.js';

describe('isSameWorkspacePath', () => {
  it('matches across drive-letter and folder case on Windows', () => {
    expect(isSameWorkspacePath('C:\\repos\\App', 'c:\\repos\\App', 'win32')).toBe(true);
    expect(isSameWorkspacePath('C:\\Repos\\App', 'c:\\repos\\app', 'win32')).toBe(true);
    expect(isSameWorkspacePath('C:\\repos\\App', 'c:\\repos\\Other', 'win32')).toBe(false);
  });

  it('keeps the exact comparison on POSIX', () => {
    expect(isSameWorkspacePath('/Users/x/Repo', '/Users/x/Repo', 'darwin')).toBe(true);
    expect(isSameWorkspacePath('/Users/x/Repo', '/users/x/repo', 'darwin')).toBe(false);
    expect(isSameWorkspacePath('/home/x/repo', '/home/x/repo', 'linux')).toBe(true);
  });

  it('is never current without a window folder', () => {
    expect(isSameWorkspacePath('C:\\repo', null, 'win32')).toBe(false);
  });
});
