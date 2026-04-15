import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Traverse up from a directory to find the .codev/config.json root.
 * Returns the project root directory (parent of .codev/), or null.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.codev'))
      || fs.existsSync(path.join(dir, 'codev'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Detect the workspace path for Tower communication.
 * Priority: setting override > workspace folder traversal.
 */
export function detectWorkspacePath(): string | null {
  const override = vscode.workspace.getConfiguration('codev').get<string>('workspacePath');
  if (override) {
    return override;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }

  return findProjectRoot(folders[0].uri.fsPath);
}

/**
 * Get Tower host and port from VS Code settings.
 */
export function getTowerAddress(): { host: string; port: number } {
  const config = vscode.workspace.getConfiguration('codev');
  return {
    host: config.get<string>('towerHost', 'localhost'),
    port: config.get<number>('towerPort', 4100),
  };
}
