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
  getWorkspaceName,
  isTempDirectory,
  getLanguageForExt,
  getMimeTypeForFile,
  MIME_TYPES,
  serveStaticFile,
} from '../servers/tower-utils.js';

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

  describe('getWorkspaceName', () => {
    it('extracts basename from path', () => {
      expect(getWorkspaceName('/Users/dev/my-project')).toBe('my-project');
    });

    it('handles paths with trailing slash', () => {
      // path.basename handles trailing slash by taking the last segment
      expect(getWorkspaceName('/Users/dev/project/')).toBe('project');
    });

    it('handles simple names', () => {
      expect(getWorkspaceName('project')).toBe('project');
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

  describe('getLanguageForExt', () => {
    it('returns known language identifiers', () => {
      expect(getLanguageForExt('ts')).toBe('typescript');
      expect(getLanguageForExt('js')).toBe('javascript');
      expect(getLanguageForExt('py')).toBe('python');
      expect(getLanguageForExt('rs')).toBe('rust');
    });

    it('returns extension itself for unknown languages', () => {
      expect(getLanguageForExt('xyz')).toBe('xyz');
    });

    it('returns plaintext for empty/undefined extension', () => {
      expect(getLanguageForExt('')).toBe('plaintext');
    });
  });

  describe('getMimeTypeForFile', () => {
    it('returns correct MIME type for known extensions', () => {
      expect(getMimeTypeForFile('image.png')).toBe('image/png');
      expect(getMimeTypeForFile('video.mp4')).toBe('video/mp4');
      expect(getMimeTypeForFile('doc.pdf')).toBe('application/pdf');
    });

    it('returns octet-stream for unknown extensions', () => {
      expect(getMimeTypeForFile('file.xyz')).toBe('application/octet-stream');
    });

    it('handles uppercase extensions via toLowerCase', () => {
      expect(getMimeTypeForFile('IMAGE.PNG')).toBe('image/png');
    });
  });

  describe('MIME_TYPES', () => {
    it('contains expected content types', () => {
      expect(MIME_TYPES['.html']).toBe('text/html');
      expect(MIME_TYPES['.js']).toBe('application/javascript');
      expect(MIME_TYPES['.css']).toBe('text/css');
      expect(MIME_TYPES['.json']).toBe('application/json');
      expect(MIME_TYPES['.svg']).toBe('image/svg+xml');
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
