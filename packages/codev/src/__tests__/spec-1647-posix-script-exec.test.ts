/**
 * Spec 1647: on POSIX, a forge concept that is a bare path to a script runs as that script,
 * with no shell process between it and the forge layer.
 *
 * The time limit is a SIGTERM to the forge layer's child. Debian and Ubuntu build dash
 * without the "exec the last command of `sh -c`" optimization (Debian patch 0004), so a
 * plain `sh -c <path>` forks there and the signal kills only the shell: the script's traps
 * never run and its child outlives the limit. The trap test below therefore bites on
 * Debian and Ubuntu (CI); the path test bites everywhere, because a plain `sh -c` splits a
 * path with a space in it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { posixCommandLaunch } from '../lib/platform/posix/command-launch.js';

const onWindows = process.platform === 'win32';

describe.skipIf(onWindows)('Spec 1647 — a concept script path runs as the process the forge layer signals', () => {
  let dir: string;

  beforeEach(() => {
    // A space and a quote in the path: the script path must reach the shell as one word.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-1647 exec it's-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeScript = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}`);
    fs.chmodSync(file, 0o755);
    return file;
  };

  const options = (timeout: number) => ({
    cwd: dir, env: { ...process.env, MARKS: path.join(dir, 'marks') }, timeout, maxBuffer: 1024 * 1024,
  });

  it('runs a script whose path has a space and a quote in it', async () => {
    const script = writeScript('ok.sh', 'echo ran\n');
    await expect(posixCommandLaunch.execShellString(script, options(10_000))).resolves.toBe('ran\n');
    expect(posixCommandLaunch.execShellStringSync(script, options(10_000))).toBe('ran\n');
  });

  it('a timeout signals the script itself: its TERM trap runs and its child dies', async () => {
    const marks = path.join(dir, 'marks');
    // The child runs in the background and the script waits, so the trap can run at once.
    const script = writeScript('hang.sh', [
      'sleep 30 & child=$!',
      'echo "$child" > "$MARKS.child"',
      `trap 'kill "$child"; echo trapped > "$MARKS.trap"; exit 143' TERM`,
      'wait "$child"',
      '',
    ].join('\n'));
    const started = Date.now();
    const err = await posixCommandLaunch.execShellString(script, options(1500)).then(() => null, (e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((err as { killed?: boolean } | null)?.killed, 'the call was not ended by its time limit').toBe(true);
    // The script exits through its trap, with the trap's status, not by the signal.
    expect((err as { code?: unknown }).code, 'the signal did not reach the script').toBe(143);
    expect(fs.readFileSync(`${marks}.trap`, 'utf-8').trim()).toBe('trapped');

    const child = Number(fs.readFileSync(`${marks}.child`, 'utf-8').trim());
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(alive(), "the script's child outlived the time limit").toBe(false);
  });
});
