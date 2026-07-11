/**
 * Unit tests for tower-utils.ts (Spec 0105 Phase 1)
 *
 * Tests: rate limiting, path normalization, temp directory detection,
 * workspace name extraction, MIME types, static file serving.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';

// We need to import the functions under test
import {
  isRateLimited,
  cleanupRateLimits,
  startRateLimitCleanup,
  normalizeWorkspacePath,
  isTempDirectory,
  serveStaticFile,
  resolveArchitectLaunch,
  resolveArchitectRestart,
  siblingRegistrationIsLive,
} from '../servers/tower-utils.js';

// resolveArchitectRestart reads the architect row via getArchitectByName; mock just
// that one export so the restart-bake wiring is testable without a live state.db.
vi.mock('../state.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../state.js');
  return { ...actual, getArchitectByName: vi.fn() };
});
import { getArchitectByName } from '../state.js';
import { encodeClaudeProjectDir } from '../utils/claude-session-discovery.js';

/**
 * Issue #1145: stored-id resume now requires the session jsonl to exist under
 * the (test-pinned) home dir. This writes a minimal session file so ownership
 * verification passes; omit it to simulate a stale stored id.
 */
function writeSessionFixture(homeDir: string, cwdPath: string, uuid: string): void {
  const dir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(cwdPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), `{"sessionId":"${uuid}"}\n`, 'utf-8');
}

describe('tower-utils', () => {
  describe('isRateLimited', () => {
    beforeEach(() => {
      // Clean up rate limit state between tests
      cleanupRateLimits();
    });

    it('allows first request from a client', () => {
      expect(isRateLimited('192.168.1.1')).toBe(false);
    });

    it('allows multiple requests within limit', () => {
      for (let i = 0; i < 9; i++) {
        expect(isRateLimited('192.168.1.2')).toBe(false);
      }
    });

    it('blocks requests exceeding rate limit', () => {
      // First 10 requests should be allowed
      for (let i = 0; i < 10; i++) {
        isRateLimited('192.168.1.3');
      }
      // 11th should be blocked
      expect(isRateLimited('192.168.1.3')).toBe(true);
    });

    it('tracks clients independently', () => {
      // Exhaust limit for client A
      for (let i = 0; i < 10; i++) {
        isRateLimited('client-a');
      }
      expect(isRateLimited('client-a')).toBe(true);
      // Client B should still be allowed
      expect(isRateLimited('client-b')).toBe(false);
    });

    it('resets after window expires', () => {
      vi.useFakeTimers();
      try {
        // Exhaust limit
        for (let i = 0; i < 10; i++) {
          isRateLimited('192.168.1.4');
        }
        expect(isRateLimited('192.168.1.4')).toBe(true);

        // Advance past the 1-minute window
        vi.advanceTimersByTime(61_000);

        // Should be allowed again
        expect(isRateLimited('192.168.1.4')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('cleanupRateLimits', () => {
    it('removes stale entries', () => {
      vi.useFakeTimers();
      try {
        // Create an entry
        isRateLimited('stale-client');

        // Advance past 2x the window (cleanup threshold)
        vi.advanceTimersByTime(121_000);

        cleanupRateLimits();

        // After cleanup, the client should get a fresh window
        // (first request in new window = not limited)
        expect(isRateLimited('stale-client')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('startRateLimitCleanup', () => {
    it('returns an interval handle', () => {
      vi.useFakeTimers();
      try {
        const handle = startRateLimitCleanup();
        expect(handle).toBeDefined();
        clearInterval(handle);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('normalizeWorkspacePath', () => {
    it('resolves existing paths with realpath', () => {
      // Use the current directory which exists
      const normalized = normalizeWorkspacePath('.');
      expect(path.isAbsolute(normalized)).toBe(true);
    });

    it('resolves non-existent paths with path.resolve', () => {
      const normalized = normalizeWorkspacePath('/nonexistent/path/to/workspace');
      expect(normalized).toBe('/nonexistent/path/to/workspace');
    });

    it('resolves relative paths', () => {
      const normalized = normalizeWorkspacePath('relative/path');
      expect(path.isAbsolute(normalized)).toBe(true);
    });
  });

  describe('isTempDirectory', () => {
    it('detects /tmp/ paths', () => {
      expect(isTempDirectory('/tmp/test-project')).toBe(true);
    });

    it('detects /private/tmp/ paths (macOS)', () => {
      expect(isTempDirectory('/private/tmp/test-project')).toBe(true);
    });

    it('detects OS tmpdir paths', () => {
      const tmp = tmpdir();
      expect(isTempDirectory(path.join(tmp, 'test-project'))).toBe(true);
    });

    it('rejects normal paths', () => {
      expect(isTempDirectory('/Users/dev/my-project')).toBe(false);
    });

    it('rejects paths that merely contain tmp', () => {
      expect(isTempDirectory('/Users/dev/tmp-stuff/project')).toBe(false);
    });
  });

  describe('serveStaticFile', () => {
    it('returns false for non-existent file', () => {
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };
      const result = serveStaticFile('/nonexistent/file.html', mockRes as any);
      expect(result).toBe(false);
      expect(mockRes.writeHead).not.toHaveBeenCalled();
    });

    it('serves existing file with correct MIME type', () => {
      // Create a temp file
      const tmpFile = path.join(tmpdir(), `test-${Date.now()}.html`);
      fs.writeFileSync(tmpFile, '<html>test</html>');

      try {
        const mockRes = {
          writeHead: vi.fn(),
          end: vi.fn(),
        };
        const result = serveStaticFile(tmpFile, mockRes as any);
        expect(result).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
        expect(mockRes.end).toHaveBeenCalled();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('uses application/octet-stream for unknown extensions', () => {
      const tmpFile = path.join(tmpdir(), `test-${Date.now()}.xyz`);
      fs.writeFileSync(tmpFile, 'data');

      try {
        const mockRes = {
          writeHead: vi.fn(),
          end: vi.fn(),
        };
        serveStaticFile(tmpFile, mockRes as any);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/octet-stream' });
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

});

describe('resolveArchitectLaunch (Issue #832)', () => {
  let workspace: string;
  let fakeHome: string;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  beforeEach(() => {
    // A bare temp dir: no codev/roles, so buildArchitectArgs returns baseArgs
    // unchanged (loadRolePrompt → null). Default harness resolves to Claude
    // (which has the session capability). fakeHome pins the session store the
    // ownership check (Issue #1145) reads.
    workspace = fs.mkdtempSync(path.join(tmpdir(), 'ral-ws-'));
    fakeHome = fs.mkdtempSync(path.join(tmpdir(), 'ral-home-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('resumes the stored id (no role injection) and echoes it back', () => {
    writeSessionFixture(fakeHome, workspace, 'stored-abc');
    const { args, env, sessionId, resumed } = resolveArchitectLaunch({
      workspacePath: workspace, name: 'reviewer', baseArgs: [], storedSessionId: 'stored-abc', homeDir: fakeHome,
    });
    expect(args).toEqual(['--resume', 'stored-abc']);
    expect(env).toEqual({});
    expect(sessionId).toBe('stored-abc');
    expect(resumed).toBe(true);   // drives the "Resuming…" log line at the callers
  });

  it('mints a fresh --session-id when there is no stored id, and returns it', () => {
    const { args, sessionId, resumed } = resolveArchitectLaunch({
      workspacePath: workspace, name: 'reviewer', baseArgs: [], storedSessionId: null, homeDir: fakeHome,
    });
    expect(args).not.toContain('--resume');
    expect(args).toContain('--session-id');
    // The id passed to --session-id is exactly the one returned for persistence.
    expect(args[args.indexOf('--session-id') + 1]).toBe(sessionId);
    expect(sessionId).toMatch(UUID_RE);
    expect(resumed).toBe(false);
  });

  it('mints distinct ids across fresh spawns', () => {
    const a = resolveArchitectLaunch({ workspacePath: workspace, name: 'a', baseArgs: [], homeDir: fakeHome }).sessionId;
    const b = resolveArchitectLaunch({ workspacePath: workspace, name: 'b', baseArgs: [], homeDir: fakeHome }).sessionId;
    expect(a).not.toBe(b);
  });

  it('preserves baseArgs ahead of the session flags', () => {
    writeSessionFixture(fakeHome, workspace, 'x');
    const { args } = resolveArchitectLaunch({
      workspacePath: workspace, name: 'main', baseArgs: ['--foo'], storedSessionId: 'x', homeDir: fakeHome,
    });
    expect(args).toEqual(['--foo', '--resume', 'x']);
  });

  it('two siblings with distinct stored ids resume independently (no cross-attachment)', () => {
    writeSessionFixture(fakeHome, workspace, 'rev-1');
    writeSessionFixture(fakeHome, workspace, 'casa-1');
    const reviewer = resolveArchitectLaunch({ workspacePath: workspace, name: 'reviewer', baseArgs: [], storedSessionId: 'rev-1', homeDir: fakeHome });
    const casa = resolveArchitectLaunch({ workspacePath: workspace, name: 'casa', baseArgs: [], storedSessionId: 'casa-1', homeDir: fakeHome });
    expect(reviewer.args).toEqual(['--resume', 'rev-1']);
    expect(casa.args).toEqual(['--resume', 'casa-1']);
  });

  // Issue #1145: ownership verification ahead of the resume branch.

  it('spawns fresh when the stored id has no jsonl on disk (stale stored id)', () => {
    const { args, sessionId, resumed } = resolveArchitectLaunch({
      workspacePath: workspace, name: 'main', baseArgs: [], storedSessionId: 'ghost-id', homeDir: fakeHome,
    });
    expect(args).not.toContain('--resume');
    expect(args).toContain('--session-id');
    expect(resumed).toBe(false);
    expect(sessionId).toMatch(UUID_RE);          // replacement id for the caller to persist
    expect(sessionId).not.toBe('ghost-id');
  });

  it('spawns fresh when the stored session file lives under a different cwd', () => {
    writeSessionFixture(fakeHome, '/somewhere/else/entirely', 'foreign-id');
    const { args, resumed, sessionId } = resolveArchitectLaunch({
      workspacePath: workspace, name: 'main', baseArgs: [], storedSessionId: 'foreign-id', homeDir: fakeHome,
    });
    expect(args).not.toContain('--resume');
    expect(resumed).toBe(false);
    expect(sessionId).not.toBe('foreign-id');
  });

  it('no-session harness → plain fresh, returns null sessionId', () => {
    // Force a Codex architect harness (no `session` capability) via config.
    fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codev', 'config.json'),
      JSON.stringify({ shell: { architect: 'codex' } }),
    );
    const { args, sessionId, resumed } = resolveArchitectLaunch({
      workspacePath: workspace, name: 'main', baseArgs: ['--base'], storedSessionId: null,
    });
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(sessionId).toBeNull();
    expect(resumed).toBe(false);
  });
});

describe('siblingRegistrationIsLive (Issue #1150)', () => {
  let workspace: string;
  let fakeHome: string;

  beforeEach(() => {
    // Bare temp dir → default Claude harness (session-capable, with the
    // #1145 verifyOwnership check). fakeHome pins the session store.
    workspace = fs.mkdtempSync(path.join(tmpdir(), 'srl-ws-'));
    fakeHome = fs.mkdtempSync(path.join(tmpdir(), 'srl-home-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function forceCodexHarness(): void {
    fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codev', 'config.json'),
      JSON.stringify({ shell: { architect: 'codex' } }),
    );
  }

  it('live when the stored session jsonl exists on disk', () => {
    writeSessionFixture(fakeHome, workspace, 'sib-1');
    expect(siblingRegistrationIsLive(workspace, 'sib-1', { homeDir: fakeHome })).toBe(true);
  });

  it('dead when the stored session jsonl is missing (stale registration)', () => {
    expect(siblingRegistrationIsLive(workspace, 'gone-1', { homeDir: fakeHome })).toBe(false);
  });

  it('dead when a session-capable harness row has no stored id (legacy pre-#832 row)', () => {
    expect(siblingRegistrationIsLive(workspace, null, { homeDir: fakeHome })).toBe(false);
  });

  it('live for a session-less harness regardless of stored id (Spec 786 persistence preserved)', () => {
    // Codex has no `session` capability: its rows can never carry session
    // evidence and respawn is always fresh, so they must not be pruned.
    forceCodexHarness();
    expect(siblingRegistrationIsLive(workspace, null, { homeDir: fakeHome })).toBe(true);
    expect(siblingRegistrationIsLive(workspace, 'whatever', { homeDir: fakeHome })).toBe(true);
  });

  it('dead when the jsonl lives under a different cwd (not this workspace\'s session)', () => {
    writeSessionFixture(fakeHome, '/somewhere/else/entirely', 'foreign-1');
    expect(siblingRegistrationIsLive(workspace, 'foreign-1', { homeDir: fakeHome })).toBe(false);
  });
});

describe('resolveArchitectRestart (Issue #832 — shellper auto-restart bake)', () => {
  let workspace: string;
  let fakeHome: string;
  const mockGet = vi.mocked(getArchitectByName);

  beforeEach(() => {
    // Bare temp dir → default Claude harness (has the session capability).
    workspace = fs.mkdtempSync(path.join(tmpdir(), 'rar-ws-'));
    fakeHome = fs.mkdtempSync(path.join(tmpdir(), 'rar-home-'));
    mockGet.mockReset();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('revives the architect\'s stored session id on restart (--resume, no role injection)', () => {
    writeSessionFixture(fakeHome, workspace, 'stored-xyz');
    mockGet.mockReturnValue({ name: 'reviewer', cmd: 'claude', startedAt: 'x', sessionId: 'stored-xyz' } as never);
    const { args, env, resumed, storedSessionId } = resolveArchitectRestart(workspace, 'reviewer', [], { homeDir: fakeHome });
    expect(mockGet).toHaveBeenCalledWith(workspace, 'reviewer');
    expect(args).toEqual(['--resume', 'stored-xyz']);
    expect(env).toEqual({});
    expect(resumed).toBe(true);              // drives the "Resuming…" log line at the bake sites
    expect(storedSessionId).toBe('stored-xyz');
  });

  it('spawns fresh on restart when the stored session fails ownership verification (#1145)', () => {
    // No jsonl fixture written → stale stored id.
    mockGet.mockReturnValue({ name: 'reviewer', cmd: 'claude', startedAt: 'x', sessionId: 'stale-xyz' } as never);
    const { args, resumed, storedSessionId } = resolveArchitectRestart(workspace, 'reviewer', [], { homeDir: fakeHome });
    expect(args).not.toContain('--resume');
    expect(args).toContain('--session-id');
    expect(resumed).toBe(false);
    expect(storedSessionId).toBe('stale-xyz'); // still reported for the caller's log line
  });

  it('falls back to a fresh session when the row has no stored id (legacy / self-heal)', () => {
    mockGet.mockReturnValue({ name: 'reviewer', cmd: 'claude', startedAt: 'x' } as never); // no sessionId
    const { args, resumed, storedSessionId } = resolveArchitectRestart(workspace, 'reviewer', []);
    expect(storedSessionId).toBeNull();
    expect(resumed).toBe(false);
    expect(args).toContain('--session-id');  // minted fresh, with role injection
    expect(args).not.toContain('--resume');
  });

  it('falls back to a fresh session when no architect row exists', () => {
    mockGet.mockReturnValue(undefined as never);
    const { args, resumed, storedSessionId } = resolveArchitectRestart(workspace, 'ghost', []);
    expect(storedSessionId).toBeNull();
    expect(resumed).toBe(false);
    expect(args).not.toContain('--resume');
  });

  it('looks each architect up by its own name — no cross-attachment between siblings', () => {
    writeSessionFixture(fakeHome, workspace, 'rev-1');
    writeSessionFixture(fakeHome, workspace, 'casa-1');
    mockGet.mockImplementation((_ws: string, name: string) =>
      (name === 'reviewer' ? { sessionId: 'rev-1' } : { sessionId: 'casa-1' }) as never);
    expect(resolveArchitectRestart(workspace, 'reviewer', [], { homeDir: fakeHome }).args).toEqual(['--resume', 'rev-1']);
    expect(resolveArchitectRestart(workspace, 'casa', [], { homeDir: fakeHome }).args).toEqual(['--resume', 'casa-1']);
  });
});
