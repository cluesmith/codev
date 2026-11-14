/**
 * #1898 — consult's builder-context project auto-detect failed in slugless worktrees.
 *
 * Spec 653 made worktrees ID-only (`.builders/bugfix-N`, `.builders/spir-N`), but
 * `getBuilderProjectState()` disambiguated multiple project dirs with a regex that demanded a
 * `-<slug>` after the number. Every hand-run `consult --type …` in a fresh builder worktree fell
 * through to a throw that joined every project dir name into one line (~95k chars at ~2300 dirs).
 *
 * Pinned here:
 *  - slugless root, a subdirectory of it, a slugged worktree, a SPIR worktree, and a tracker-key
 *    worktree each resolve to their own project among several;
 *  - a bugfix worktree resolves to `bugfix-N-…`, not to a same-numbered SPIR project;
 *  - every not-found error is one short line naming what was tried, never the project list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _getBuilderProjectState as getBuilderProjectState } from '../index.js';

let ws: string;

function addProject(dir: string, id?: string): void {
  const full = join(ws, 'codev', 'projects', dir);
  mkdirSync(full, { recursive: true });
  if (id) writeFileSync(join(full, 'status.yaml'), `id: '${id}'\ntitle: ${dir}\nphase: fix\niteration: 1\n`);
}

function inCwd(rel: string): void {
  vi.spyOn(process, 'cwd').mockReturnValue(join(ws, rel));
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'consult-1898-'));
  addProject('bugfix-7438-the-bug', 'bugfix-7438');
  addProject('7438-spir-with-same-number', '7438');
  addProject('12-a-spir-feature', '12');
  addProject('ENG-123-tracker-thing', 'ENG-123');
  addProject('0087-older-project', '0087');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(ws, { recursive: true, force: true });
});

describe('getBuilderProjectState — worktree auto-detect (#1898)', () => {
  it('resolves a slugless bugfix worktree root', () => {
    inCwd('.builders/bugfix-7438');
    expect(getBuilderProjectState(ws).id).toBe('bugfix-7438');
  });

  it('resolves from a subdirectory of a slugless worktree', () => {
    inCwd('.builders/bugfix-7438/packages/x');
    expect(getBuilderProjectState(ws).id).toBe('bugfix-7438');
  });

  it('still resolves a slugged worktree, to the bugfix project not the same-numbered SPIR one', () => {
    inCwd('.builders/bugfix-7438-some-slug');
    expect(getBuilderProjectState(ws).id).toBe('bugfix-7438');
  });

  it('resolves a slugless SPIR worktree', () => {
    inCwd('.builders/spir-12');
    expect(getBuilderProjectState(ws).id).toBe('12');
  });

  it('resolves a tracker-key worktree', () => {
    inCwd('.builders/pir-ENG-123/src');
    expect(getBuilderProjectState(ws).id).toBe('ENG-123');
  });
});

describe('getBuilderProjectState — errors never list the projects (#1898)', () => {
  const MAX_ERROR = 300;

  function errorFrom(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected getBuilderProjectState to throw');
  }

  beforeEach(() => {
    for (let i = 0; i < 2300; i++) addProject(`bugfix-${10000 + i}-some-long-project-slug-here`);
  });

  it('a worktree ID with no matching project: one short line naming the ID and the escape hatch', () => {
    inCwd('.builders/bugfix-9999');
    const message = errorFrom(() => getBuilderProjectState(ws));
    expect(message.length).toBeLessThan(MAX_ERROR);
    expect(message).toContain('bugfix-9999');
    expect(message).toContain('2305 projects');
    expect(message).toContain('--issue <N>');
    expect(message).not.toContain('0087-older-project');
  });

  it('a cwd with no worktree ID: one short line naming the path tried', () => {
    inCwd('somewhere/else');
    const message = errorFrom(() => getBuilderProjectState(ws));
    expect(message.length).toBeLessThan(MAX_ERROR + ws.length);
    expect(message).toContain(join(ws, 'somewhere/else'));
    expect(message).toContain('--project-id <id>');
    expect(message).not.toContain('0087-older-project');
  });

  it('an unknown --project-id: one short line', () => {
    inCwd('.builders/bugfix-7438');
    const message = errorFrom(() => getBuilderProjectState(ws, '424242'));
    expect(message.length).toBeLessThan(MAX_ERROR);
    expect(message).toContain('424242');
    expect(message).not.toContain('0087-older-project');
  });
});
