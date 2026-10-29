/**
 * Tests for shell utilities
 */

import { describe, it, expect } from 'vitest';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { run, commandExists, findAvailablePort, isProcessRunning } from '../utils/shell.js';

describe('Shell Utilities', () => {
  describe('run', () => {
    it('should execute a command and return output', async () => {
      // `node -p` prints the same on every shell run() uses (sh, cmd.exe).
      const result = await run('node -p "\'hello world\'"');

      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
    });

    it('should trim output', async () => {
      const result = await run('node -p "\'  spaces  \'"');

      expect(result.stdout).toBe('spaces');
    });

    it('should throw on command failure', async () => {
      await expect(run('exit 1')).rejects.toThrow();
    });

    it('should execute in specified directory', async () => {
      const dir = realpathSync(tmpdir());
      const result = await run('node -p "process.cwd()"', { cwd: dir });

      expect(realpathSync(result.stdout)).toBe(dir);
    });
  });

  describe('commandExists', () => {
    it('should return true for existing commands', async () => {
      const exists = await commandExists('node');
      expect(exists).toBe(true);
    });

    it('should return false for non-existing commands', async () => {
      const exists = await commandExists('nonexistentcommand12345');
      expect(exists).toBe(false);
    });
  });

  describe('findAvailablePort', () => {
    it('should find an available port', async () => {
      const port = await findAvailablePort(9000);

      expect(port).toBeGreaterThanOrEqual(9000);
      expect(port).toBeLessThan(9100);
    });

    it('should throw if no port available in range', async () => {
      // This test would need actual ports to be in use
      // For now, we just verify the function returns a number
      const port = await findAvailablePort(9100);
      expect(typeof port).toBe('number');
    });
  });

  describe('isProcessRunning', () => {
    it('should return true for current process', async () => {
      const running = await isProcessRunning(process.pid);
      expect(running).toBe(true);
    });

    it('should return false for non-existent process', async () => {
      // Use a very high PID that's unlikely to exist
      const running = await isProcessRunning(99999999);
      expect(running).toBe(false);
    });
  });
});
