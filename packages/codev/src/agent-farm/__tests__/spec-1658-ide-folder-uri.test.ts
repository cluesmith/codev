/**
 * Spec 1658, finding M7: the dashboard's Open IDE link (Issue #1869) passes the
 * workspace as `?folder=`, which the IDE reads as the path part of a URI. A
 * Windows path (`C:\a\b`) is not one, so the IDE opened but could not resolve
 * the folder. `ideFolderUriPath` in tower.html converts it.
 *
 * The test evaluates the function's real source from the template, following
 * the bugfix-1599-shell-tunnel-poll.test.ts pattern of reading tower.html.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const towerHtmlPath = path.resolve(import.meta.dirname, '../../../templates/tower.html');

function loadIdeFolderUriPath(): (workspacePath: string) => string {
  const html = fs.readFileSync(towerHtmlPath, 'utf-8');
  const fnMatch = html.match(/function ideFolderUriPath\(workspacePath\) \{[\s\S]*?\n    \}/);
  expect(fnMatch).not.toBeNull();
  return new Function(`${fnMatch![0]}\nreturn ideFolderUriPath;`)() as (workspacePath: string) => string;
}

describe('Spec 1658 M7: Open IDE folder is a URI path', () => {
  const ideFolderUriPath = loadIdeFolderUriPath();

  it('turns a Windows drive path into /C:/... with forward slashes', () => {
    expect(ideFolderUriPath('C:\\src\\tools\\project')).toBe('/C:/src/tools/project');
    expect(ideFolderUriPath('d:/work\\project')).toBe('/d:/work/project');
  });

  it('turns a UNC path into //server/share/...', () => {
    expect(ideFolderUriPath('\\\\server\\share\\project')).toBe('//server/share/project');
  });

  it('passes a POSIX absolute path through unchanged', () => {
    expect(ideFolderUriPath('/Users/someone/src/project')).toBe('/Users/someone/src/project');
  });

  it('is idempotent on input already in URI-path form', () => {
    for (const input of ['C:\\src\\project', '\\\\server\\share\\project', '/home/someone/project']) {
      const once = ideFolderUriPath(input);
      expect(ideFolderUriPath(once)).toBe(once);
    }
  });

  it('openIde encodes the converted folder, not the raw workspace path', () => {
    const html = fs.readFileSync(towerHtmlPath, 'utf-8');
    expect(html).toContain("'./ide/?folder=' + encodeURIComponent(ideFolderUriPath(workspacePath))");
  });
});
