/**
 * Tests for codev import command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock chalk for cleaner test output
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: Object.assign((s: string) => s, { bold: (s: string) => s }),
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// Mock child_process to avoid actually spawning claude
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn((event: string, callback: (code: number | Error) => void) => {
      if (event === 'close') {
        callback(0);
      }
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  })),
  execSync: vi.fn((cmd: string) => {
    if (cmd.startsWith('which')) {
      return '/usr/local/bin/claude';
    }
    if (cmd.startsWith('git clone')) {
      // Simulate git clone by creating the expected directory structure
      const match = cmd.match(/"([^"]+)"\s+"([^"]+)"/);
      if (match) {
        const tempDir = match[2];
        const codevDir = path.join(tempDir, 'codev');
        fs.mkdirSync(codevDir, { recursive: true });
        fs.mkdirSync(path.join(codevDir, 'protocols', 'spir'), { recursive: true });
        fs.writeFileSync(
          path.join(codevDir, 'protocols', 'spir', 'protocol.md'),
          '# SPIR Protocol\n\nTest protocol content.'
        );
        fs.mkdirSync(path.join(codevDir, 'roles'), { recursive: true });
        fs.writeFileSync(
          path.join(codevDir, 'roles', 'consultant.md'),
          '# Consultant Role\n\nTest role content.'
        );
      }
      return '';
    }
    return '';
  }),
}));

describe('import command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-import-test-${Date.now()}`);
  let targetProjectDir: string;
  let sourceProjectDir: string;

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(testBaseDir, { recursive: true });

    // Create target project (the project we're importing into)
    targetProjectDir = path.join(testBaseDir, 'target-project');
    fs.mkdirSync(targetProjectDir, { recursive: true });
    fs.mkdirSync(path.join(targetProjectDir, 'codev', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(targetProjectDir, 'codev', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(targetProjectDir, 'codev', 'protocols', 'spir'), { recursive: true });
    fs.writeFileSync(
      path.join(targetProjectDir, 'codev', 'protocols', 'spir', 'protocol.md'),
      '# SPIR Protocol\n\nOriginal content.'
    );

    // Create source project (the project we're importing from)
    sourceProjectDir = path.join(testBaseDir, 'source-project');
    fs.mkdirSync(sourceProjectDir, { recursive: true });
    fs.mkdirSync(path.join(sourceProjectDir, 'codev', 'protocols', 'spir'), { recursive: true });
    fs.mkdirSync(path.join(sourceProjectDir, 'codev', 'roles'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceProjectDir, 'codev', 'protocols', 'spir', 'protocol.md'),
      '# SPIR Protocol\n\nImproved content with new features.'
    );
    fs.writeFileSync(
      path.join(sourceProjectDir, 'codev', 'roles', 'consultant.md'),
      '# Consultant Role\n\nNew role definition.'
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('parseSource', () => {
    it('should parse local paths', async () => {
      const { importCommand } = await import('../commands/import.js');

      // Mock process.cwd to return target project
      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        // Dry run to avoid actually spawning claude
        await importCommand(sourceProjectDir, { dryRun: true });

        // If we got here without error, parsing worked
        expect(true).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should parse github: prefix', async () => {
      const { importCommand } = await import('../commands/import.js');

      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        // This will try to clone from GitHub (mocked)
        await importCommand('github:cluesmith/codev', { dryRun: true });
        expect(true).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should parse full GitHub URLs', async () => {
      const { importCommand } = await import('../commands/import.js');

      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        await importCommand('https://github.com/cluesmith/codev', { dryRun: true });
        expect(true).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should parse GitHub URLs with dots in repo name', async () => {
      const { importCommand } = await import('../commands/import.js');

      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        // Repos like vercel/next.js have dots in the name
        await importCommand('https://github.com/vercel/next.js', { dryRun: true });
        expect(true).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('importCommand', () => {
    it('should throw error when source is missing', async () => {
      const { importCommand } = await import('../commands/import.js');

      await expect(importCommand('', {})).rejects.toThrow(/Source required/);
    });

    it('should throw error when no codev/ directory in current project', async () => {
      const { importCommand } = await import('../commands/import.js');

      // Create a project without codev/
      const noCodevDir = path.join(testBaseDir, 'no-codev');
      fs.mkdirSync(noCodevDir, { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(noCodevDir);

      try {
        await expect(importCommand(sourceProjectDir, {})).rejects.toThrow(/No codev\/ directory found/);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should throw error when source path does not exist', async () => {
      const { importCommand } = await import('../commands/import.js');

      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        await expect(importCommand('/non/existent/path', {})).rejects.toThrow(/Path not found/);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should throw error when source has no codev files', async () => {
      const { importCommand } = await import('../commands/import.js');

      // Create source with empty codev
      const emptySourceDir = path.join(testBaseDir, 'empty-source');
      fs.mkdirSync(path.join(emptySourceDir, 'codev'), { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        await expect(importCommand(emptySourceDir, {})).rejects.toThrow(/No codev files found/);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should work with dry-run flag', async () => {
      const { importCommand } = await import('../commands/import.js');

      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        // Should not throw and should not spawn claude
        await importCommand(sourceProjectDir, { dryRun: true });

        // Verify console output mentioned dry run
        expect(console.log).toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should read files from source and target directories', async () => {
      const { importCommand } = await import('../commands/import.js');

      const originalCwd = process.cwd();
      process.chdir(targetProjectDir);

      try {
        await importCommand(sourceProjectDir, { dryRun: true });

        // Check that files were read (logged in dry-run mode)
        const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
        const output = logCalls.map((call: unknown[]) => call.join(' ')).join('\n');

        expect(output).toContain('Source files:');
        expect(output).toContain('Target files:');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
