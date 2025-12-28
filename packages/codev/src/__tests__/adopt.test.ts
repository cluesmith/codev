/**
 * Tests for codev adopt command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Mock readline to avoid interactive prompts
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
      callback('y'); // Default yes for tests
    }),
    close: vi.fn(),
  })),
}));

// Mock child_process spawn to avoid launching Claude, but keep execSync for Ruler tests
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      on: vi.fn(),
      stdout: null,
      stderr: null,
    })),
  };
});

// Mock chalk for cleaner test output
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: Object.assign((s: string) => s, { bold: (s: string) => s }),
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// Mock process.exit to prevent tests from exiting
vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
  throw new Error(`process.exit(${code})`);
});

describe('adopt command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-adopt-test-${Date.now()}`);
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    fs.mkdirSync(testBaseDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('adopt function', () => {
    it('should add codev to existing project with --yes flag', async () => {
      const projectDir = path.join(testBaseDir, 'existing-project');
      fs.mkdirSync(projectDir, { recursive: true });

      // Create some existing files to simulate an existing project
      fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // Verify codev structure was created
      expect(fs.existsSync(path.join(projectDir, 'codev'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(true);

      // Verify user data directories
      expect(fs.existsSync(path.join(projectDir, 'codev', 'specs'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'codev', 'plans'))).toBe(true);
    });

    it('should throw error if codev directory already exists', async () => {
      const projectDir = path.join(testBaseDir, 'has-codev');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await expect(adopt({ yes: true })).rejects.toThrow(/already exists/);
    });

    it('should create .codev-new for existing CLAUDE.md', async () => {
      const projectDir = path.join(testBaseDir, 'has-claude');
      fs.mkdirSync(projectDir, { recursive: true });

      const originalContent = '# My Custom CLAUDE.md';
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), originalContent);

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // Verify CLAUDE.md was not overwritten
      const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe(originalContent);

      // Verify .codev-new was created for merge
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md.codev-new'))).toBe(true);
    });

    it('should update .gitignore if it exists', async () => {
      const projectDir = path.join(testBaseDir, 'has-gitignore');
      fs.mkdirSync(projectDir, { recursive: true });

      fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n');

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      const gitignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('node_modules/');
      expect(gitignore).toContain('.agent-farm/');
    });

    it('should create .gitignore if it does not exist', async () => {
      const projectDir = path.join(testBaseDir, 'no-gitignore');
      fs.mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(true);
      const gitignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.agent-farm/');
    });
  });

  describe('conflict detection', () => {
    it('should detect CLAUDE.md conflict and create .codev-new', async () => {
      const projectDir = path.join(testBaseDir, 'conflict-test');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing');

      process.chdir(projectDir);

      // The adopt function should proceed but create .codev-new for the conflicting file
      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // CLAUDE.md should be preserved
      const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe('# Existing');

      // .codev-new should be created for merge
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md.codev-new'))).toBe(true);
    });
  });

  describe('Ruler support', () => {
    it('should create .ruler/codev.md for Ruler projects (no root files)', async () => {
      const projectDir = path.join(testBaseDir, 'ruler-project');
      fs.mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);

      // Initialize Ruler project
      execSync('npx @intellectronica/ruler init', { stdio: 'pipe' });

      // Verify Ruler was initialized
      expect(fs.existsSync(path.join(projectDir, '.ruler', 'ruler.toml'))).toBe(true);

      // Run codev adopt
      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // Verify .ruler/codev.md was created
      expect(fs.existsSync(path.join(projectDir, '.ruler', 'codev.md'))).toBe(true);

      // Verify codev.md contains expected content
      const codevMd = fs.readFileSync(path.join(projectDir, '.ruler', 'codev.md'), 'utf-8');
      expect(codevMd).toContain('codev');

      // Verify NO root files created (Ruler generates these via `apply`)
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(false);
    });

    it('should create .codev-new for existing .ruler/codev.md', async () => {
      const projectDir = path.join(testBaseDir, 'ruler-conflict');
      fs.mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);

      // Initialize Ruler project
      execSync('npx @intellectronica/ruler init', { stdio: 'pipe' });

      // Create existing .ruler/codev.md with custom content
      const originalContent = '# My Custom Codev Config';
      fs.writeFileSync(path.join(projectDir, '.ruler', 'codev.md'), originalContent);

      // Run codev adopt
      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // Verify original .ruler/codev.md was preserved
      const content = fs.readFileSync(path.join(projectDir, '.ruler', 'codev.md'), 'utf-8');
      expect(content).toBe(originalContent);

      // Verify .codev-new was created for merge
      expect(fs.existsSync(path.join(projectDir, '.ruler', 'codev.md.codev-new'))).toBe(true);
    });

    it('E2E: ruler apply should include codev config in CLAUDE.md', async () => {
      const projectDir = path.join(testBaseDir, 'ruler-e2e');
      fs.mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);

      // Initialize Ruler project
      execSync('npx @intellectronica/ruler init', { stdio: 'pipe' });

      // Run codev adopt
      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // Run ruler apply to generate CLAUDE.md
      execSync('npx @intellectronica/ruler apply', { stdio: 'pipe' });

      // Verify CLAUDE.md was generated and contains codev content
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);
      const claudeMd = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');

      // Should contain content from .ruler/codev.md
      expect(claudeMd).toContain('codev');
    });
  });
});
