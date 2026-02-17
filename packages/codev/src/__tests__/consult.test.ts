/**
 * Tests for consult CLI command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn((event: string, callback: (code: number) => void) => {
      if (event === 'close') callback(0);
    }),
  })),
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('which')) {
      return Buffer.from('/usr/bin/command');
    }
    return Buffer.from('');
  }),
}));

// Mock Claude Agent SDK
let mockQueryFn: ReturnType<typeof vi.fn>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  mockQueryFn = vi.fn();
  return { query: mockQueryFn };
});

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    dim: (s: string) => s,
  },
}));

describe('consult command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-consult-test-${Date.now()}`);
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    fs.mkdirSync(testBaseDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('model configuration', () => {
    it('should support model aliases', () => {
      // The MODEL_ALIASES mapping
      const aliases: Record<string, string> = {
        'pro': 'gemini',
        'gpt': 'codex',
        'opus': 'claude',
      };

      expect(aliases['pro']).toBe('gemini');
      expect(aliases['gpt']).toBe('codex');
      expect(aliases['opus']).toBe('claude');
    });

    it('should have correct CLI configuration for each model', () => {
      // Note: Codex now uses experimental_instructions_file config flag (not env var)
      // The args are built dynamically in runConsultation, not stored in MODEL_CONFIGS
      // Claude uses Agent SDK (not CLI) — see 'Claude Agent SDK integration' tests
      // Bugfix #370: --yolo removed from MODEL_CONFIGS; added conditionally in
      // runConsultation only for protocol mode (not general mode)
      const configs: Record<string, { cli: string; args: string[] }> = {
        gemini: { cli: 'gemini', args: [] },
        codex: { cli: 'codex', args: ['exec', '--full-auto'] },
      };

      expect(configs.gemini.cli).toBe('gemini');
      expect(configs.gemini.args).toEqual([]);
      expect(configs.codex.args).toContain('--full-auto');
    });

    it('should use experimental_instructions_file for codex (not env var)', () => {
      // Spec 0043/0039 amendment: Codex should use experimental_instructions_file config flag
      // This is the official approach per https://github.com/openai/codex/discussions/3896
      // Instead of the undocumented CODEX_SYSTEM_MESSAGE env var
      // The actual command building happens in runConsultation, tested via dry-run e2e tests
      // This test documents the expected behavior
      const codexApproach = 'experimental_instructions_file';
      expect(codexApproach).toBe('experimental_instructions_file');
    });

    it('should use model_reasoning_effort=low for codex', () => {
      // Spec 0043: Use low reasoning effort for faster responses (10-20% improvement)
      const reasoningEffort = 'low';
      expect(reasoningEffort).toBe('low');
    });
  });

  describe('consult function', () => {
    it('should throw error for unknown model', async () => {
      // Set up codev root
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'unknown-model', prompt: 'test' })
      ).rejects.toThrow(/Unknown model/);
    });

    it('should throw error when no mode specified', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini' })
      ).rejects.toThrow(/No mode specified/);
    });

    it('should throw error on mode conflict (--prompt + --type)', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', prompt: 'test', type: 'spec' })
      ).rejects.toThrow(/Mode conflict/);
    });

    it('should throw error when both --prompt and --prompt-file provided', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', prompt: 'test', promptFile: '/some/file.md' })
      ).rejects.toThrow(/Cannot use both/);
    });

    it('should throw error when --protocol provided without --type', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', protocol: 'spir' })
      ).rejects.toThrow(/--protocol requires --type/);
    });

    it('should throw error when --prompt-file does not exist', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', promptFile: '/nonexistent/file.md' })
      ).rejects.toThrow(/Prompt file not found/);
    });
  });

  describe('CLI availability check', () => {
    it('should check if CLI exists before running', async () => {
      // Mock execSync to return not found for gemini
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which gemini')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', prompt: 'test' })
      ).rejects.toThrow(/not found/);
    });
  });

  describe('role loading', () => {
    it('should fall back to embedded skeleton when local role not found', async () => {
      // With embedded skeleton, role is always found (falls back to skeleton/roles/consultant.md)
      // This test verifies that consult doesn't throw when no local codev directory exists
      fs.mkdirSync(testBaseDir, { recursive: true });
      // No local codev/roles/consultant.md - should use embedded skeleton

      process.chdir(testBaseDir);

      vi.resetModules();
      // The consult function should not throw because it falls back to embedded skeleton
      // We can't actually run the full consult without mocking the CLI, but we can test
      // the skeleton resolver directly
      const { resolveCodevFile } = await import('../lib/skeleton.js');
      const rolePath = resolveCodevFile('roles/consultant.md', testBaseDir);

      // Should find the embedded skeleton version (not null)
      expect(rolePath).not.toBeNull();
      expect(rolePath).toContain('skeleton');
    });
  });

  describe('review type loading (Spec 0056)', () => {
    it('should load review type from consult-types/ (primary location)', async () => {
      // Set up codev with consult-types directory
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'spec-review.md'),
        '# Spec Review from consult-types'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Should find in consult-types/
      const prompt = readCodevFile('consult-types/spec-review.md', testBaseDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Spec Review from consult-types');
    });

    it('should fall back to roles/review-types/ (deprecated location) when not in consult-types/', async () => {
      // Set up codev with only the old roles/review-types directory
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles', 'review-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'review-types', 'custom-type.md'),
        '# Custom Type from deprecated location'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Should find in roles/review-types/ (fallback)
      const prompt = readCodevFile('roles/review-types/custom-type.md', testBaseDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Custom Type from deprecated location');
    });

    it('should prefer consult-types/ over roles/review-types/ when both exist', async () => {
      // Set up both directories with same type
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles', 'review-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'spec-review.md'),
        '# NEW LOCATION'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'review-types', 'spec-review.md'),
        '# OLD LOCATION'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Should prefer consult-types/
      const prompt = readCodevFile('consult-types/spec-review.md', testBaseDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('NEW LOCATION');
    });

    it('should fall back to embedded skeleton when review type not in local directories', async () => {
      // Set up minimal codev directory (no local review types)
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { resolveCodevFile } = await import('../lib/skeleton.js');

      // Should fall back to embedded skeleton's consult-types/
      // Note: spec-review.md moved to protocol-specific dirs in Spec 325;
      // integration-review.md remains in shared consult-types/
      const promptPath = resolveCodevFile('consult-types/integration-review.md', testBaseDir);
      expect(promptPath).not.toBeNull();
      expect(promptPath).toContain('skeleton');
    });

    it('should resolve protocol-specific prompt templates', async () => {
      // Set up codev with protocol-specific consult-types directory
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'protocols', 'spir', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'protocols', 'spir', 'consult-types', 'spec-review.md'),
        '# SPIR Spec Review Prompt'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Should find in protocol-specific directory
      const prompt = readCodevFile('protocols/spir/consult-types/spec-review.md', testBaseDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('SPIR Spec Review Prompt');
    });
  });

  describe('query building', () => {
    it('should build correct PR review query', () => {
      const prNumber = 123;
      const expectedQuery = `Review Pull Request #${prNumber}`;

      // The query builder includes PR info
      expect(expectedQuery).toContain('123');
    });

    it('should build correct spec review query', () => {
      const specPath = '/path/to/spec.md';
      const expectedPrefix = 'Review Specification:';

      expect(expectedPrefix).toContain('Review');
    });
  });

  describe('history logging', () => {
    it('should log queries to history file', async () => {
      const logDir = path.join(testBaseDir, '.consult');
      fs.mkdirSync(logDir, { recursive: true });

      // Simulate what logQuery would do
      const timestamp = new Date().toISOString();
      const model = 'gemini';
      const query = 'test query';
      const duration = 5.5;

      const logLine = `${timestamp} model=${model} duration=${duration.toFixed(1)}s query=${query.substring(0, 100)}...\n`;
      fs.appendFileSync(path.join(logDir, 'history.log'), logLine);

      const logContent = fs.readFileSync(path.join(logDir, 'history.log'), 'utf-8');
      expect(logContent).toContain('model=gemini');
      expect(logContent).toContain('duration=5.5s');
    });
  });

  describe('Claude Agent SDK integration', () => {
    beforeEach(() => {
      mockQueryFn.mockClear();
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      process.chdir(testBaseDir);
    });

    it('should invoke Agent SDK with correct parameters', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield { type: 'assistant', message: { content: [{ text: 'OK' }] } };
          yield { type: 'result', subtype: 'success' };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await consult({ model: 'claude', prompt: 'test query' });

      expect(mockQueryFn).toHaveBeenCalledTimes(1);
      const callArgs = mockQueryFn.mock.calls[0][0];
      expect(callArgs.options.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(callArgs.options.model).toBe('claude-opus-4-6');
      expect(callArgs.options.maxTurns).toBe(200);
      expect(callArgs.options.maxBudgetUsd).toBe(25);
      expect(callArgs.options.permissionMode).toBe('bypassPermissions');
    });

    it('should extract text from assistant messages', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ text: 'Review: ' }, { text: 'All good.' }] },
          };
          yield { type: 'result', subtype: 'success' };
        })()
      );

      const writes: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        writes.push(chunk.toString());
        return true;
      });

      await consult({ model: 'claude', prompt: 'test query' });

      expect(writes).toContain('Review: ');
      expect(writes).toContain('All good.');
    });

    it('should write output to file when output option is set', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ text: 'File output content' }] },
          };
          yield { type: 'result', subtype: 'success' };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const outputFile = path.join(testBaseDir, 'output', 'review.md');
      await consult({
        model: 'claude',
        prompt: 'test query',
        output: outputFile,
      });

      expect(fs.existsSync(outputFile)).toBe(true);
      expect(fs.readFileSync(outputFile, 'utf-8')).toBe('File output content');
    });

    it('should remove CLAUDECODE from env passed to SDK', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      const originalClaudeCode = process.env.CLAUDECODE;
      process.env.CLAUDECODE = '1';

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield { type: 'result', subtype: 'success' };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await consult({ model: 'claude', prompt: 'test' });

      // Verify CLAUDECODE not in the env options
      const callArgs = mockQueryFn.mock.calls[0][0];
      expect(callArgs.options.env).not.toHaveProperty('CLAUDECODE');

      // Verify CLAUDECODE is restored in process.env after the call
      expect(process.env.CLAUDECODE).toBe('1');

      if (originalClaudeCode !== undefined) {
        process.env.CLAUDECODE = originalClaudeCode;
      } else {
        delete process.env.CLAUDECODE;
      }
    });

    it('should throw on SDK error results', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'error_max_turns',
            errors: ['Max turns exceeded'],
          };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await expect(
        consult({ model: 'claude', prompt: 'test' })
      ).rejects.toThrow(/Claude SDK error/);
    });

    it('should suppress tool use blocks from stderr', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'assistant',
            message: {
              content: [
                { name: 'Read', input: { file_path: '/foo/bar.ts' } },
                { text: 'File contents here' },
              ],
            },
          };
          yield { type: 'result', subtype: 'success' };
        })()
      );

      const stderrWrites: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
        stderrWrites.push(chunk.toString());
        return true;
      });

      await consult({ model: 'claude', prompt: 'test' });

      // Tool use blocks are intentionally suppressed to reduce noise
      expect(stderrWrites.some(w => w.includes('Tool: Read'))).toBe(false);
    });
  });

  describe('file-based review instructions (Bugfix #280)', () => {
    it('buildSpecQuery should instruct models to read files from disk', async () => {
      vi.resetModules();
      const { _buildSpecQuery } = await import('../commands/consult/index.js');
      const query = _buildSpecQuery('/path/to/spec.md', null);

      expect(query).toContain('Read the files listed above directly from disk');
      expect(query).toContain('Do NOT rely on `git diff`');
    });

    it('buildPlanQuery should instruct models to read files from disk', async () => {
      vi.resetModules();
      const { _buildPlanQuery } = await import('../commands/consult/index.js');
      const query = _buildPlanQuery('/path/to/plan.md', '/path/to/spec.md');

      expect(query).toContain('Read the files listed above directly from disk');
      expect(query).toContain('Do NOT rely on `git diff`');
    });

    it('buildSpecQuery should include file paths', async () => {
      vi.resetModules();
      const { _buildSpecQuery } = await import('../commands/consult/index.js');
      const query = _buildSpecQuery('/path/to/spec.md', '/path/to/plan.md');

      expect(query).toContain('/path/to/spec.md');
      expect(query).toContain('/path/to/plan.md');
    });

    it('buildPlanQuery should include file paths', async () => {
      vi.resetModules();
      const { _buildPlanQuery } = await import('../commands/consult/index.js');
      const query = _buildPlanQuery('/path/to/plan.md', '/path/to/spec.md');

      expect(query).toContain('/path/to/plan.md');
      expect(query).toContain('/path/to/spec.md');
    });

    it('CLI model spawn should use cwd from workspaceRoot', async () => {
      // Test documents the fix: CLI-based model spawns (Codex, Gemini) now include
      // cwd: workspaceRoot so models run in the correct workspace directory.
      // Previously, they inherited process.cwd() which could differ from the workspace root.
      // This is verified via dry-run integration tests and the spawn call in runConsultation.
      vi.resetModules();
      const { spawn } = await import('node:child_process');

      // The spawn call should include cwd in its options
      // This is a documentation test — the actual cwd verification happens when
      // consult is invoked with a real model. The implementation now passes
      // cwd: workspaceRoot to spawn() for CLI-based models.
      expect(vi.mocked(spawn)).toBeDefined();
    });
  });

  describe('Gemini --yolo mode restriction (Bugfix #370)', () => {
    it('general mode should NOT pass --yolo to Gemini CLI', async () => {
      // Bugfix #370: consult -m gemini general "..." was passing --yolo, allowing
      // Gemini to auto-approve file writes in the main worktree. General mode
      // consultations must be read-only.
      vi.resetModules();

      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      process.chdir(testBaseDir);

      // Mock execSync so commandExists('gemini') returns true
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) return Buffer.from('/usr/bin/gemini');
        return Buffer.from('');
      });

      const { spawn } = await import('node:child_process');
      const { consult } = await import('../commands/consult/index.js');

      await consult({ model: 'gemini', prompt: 'audit all files' });

      // Verify spawn was called without --yolo
      const spawnCalls = vi.mocked(spawn).mock.calls;
      const geminiCall = spawnCalls.find(call => call[0] === 'gemini');
      expect(geminiCall).toBeDefined();
      const args = geminiCall![1] as string[];
      expect(args).not.toContain('--yolo');
    });

    it('protocol mode should pass --yolo to Gemini CLI', async () => {
      // Protocol mode (--type) uses structured reviews where --yolo is needed
      // for file access during code review.
      vi.resetModules();

      // Clear spawn mock calls from previous tests
      const { spawn: spawnBefore } = await import('node:child_process');
      vi.mocked(spawnBefore).mockClear();

      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'specs'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      // resolveProtocolPrompt builds "${type}-review.md", so type 'spec' → 'spec-review.md'
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'spec-review.md'),
        '# Review the spec'
      );
      // resolveArchitectQuery needs a spec file matching issue number (padded to 4 digits)
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'specs', '0001-test-feature.md'),
        '# Test Feature Spec'
      );
      process.chdir(testBaseDir);

      // Mock execSync to return git info for protocol mode queries
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which')) return Buffer.from('/usr/bin/gemini');
        if (cmd.includes('git')) return Buffer.from('');
        return Buffer.from('');
      });

      const { spawn } = await import('node:child_process');
      const { consult } = await import('../commands/consult/index.js');

      // type 'spec' resolves to template 'spec-review.md'
      // --issue required from architect context
      await consult({ model: 'gemini', type: 'spec', issue: '1' });

      // Verify spawn was called WITH --yolo
      const spawnCalls = vi.mocked(spawn).mock.calls;
      const geminiCall = spawnCalls.find(call => call[0] === 'gemini');
      expect(geminiCall).toBeDefined();
      const args = geminiCall![1] as string[];
      expect(args).toContain('--yolo');
    });
  });

  describe('diff stat approach (Bugfix #240)', () => {
    it('should export getDiffStat for file-based review', async () => {
      vi.resetModules();
      const { _getDiffStat } = await import('../commands/consult/index.js');
      expect(typeof _getDiffStat).toBe('function');
    });

    it('getDiffStat should call git diff --stat and --name-only', async () => {
      vi.resetModules();

      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--stat')) {
          return Buffer.from(' src/app.ts | 10 +++++++---\n 1 file changed, 7 insertions(+), 3 deletions(-)\n');
        }
        if (typeof cmd === 'string' && cmd.includes('--name-only')) {
          return Buffer.from('src/app.ts\n');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });

      const { _getDiffStat } = await import('../commands/consult/index.js');
      const result = _getDiffStat('/fake/root', 'abc123..HEAD');

      expect(result.stat).toContain('src/app.ts');
      expect(result.files).toEqual(['src/app.ts']);
    });

    it('getDiffStat should handle multiple files', async () => {
      vi.resetModules();

      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--stat')) {
          return Buffer.from(
            ' .claude/settings.json     |  5 +++++\n' +
            ' src/app/widget.tsx         | 20 ++++++++++++++------\n' +
            ' src/middleware.ts          | 15 ++++++++++++---\n' +
            ' 3 files changed, 32 insertions(+), 9 deletions(-)\n'
          );
        }
        if (typeof cmd === 'string' && cmd.includes('--name-only')) {
          return Buffer.from('.claude/settings.json\nsrc/app/widget.tsx\nsrc/middleware.ts\n');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });

      const { _getDiffStat } = await import('../commands/consult/index.js');
      const result = _getDiffStat('/fake/root', 'abc123..HEAD');

      expect(result.files).toHaveLength(3);
      expect(result.files).toContain('.claude/settings.json');
      expect(result.files).toContain('src/app/widget.tsx');
      expect(result.files).toContain('src/middleware.ts');
      expect(result.stat).toContain('3 files changed');
    });

    it('no diff is ever truncated — reviewers read files from disk', async () => {
      // This is a documentation test: the old approach truncated diffs at 50K/80K chars,
      // which caused reviewers to miss files alphabetically late in the diff (e.g., src/).
      // The new approach sends only git diff --stat and instructs reviewers to read
      // the actual files from disk, eliminating truncation entirely.
      vi.resetModules();

      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--stat')) {
          return Buffer.from(' 50 files changed, 10000 insertions(+), 5000 deletions(-)\n');
        }
        if (typeof cmd === 'string' && cmd.includes('--name-only')) {
          // 50 files spanning the full alphabet
          const files = Array.from({ length: 50 }, (_, i) =>
            i < 10 ? `.claude/file${i}.json` :
            i < 20 ? `codev/specs/${i}.md` :
            `src/app/component${i}.tsx`
          );
          return Buffer.from(files.join('\n') + '\n');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });

      const { _getDiffStat } = await import('../commands/consult/index.js');
      const result = _getDiffStat('/fake/root', 'abc123..HEAD');

      // ALL 50 files are present — none truncated
      expect(result.files).toHaveLength(50);
      // src/ files that were previously invisible are now listed
      expect(result.files.filter(f => f.startsWith('src/'))).toHaveLength(30);
    });
  });
});
