/**
 * Tests for codev init command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock readline to avoid interactive prompts
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
      callback('');
    }),
    close: vi.fn(),
  })),
}));

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

describe('init command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-init-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testBaseDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('init function', () => {
    it('should create project with --yes flag', async () => {
      const projectDir = path.join(testBaseDir, 'test-project');

      // Need to mock the templates directory
      const { init } = await import('../commands/init.js');

      // Change to test directory
      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await init('test-project', { yes: true });

        // Verify project structure was created
        expect(fs.existsSync(projectDir)).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'codev'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(true);

        // Verify user data directories (minimal structure)
        expect(fs.existsSync(path.join(projectDir, 'codev', 'specs'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'codev', 'plans'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'codev', 'reviews'))).toBe(true);
        // Spec 0126: projectlist.md is no longer created
        expect(fs.existsSync(path.join(projectDir, 'codev', 'projectlist.md'))).toBe(false);
        // Note: resources/ is NOT created in minimal structure (created by user if needed)
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should throw error when directory exists', async () => {
      const projectDir = path.join(testBaseDir, 'existing-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const { init } = await import('../commands/init.js');

      await expect(init(projectDir, { yes: true })).rejects.toThrow(/already exists/);
    });

    it('should throw error when --yes without project name', async () => {
      const { init } = await import('../commands/init.js');

      await expect(init(undefined, { yes: true })).rejects.toThrow(/Project name is required/);
    });

    it('should replace project name placeholder in templates', async () => {
      const projectDir = path.join(testBaseDir, 'my-custom-project');

      const { init } = await import('../commands/init.js');
      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await init('my-custom-project', { yes: true });

        const claudeContent = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
        expect(claudeContent).toContain('my-custom-project');
        expect(claudeContent).not.toContain('{{PROJECT_NAME}}');
      } finally {
        process.chdir(originalCwd);
      }
    });

    // Regression test for issue #266: codev init does not copy roles/
    it('should copy roles directory with architect, builder, consultant', async () => {
      const projectDir = path.join(testBaseDir, 'roles-test');

      const { init } = await import('../commands/init.js');
      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await init('roles-test', { yes: true });

        expect(fs.existsSync(path.join(projectDir, 'codev', 'roles'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'codev', 'roles', 'architect.md'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'codev', 'roles', 'builder.md'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'codev', 'roles', 'consultant.md'))).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should create .gitignore with codev entries', async () => {
      const projectDir = path.join(testBaseDir, 'gitignore-test');

      const { init } = await import('../commands/init.js');
      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await init('gitignore-test', { yes: true });

        const gitignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
        expect(gitignore).toContain('.agent-farm/');
        expect(gitignore).toContain('.consult/');
        expect(gitignore).toContain('.builders/');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
