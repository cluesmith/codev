/**
 * Spec 1658 Phase 6: the Node `tail -f` behind `afx tower log --follow` on
 * Windows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { followFile } from '../lib/file-follow.js';

let workDir: string;
let file: string;

beforeEach(() => {
  vi.useFakeTimers();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-1658-follow-'));
  file = path.join(workDir, 'tower.log');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('followFile', () => {
  it('prints the last lines, then appended bytes', () => {
    fs.writeFileSync(file, Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const out: string[] = [];
    const follower = followFile(file, (text) => out.push(text), { initialLines: 3, intervalMs: 100 });
    expect(out).toEqual(['line 13\nline 14\nline 15\n']);

    fs.appendFileSync(file, 'line 16\n');
    vi.advanceTimersByTime(100);
    expect(out[1]).toBe('line 16\n');

    vi.advanceTimersByTime(300);
    expect(out).toHaveLength(2);
    follower.stop();
  });

  it('follows a truncated file again from its start', () => {
    fs.writeFileSync(file, 'old line one\nold line two\n');
    const out: string[] = [];
    const follower = followFile(file, (text) => out.push(text), { initialLines: 0, intervalMs: 100 });
    expect(out).toEqual([]);

    fs.writeFileSync(file, 'new\n');
    vi.advanceTimersByTime(100);
    expect(out).toEqual(['new\n']);
    follower.stop();
  });

  it('waits for a file that does not exist yet', () => {
    const out: string[] = [];
    const follower = followFile(file, (text) => out.push(text), { intervalMs: 100 });
    expect(out).toEqual([]);
    fs.writeFileSync(file, 'hello\n');
    vi.advanceTimersByTime(100);
    expect(out).toEqual(['hello\n']);
    follower.stop();
  });

  it('keeps a multi-byte character split across polls intact', () => {
    fs.writeFileSync(file, '');
    const out: string[] = [];
    const follower = followFile(file, (text) => out.push(text), { intervalMs: 100 });
    const bytes = Buffer.from('é\n', 'utf-8');
    fs.appendFileSync(file, bytes.subarray(0, 1));
    vi.advanceTimersByTime(100);
    fs.appendFileSync(file, bytes.subarray(1));
    vi.advanceTimersByTime(100);
    expect(out.join('')).toBe('é\n');
    follower.stop();
  });
});
