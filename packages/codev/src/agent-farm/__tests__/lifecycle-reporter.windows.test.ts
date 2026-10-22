/**
 * Spec 1658, native Windows only (the on-demand `windows.yml` targeted job
 * runs it; it skips everywhere else). The Spec 1595 Claude lifecycle reporter
 * on a real Windows host, no fakes: the installed hook command, run the way a
 * hook shell would run it, against a stand-in Tower.
 *
 * - Under Git Bash, from a directory whose path holds a space, the hook posts
 *   the translated event to Tower and prints nothing.
 * - With the script deleted, it still exits 0 and prints nothing (fail-open).
 * - The settings file hands Claude forward-slash paths only.
 * - Under cmd.exe the command is not valid; the outcome is logged
 *   (CMD-RESULT) so the report can say what a cmd-run hook would do.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveGitBash } from '../../lib/git-bash.js';
import {
  LIFECYCLE_REPORTER_SCRIPT_NAME,
  ensureLifecycleReporterInstalled,
} from '../utils/lifecycle-reporter.js';

const onWindows = process.platform === 'win32';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-lifecycle-'));
const hooksDir = path.join(workDir, 'agent farm', 'hooks');

interface Received {
  path: string;
  key: string | undefined;
  body: Record<string, unknown>;
}

describe.runIf(onWindows)('Spec 1595 lifecycle reporter hook on a real Windows host', () => {
  let tower: http.Server;
  let towerPort = 0;
  const received: Received[] = [];
  let hookCommand = '';
  let settingsText = '';

  beforeAll(async () => {
    tower = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          key: req.headers['codev-tower-key'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>,
        });
        res.end('{}');
      });
    });
    towerPort = await new Promise<number>((resolve) => {
      tower.listen(0, '127.0.0.1', () => {
        const addr = tower.address();
        if (addr && typeof addr !== 'string') resolve(addr.port);
      });
    });
    const settingsPath = ensureLifecycleReporterInstalled(hooksDir);
    settingsText = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsText) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    hookCommand = settings.hooks.SessionStart[0].hooks[0].command;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => tower.close(() => resolve()));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function hookEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CODEV_TOWER_PORT: String(towerPort),
      CODEV_TOWER_KEY: 'test-key',
      CODEV_BUILDER_WORKTREE: 'C:\\repo\\.builders\\spir-1',
    };
  }

  const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sess-1' });

  it('the settings file carries forward-slash paths only', () => {
    console.log(`HOOK-COMMAND ${hookCommand}`);
    expect(hookCommand).not.toContain('\\');
    expect(hookCommand).toContain(path.join(hooksDir, LIFECYCLE_REPORTER_SCRIPT_NAME).replace(/\\/g, '/'));
  });

  it('Git Bash: posts the event to Tower, prints nothing, exits 0 (path with a space)', async () => {
    const bash = resolveGitBash().path;
    const run = spawnSync(bash, ['-c', hookCommand], { input: payload, env: hookEnv(), encoding: 'utf-8', windowsHide: true, timeout: 30_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/api/agent-lifecycle');
    expect(received[0].key).toBe('test-key');
    expect(received[0].body).toMatchObject({
      agent: { kind: 'builder', worktreePath: 'C:\\repo\\.builders\\spir-1' },
      sessionId: 'sess-1',
      event: 'session-started',
    });
  });

  it('Git Bash: with the script deleted, still exits 0 and prints nothing', () => {
    const scriptPath = path.join(hooksDir, LIFECYCLE_REPORTER_SCRIPT_NAME);
    const saved = fs.readFileSync(scriptPath, 'utf-8');
    fs.rmSync(scriptPath);
    try {
      const bash = resolveGitBash().path;
      const run = spawnSync(bash, ['-c', hookCommand], { input: payload, env: hookEnv(), encoding: 'utf-8', windowsHide: true, timeout: 30_000 });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    } finally {
      fs.writeFileSync(scriptPath, saved);
    }
  });

  it('cmd.exe: records what a cmd-run hook would do', () => {
    const before = received.length;
    const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${hookCommand}"`], {
      input: payload,
      env: hookEnv(),
      encoding: 'utf-8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 30_000,
    });
    console.log(`CMD-RESULT status=${run.status} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)} posted=${received.length - before}`);
    expect(run.error).toBeUndefined();
  });
});
