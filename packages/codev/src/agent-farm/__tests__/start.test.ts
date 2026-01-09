/**
 * Tests for start command utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRemote, isPortAvailable } from '../commands/start.js';
import * as net from 'net';
import * as shell from '../utils/shell.js';

describe('parseRemote', () => {
  it('should parse user@host format', () => {
    const result = parseRemote('alice@example.com');

    expect(result.user).toBe('alice');
    expect(result.host).toBe('example.com');
    expect(result.remotePath).toBeUndefined();
  });

  it('should parse user@host:/path format', () => {
    const result = parseRemote('bob@192.168.1.100:/home/bob/project');

    expect(result.user).toBe('bob');
    expect(result.host).toBe('192.168.1.100');
    expect(result.remotePath).toBe('/home/bob/project');
  });

  it('should parse relative path', () => {
    const result = parseRemote('tidybot@robot:robot-project');

    expect(result.user).toBe('tidybot');
    expect(result.host).toBe('robot');
    expect(result.remotePath).toBe('robot-project');
  });

  it('should parse path with tilde', () => {
    const result = parseRemote('user@server:~/projects/myapp');

    expect(result.user).toBe('user');
    expect(result.host).toBe('server');
    expect(result.remotePath).toBe('~/projects/myapp');
  });

  it('should throw for invalid format: missing @', () => {
    expect(() => parseRemote('just-a-host')).toThrow('Invalid remote format');
  });

  it('should throw for empty string', () => {
    expect(() => parseRemote('')).toThrow('Invalid remote format');
  });

  it('should throw for malformed: @host only', () => {
    expect(() => parseRemote('@host')).toThrow('Invalid remote format');
  });

  it('should throw for malformed: user@ only', () => {
    expect(() => parseRemote('user@')).toThrow('Invalid remote format');
  });

  it('should handle complex hostnames', () => {
    const result = parseRemote('deploy@my-server.internal.company.com');

    expect(result.user).toBe('deploy');
    expect(result.host).toBe('my-server.internal.company.com');
    expect(result.remotePath).toBeUndefined();
  });

  it('should handle complex paths', () => {
    const result = parseRemote('admin@server:/var/www/app-name_v2/current');

    expect(result.user).toBe('admin');
    expect(result.host).toBe('server');
    expect(result.remotePath).toBe('/var/www/app-name_v2/current');
  });
});

describe('isPortAvailable', () => {
  it('should detect when port is available', async () => {
    // Use a high port that's unlikely to be in use
    const port = 59999;
    const available = await isPortAvailable(port);
    expect(available).toBe(true);
  });

  it('should detect when port is in use', async () => {
    // Create a server on a port
    const port = 59998;
    const server = net.createServer();

    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve());
    });

    try {
      const available = await isPortAvailable(port);
      expect(available).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Tests for stale architect state recovery (Issue #148)
 *
 * These tests verify that the isProcessRunning check correctly identifies
 * dead PIDs and allows recovery from stale state.
 *
 * Note: Tests for setArchitect(null) clearing state are in state.test.ts
 * which properly mocks the database to avoid mutating live state.
 */
describe('stale architect state recovery', () => {
  it('isProcessRunning returns false for definitely-dead PID', async () => {
    // PID 999999 is virtually guaranteed not to exist on any system
    const result = await shell.isProcessRunning(999999);
    expect(result).toBe(false);
  });

  it('isProcessRunning returns true for current process PID', async () => {
    // Our own process is definitely running
    const result = await shell.isProcessRunning(process.pid);
    expect(result).toBe(true);
  });
});
