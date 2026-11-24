/**
 * Spec 1963 scenario 6: a path or URL from a Work or Decisions webview is untrusted. A file opens
 * only when its canonical, symlink-resolved location is inside the workspace (decided by
 * `path.relative`, never a string prefix); a URL opens only when it is http(s).
 *
 * The Windows cases run as `path.win32` table tests on every OS, and for real (with a directory
 * junction) in the on-demand Windows workflow.
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isAllowedExternalUrl, isWithin, resolveWorkspaceFile } from '../workspace-views/security.js';

describe('isWithin (canonical paths)', () => {
  it.each([
    ['/ws', '/ws', true],
    ['/ws', '/ws/codev/specs/1.md', true],
    ['/ws', '/ws/..hidden/file', true],
    ['/ws', '/ws/../etc/passwd', false],
    ['/ws', '/', false],
    ['/ws', '/ws-other/file', false],
    ['/ws', '/elsewhere/file', false],
  ])('posix: %s contains %s → %s', (root, target, inside) => {
    expect(isWithin(root, target, path.posix)).toBe(inside);
  });

  it.each([
    ['drive-letter case', 'c:\\ws', 'C:\\ws\\codev\\a.md', true],
    ['mixed separators', 'C:\\ws', 'C:/ws/codev/a.md', true],
    ['the root itself, other spelling', 'C:\\ws', 'c:/ws/', true],
    ['a different drive', 'C:\\ws', 'D:\\ws\\a.md', false],
    ['a UNC root against a local root', 'C:\\ws', '\\\\server\\share\\ws\\a.md', false],
    ['a local path against a UNC root', '\\\\server\\share\\ws', 'C:\\ws\\a.md', false],
    ['inside a UNC root', '\\\\server\\share\\ws', '\\\\server\\share\\ws\\a.md', true],
    ['a prefix sibling', 'C:\\ws', 'C:\\ws-other\\a.md', false],
    ['a parent escape', 'C:\\ws', 'C:\\ws\\..\\secrets.txt', false],
  ])('win32: %s', (_name, root, target, inside) => {
    expect(isWithin(root, target, path.win32)).toBe(inside);
  });
});

describe('resolveWorkspaceFile (real files and symlinks)', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'codev-wv-security-')));
    root = path.join(base, 'ws');
    outside = path.join(base, 'outside');
    mkdirSync(path.join(root, 'codev', 'specs'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(root, 'codev', 'specs', '1.md'), '# spec');
    writeFileSync(path.join(outside, 'secret.md'), 'secret');
    // A link inside the workspace to a file inside it, and links that escape it.
    symlinkSync(path.join(root, 'codev', 'specs', '1.md'), path.join(root, 'inner-link.md'));
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'escape-link.md'));
    // A junction on Windows (no privilege needed), a plain directory symlink elsewhere.
    symlinkSync(outside, path.join(root, 'escape-dir'), 'junction');
    // A sibling whose name starts with the workspace's.
    mkdirSync(`${root}-other`);
    writeFileSync(path.join(`${root}-other`, 'a.md'), 'sibling');
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves a relative path inside the workspace to its canonical path', async () => {
    expect(await resolveWorkspaceFile(root, 'codev/specs/1.md')).toEqual({ ok: true, path: path.join(root, 'codev', 'specs', '1.md') });
  });

  it('accepts an absolute path inside the workspace, and a link that stays inside', async () => {
    expect(await resolveWorkspaceFile(root, path.join(root, 'codev', 'specs', '1.md'))).toMatchObject({ ok: true });
    expect(await resolveWorkspaceFile(root, 'inner-link.md')).toEqual({ ok: true, path: path.join(root, 'codev', 'specs', '1.md') });
  });

  it.each([
    ['a .. escape', '../outside/secret.md'],
    ['an absolute path outside', '/etc/hosts'],
    ['a prefix sibling', '../ws-other/a.md'],
    ['a file symlink leading outside', 'escape-link.md'],
    ['a directory symlink leading outside', 'escape-dir/secret.md'],
  ])('refuses %s', async (_name, requested) => {
    expect(await resolveWorkspaceFile(root, requested)).toEqual({ ok: false, reason: 'outside-workspace' });
  });

  it('says not-found for a path that does not exist, and for one with a NUL byte', async () => {
    expect(await resolveWorkspaceFile(root, 'codev/specs/missing.md')).toEqual({ ok: false, reason: 'not-found' });
    expect(await resolveWorkspaceFile(root, 'codev/specs/1.md\0.txt')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('resolves the workspace root through its own symlink, so a linked workspace still contains its files', async () => {
    const linkedRoot = path.join(base, 'ws-link');
    symlinkSync(root, linkedRoot, 'junction');
    expect(await resolveWorkspaceFile(linkedRoot, 'codev/specs/1.md')).toEqual({ ok: true, path: path.join(root, 'codev', 'specs', '1.md') });
    expect(await resolveWorkspaceFile(linkedRoot, 'escape-link.md')).toEqual({ ok: false, reason: 'outside-workspace' });
  });
});

describe.runIf(process.platform === 'win32')('resolveWorkspaceFile on Windows paths', () => {
  let base: string;
  let root: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'codev-wv-win-')));
    root = path.join(base, 'ws');
    mkdirSync(path.join(root, 'codev'), { recursive: true });
    writeFileSync(path.join(root, 'codev', 'a.md'), 'a');
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('accepts the workspace spelled with the other drive-letter case and with forward slashes', async () => {
    const flipped = root[0] === root[0].toUpperCase() ? root[0].toLowerCase() + root.slice(1) : root[0].toUpperCase() + root.slice(1);
    expect(await resolveWorkspaceFile(flipped, 'codev\\a.md')).toMatchObject({ ok: true });
    expect(await resolveWorkspaceFile(root.replace(/\\/g, '/'), 'codev/a.md')).toMatchObject({ ok: true });
  });
});

describe('isAllowedExternalUrl', () => {
  it.each([
    'https://github.com/cluesmith/codev/issues/1963',
    'http://localhost:3000/',
    'HTTPS://EXAMPLE.COM/a',
  ])('allows %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'vscode://cluesmith.codev-vscode/x',
    'vscode-webview://abc/index.html',
    'command:workbench.action.terminal.new',
    'data:text/html,<script>alert(1)</script>',
    'mailto:someone@example.com',
    '//github.com/x',
    '/relative/path',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });
});
