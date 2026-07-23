import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncLocalConfigSnapshot } from '../commands/spawn-worktree.js';
import { loadConfig } from '../../lib/config.js';

describe('personal config worktree snapshot', () => {
  let fixtureRoot: string;
  let workspaceRoot: string;
  let worktreeRoot: string;
  let sourcePath: string;
  let targetPath: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-local-config-snapshot-'));
    workspaceRoot = path.join(fixtureRoot, 'workspace');
    worktreeRoot = path.join(fixtureRoot, 'worktree');
    sourcePath = path.join(workspaceRoot, '.codev', 'config.local.json');
    targetPath = path.join(worktreeRoot, '.codev', 'config.local.json');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function writeSource(autoOpenArtifacts: boolean): void {
    fs.writeFileSync(sourcePath, JSON.stringify({
      porch: { autoOpenArtifacts },
    }));
  }

  it('copies a non-symlink snapshot that participates in normal config loading', () => {
    writeSource(false);

    expect(syncLocalConfigSnapshot({ workspaceRoot } as any, worktreeRoot)).toBe(true);

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(fs.readFileSync(sourcePath, 'utf8'));
    expect(loadConfig(worktreeRoot).porch?.autoOpenArtifacts).toBe(false);
  });

  it('refreshes atomically and never writes builder edits through to main', () => {
    writeSource(false);
    const originalSource = fs.readFileSync(sourcePath, 'utf8');
    syncLocalConfigSnapshot({ workspaceRoot } as any, worktreeRoot);

    fs.writeFileSync(targetPath, JSON.stringify({
      porch: { autoOpenArtifacts: true },
      builderOnly: true,
    }));
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(originalSource);

    syncLocalConfigSnapshot({ workspaceRoot } as any, worktreeRoot);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(originalSource);

    writeSource(true);
    const updatedSource = fs.readFileSync(sourcePath, 'utf8');
    syncLocalConfigSnapshot({ workspaceRoot } as any, worktreeRoot);
    syncLocalConfigSnapshot({ workspaceRoot } as any, worktreeRoot);

    expect(fs.readFileSync(targetPath, 'utf8')).toBe(updatedSource);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(updatedSource);
    expect(fs.readdirSync(path.dirname(targetPath))).toEqual(['config.local.json']);
  });

  it('does not create or delete a builder-local preference when main has none', () => {
    expect(syncLocalConfigSnapshot({ workspaceRoot } as any, worktreeRoot)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '{"builderOnly":true}');

    expect(syncLocalConfigSnapshot({ workspaceRoot } as any, worktreeRoot)).toBe(false);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('{"builderOnly":true}');
  });
});
