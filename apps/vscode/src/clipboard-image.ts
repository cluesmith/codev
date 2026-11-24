/**
 * Read a bitmap image off the system clipboard (#736).
 *
 * VSCode's clipboard API is text-only and a Pseudoterminal never receives
 * image bytes, so we shell out per-OS. There is no single cross-platform
 * binary-clipboard API available to an extension — this module IS the
 * cross-platform layer (macOS + Windows + Linux X11/Wayland behind one
 * function). Every shim normalises to PNG, which Tower's /api/paste-image
 * accepts directly.
 *
 * `deps` is injectable purely for unit tests (spawn / platform / env).
 */

import { spawn as realSpawn } from 'node:child_process';
import type { ChildProcessByStdio, SpawnOptions } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ClipboardImageResult =
  | { kind: 'image'; bytes: Buffer; mime: 'image/png' }
  | { kind: 'no-image' }
  | { kind: 'tool-missing'; tool: string }
  | { kind: 'error'; message: string };

export interface ClipboardDeps {
  spawn: typeof realSpawn;
  platform: () => NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_DEPS: ClipboardDeps = {
  // windows-console: injected spawn; runCapture's options carry windowsHide
  spawn: realSpawn,
  platform: () => process.platform,
  env: process.env,
};

const SHIM_TIMEOUT_MS = 5000;

interface CaptureResult {
  spawnError?: NodeJS.ErrnoException;
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a command, capture binary stdout, with a hard timeout. No shell. */
function runCapture(
  deps: ClipboardDeps,
  cmd: string,
  args: string[],
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    // Hidden: the extension host has no console, and the Windows reader is powershell.exe (Issue #1919).
    const opts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    let child: ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>;
    try {
      child = deps.spawn(cmd, args, opts) as typeof child;
    } catch (err) {
      resolve({ spawnError: err as NodeJS.ErrnoException, code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false });
      return;
    }

    const out: Buffer[] = [];
    let err = '';
    let settled = false;
    const finish = (r: CaptureResult) => { if (!settled) { settled = true; resolve(r); } };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout: Buffer.concat(out), stderr: err, timedOut: true });
    }, SHIM_TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ spawnError: e, code: null, stdout: Buffer.concat(out), stderr: err, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout: Buffer.concat(out), stderr: err, timedOut: false });
    });
  });
}

function isENOENT(e: NodeJS.ErrnoException | undefined): boolean {
  return !!e && (e.code === 'ENOENT' || /not found|no such file/i.test(e.message));
}

/** macOS / Windows shims write a temp PNG; read it then always clean up. */
async function readTempPng(file: string): Promise<Buffer | null> {
  try {
    const buf = await readFile(file);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    void unlink(file).catch(() => { /* best-effort */ });
  }
}

async function readMac(deps: ClipboardDeps): Promise<ClipboardImageResult> {
  const file = join(tmpdir(), `codev-paste-clip-${randomUUID()}.png`);
  // osascript is always present on macOS. Returns "OK" / "NO_IMAGE";
  // any clipboard-has-no-PNG case is caught and reported, never thrown.
  const script = [
    'try',
    '  set theData to (the clipboard as «class PNGf»)',
    'on error',
    '  return "NO_IMAGE"',
    'end try',
    `set fh to open for access (POSIX file ${JSON.stringify(file)}) with write permission`,
    'write theData to fh',
    'close access fh',
    'return "OK"',
  ].join('\n');
  const r = await runCapture(deps, 'osascript', ['-e', script]);
  if (isENOENT(r.spawnError)) { return { kind: 'tool-missing', tool: 'osascript' }; }
  if (r.spawnError || r.timedOut) {
    return { kind: 'error', message: r.timedOut ? 'clipboard read timed out' : String(r.spawnError) };
  }
  if (r.stdout.toString().includes('NO_IMAGE')) { return { kind: 'no-image' }; }
  if (r.code !== 0) { return { kind: 'error', message: r.stderr.trim() || `osascript exited ${r.code}` }; }
  const bytes = await readTempPng(file);
  return bytes ? { kind: 'image', bytes, mime: 'image/png' } : { kind: 'no-image' };
}

async function readLinux(deps: ClipboardDeps): Promise<ClipboardImageResult> {
  const wayland = !!deps.env.WAYLAND_DISPLAY;
  const cmd = wayland ? 'wl-paste' : 'xclip';
  const args = wayland
    ? ['-t', 'image/png']
    : ['-selection', 'clipboard', '-t', 'image/png', '-o'];
  const r = await runCapture(deps, cmd, args);
  if (isENOENT(r.spawnError)) {
    return { kind: 'tool-missing', tool: wayland ? 'wl-clipboard' : 'xclip' };
  }
  if (r.spawnError || r.timedOut) {
    return { kind: 'error', message: r.timedOut ? 'clipboard read timed out' : String(r.spawnError) };
  }
  // Both tools exit non-zero / empty when the clipboard has no PNG.
  if (r.code !== 0 || r.stdout.length === 0) { return { kind: 'no-image' }; }
  return { kind: 'image', bytes: r.stdout, mime: 'image/png' };
}

async function readWindows(deps: ClipboardDeps): Promise<ClipboardImageResult> {
  const file = join(tmpdir(), `codev-paste-clip-${randomUUID()}.png`);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$img = [System.Windows.Forms.Clipboard]::GetImage();',
    'if ($img -eq $null) { Write-Output "NO_IMAGE"; exit 0 }',
    `$img.Save(${JSON.stringify(file)}, [System.Drawing.Imaging.ImageFormat]::Png);`,
    'Write-Output "OK"',
  ].join(' ');
  const r = await runCapture(deps, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (isENOENT(r.spawnError)) { return { kind: 'tool-missing', tool: 'PowerShell' }; }
  if (r.spawnError || r.timedOut) {
    return { kind: 'error', message: r.timedOut ? 'clipboard read timed out' : String(r.spawnError) };
  }
  if (r.stdout.toString().includes('NO_IMAGE')) { return { kind: 'no-image' }; }
  if (r.code !== 0) { return { kind: 'error', message: r.stderr.trim() || `powershell exited ${r.code}` }; }
  const bytes = await readTempPng(file);
  return bytes ? { kind: 'image', bytes, mime: 'image/png' } : { kind: 'no-image' };
}

export async function readClipboardImage(
  deps: ClipboardDeps = DEFAULT_DEPS,
): Promise<ClipboardImageResult> {
  switch (deps.platform()) {
    case 'darwin': return readMac(deps);
    case 'linux': return readLinux(deps);
    case 'win32': return readWindows(deps);
    default: return { kind: 'tool-missing', tool: 'a supported platform (macOS, Linux, or Windows)' };
  }
}
