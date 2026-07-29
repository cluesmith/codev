/**
 * Tests for per-harness message-pacing resolution (Issue #1201).
 *
 * The marker-file probe is the load-bearing design point: it makes pacing
 * correct even for builders spawned with a per-spawn `--builder-cmd kimi`
 * override (which workspace config knows nothing about) and survives Tower
 * restarts, because the marker lives in the worktree next to the session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KIMI_HARNESS, CLAUDE_HARNESS } from '../../utils/harness.js';

const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: existsSyncMock };
});

const getTerminalSessionByIdMock = vi.hoisted(() => vi.fn(() => null as unknown));
vi.mock('../tower-terminals.js', () => ({
  getTerminalSessionById: getTerminalSessionByIdMock,
}));

const getBuilderHarnessMock = vi.hoisted(() => vi.fn());
const getArchitectHarnessMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/config.js', () => ({
  getBuilderHarness: getBuilderHarnessMock,
  getArchitectHarness: getArchitectHarnessMock,
}));

import { resolvePacingForSession } from '../message-pacing.js';

describe('resolvePacingForSession', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(false);
    getTerminalSessionByIdMock.mockReset().mockReturnValue(null);
    getBuilderHarnessMock.mockReset().mockReturnValue(CLAUDE_HARNESS);
    getArchitectHarnessMock.mockReset().mockReturnValue(CLAUDE_HARNESS);
  });

  it('kimi marker in the session cwd → kimi pacing, without consulting config (override-proof)', () => {
    existsSyncMock.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('/wt/.builder-kimi-session'));
    const pacing = resolvePacingForSession({ id: 't1', cwd: '/wt' });
    expect(pacing).toBe(KIMI_HARNESS.messagePacing);
    expect(getBuilderHarnessMock).not.toHaveBeenCalled();
  });

  it('falls back to the persisted row cwd when the live session has none (post-restart rehydrate)', () => {
    getTerminalSessionByIdMock.mockReturnValue({
      id: 't2', workspace_path: '/ws', type: 'builder', cwd: '/row-wt',
    });
    existsSyncMock.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('/row-wt/.builder-kimi-session'));
    expect(resolvePacingForSession({ id: 't2' })).toBe(KIMI_HARNESS.messagePacing);
  });

  it('no marker → config-resolved builder harness pacing for builder terminals', () => {
    getTerminalSessionByIdMock.mockReturnValue({
      id: 't3', workspace_path: '/ws', type: 'builder', cwd: '/wt',
    });
    getBuilderHarnessMock.mockReturnValue(KIMI_HARNESS);
    expect(resolvePacingForSession({ id: 't3', cwd: '/wt' })).toBe(KIMI_HARNESS.messagePacing);
    expect(getBuilderHarnessMock).toHaveBeenCalledWith('/ws');
  });

  it('architect terminals resolve via the architect harness', () => {
    getTerminalSessionByIdMock.mockReturnValue({
      id: 't4', workspace_path: '/ws', type: 'architect', cwd: '/ws',
    });
    resolvePacingForSession({ id: 't4', cwd: '/ws' });
    expect(getArchitectHarnessMock).toHaveBeenCalledWith('/ws');
    expect(getBuilderHarnessMock).not.toHaveBeenCalled();
  });

  it('claude everywhere → undefined (default pacing, regression)', () => {
    getTerminalSessionByIdMock.mockReturnValue({
      id: 't5', workspace_path: '/ws', type: 'builder', cwd: '/wt',
    });
    expect(resolvePacingForSession({ id: 't5', cwd: '/wt' })).toBeUndefined();
  });

  it('unregistered terminal without a marker → undefined', () => {
    expect(resolvePacingForSession({ id: 'ghost', cwd: '/wt' })).toBeUndefined();
  });

  it('bare override-spawn marker (empty file, as `touch` creates) → kimi pacing over claude config', async () => {
    // PR #1203 review regression: the bare launch shape persists the marker
    // EMPTY (no seeded id). The probe must key off existence, not content —
    // a content-based probe would send a bare `--builder-cmd kimi` builder
    // back to claude's Enter timing. Real fs, real empty file.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = realFs.mkdtempSync(join(tmpdir(), 'pacing-bare-'));
    try {
      realFs.writeFileSync(join(dir, '.builder-kimi-session'), '');
      existsSyncMock.mockImplementation(realFs.existsSync);
      getTerminalSessionByIdMock.mockReturnValue({
        id: 't8', workspace_path: '/ws', type: 'builder', cwd: dir,
      });
      expect(resolvePacingForSession({ id: 't8', cwd: dir })).toBe(KIMI_HARNESS.messagePacing);
      expect(getBuilderHarnessMock).not.toHaveBeenCalled();
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a throwing harness resolution (unknown explicit name) degrades to default pacing', () => {
    getTerminalSessionByIdMock.mockReturnValue({
      id: 't6', workspace_path: '/ws', type: 'builder', cwd: '/wt',
    });
    getBuilderHarnessMock.mockImplementation(() => { throw new Error('Unknown harness "typo"'); });
    expect(resolvePacingForSession({ id: 't6', cwd: '/wt' })).toBeUndefined();
  });
});
