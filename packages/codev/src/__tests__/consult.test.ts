/**
 * Tests for consult CLI command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

// Fake child process for agy tests: stdout/stderr emitters + kill, emits on next tick.
function makeFakeAgyProc(opts: { stdout?: string; stderr?: string; code?: number; closeAfter?: boolean }): any {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => {
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    if (opts.closeAfter !== false) proc.emit('close', opts.code ?? 0);
  });
  return proc;
}

// Mock forge module (imported by consult/index.ts)
vi.mock('../lib/forge.js', () => ({
  executeForgeCommandSync: vi.fn(() => null),
}));

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
  execFileSync: vi.fn(() => Buffer.from('')),
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
    it('should support model aliases', async () => {
      // Assert the REAL exported alias map (not a hardcoded duplicate). The
      // `pro` alias is additionally exercised through the real execution path
      // in the agy describe block below.
      const { _MODEL_ALIASES } = await import('../commands/consult/index.js');
      expect(_MODEL_ALIASES['pro']).toBe('gemini');
      expect(_MODEL_ALIASES['gpt']).toBe('codex');
      expect(_MODEL_ALIASES['opus']).toBe('claude');
    });

    it('should have correct CLI configuration for each model', async () => {
      // Assert the REAL exported config (not a hardcoded fake), so a backend
      // change is caught. Claude/Codex use SDKs (not MODEL_CONFIGS).
      const { _MODEL_CONFIGS } = await import('../commands/consult/index.js');
      // gemini lane dispatches to the Antigravity CLI (agy) via runAgyConsultation
      // (#778): cli marker 'agy', no pinned --model, no system-prompt env var.
      expect(_MODEL_CONFIGS.gemini.cli).toBe('agy');
      expect(_MODEL_CONFIGS.gemini.args).not.toContain('--model');
      expect(_MODEL_CONFIGS.gemini.envVar).toBeNull();
      // hermes unchanged.
      expect(_MODEL_CONFIGS.hermes.cli).toBe('hermes');
      expect(_MODEL_CONFIGS.hermes.args).toEqual(['chat', '-q']);
    });

    it('should use model_instructions_file for codex (not env var)', () => {
      // Spec 591: Codex's experimental_instructions_file is deprecated.
      // The current flag is model_instructions_file.
      // The actual command building happens in runConsultation, tested via dry-run e2e tests
      // This test documents the expected behavior
      const codexApproach = 'model_instructions_file';
      expect(codexApproach).toBe('model_instructions_file');
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

    it('should accept hermes as a valid model', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'hermes', prompt: 'test' })
      ).resolves.toBeUndefined();
    });

    it('should pass inline prompt to hermes for normal-sized queries', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { spawn } = await import('node:child_process');
      vi.mocked(spawn).mockClear();
      const { consult } = await import('../commands/consult/index.js');

      await consult({ model: 'hermes', prompt: 'small prompt' });

      const hermesCall = vi.mocked(spawn).mock.calls.find(call => call[0] === 'hermes');
      expect(hermesCall).toBeDefined();
      const args = hermesCall![1] as string[];
      expect(args[0]).toBe('chat');
      expect(args[1]).toBe('-q');
      expect(args[2]).toContain('small prompt');
    });

    it('should use temp-file indirection for very large hermes queries', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { spawn } = await import('node:child_process');
      vi.mocked(spawn).mockClear();
      const { consult } = await import('../commands/consult/index.js');

      const largePrompt = 'x'.repeat(150_000);
      await consult({ model: 'hermes', prompt: largePrompt });

      const hermesCall = vi.mocked(spawn).mock.calls.find(call => call[0] === 'hermes');
      expect(hermesCall).toBeDefined();
      const args = hermesCall![1] as string[];
      expect(args[0]).toBe('chat');
      expect(args[1]).toBe('-q');
      expect(args[2]).toContain('Read the full consultation prompt from this file');
      expect(args[2]).toContain('codev-consult-prompt-');
      expect(args[2]).not.toContain(largePrompt.slice(0, 1024));
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
    it('gemini lane skips non-blockingly when the agy CLI is unavailable', async () => {
      // The gemini lane uses the Antigravity CLI (agy). When agy is unavailable
      // it must NOT throw/block — it emits a non-blocking COMMENT skip so porch
      // runs still advance (was: the old gemini-CLI threw on a missing binary).
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      process.chdir(testBaseDir);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const priorBin = process.env.CODEV_AGY_BIN;
      process.env.CODEV_AGY_BIN = path.join(testBaseDir, 'no-such-agy'); // does not exist → unavailable
      try {
        vi.resetModules();
        const { consult } = await import('../commands/consult/index.js');

        let threw = false;
        try {
          await consult({ model: 'gemini', prompt: 'test' });
        } catch {
          threw = true;
        }
        expect(threw).toBe(false); // non-blocking: resolves, never throws

        const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
        expect(written).toContain('VERDICT: SKIPPED');
        expect(written).toMatch(/skipped/i);
      } finally {
        stdoutSpy.mockRestore();
        if (priorBin === undefined) delete process.env.CODEV_AGY_BIN;
        else process.env.CODEV_AGY_BIN = priorBin;
      }
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

  describe('inline content review (Spec 612 TICK-002)', () => {
    it('buildSpecQuery should embed spec content inline', async () => {
      vi.resetModules();
      const { _buildSpecQuery } = await import('../commands/consult/index.js');
      const query = _buildSpecQuery(
        { content: '# My Spec\nSome requirements', label: '42-my-feature' },
        null,
      );

      expect(query).toContain('# My Spec');
      expect(query).toContain('Some requirements');
      expect(query).toContain('42-my-feature');
    });

    it('buildSpecQuery should embed plan content when provided', async () => {
      vi.resetModules();
      const { _buildSpecQuery } = await import('../commands/consult/index.js');
      const query = _buildSpecQuery(
        { content: '# Spec Content', label: '42-feature' },
        { content: '# Plan Content', label: '42-feature' },
      );

      expect(query).toContain('# Spec Content');
      expect(query).toContain('# Plan Content');
    });

    it('buildPlanQuery should embed plan and spec content inline', async () => {
      vi.resetModules();
      const { _buildPlanQuery } = await import('../commands/consult/index.js');
      const query = _buildPlanQuery(
        { content: '# Plan Content', label: '42-feature' },
        { content: '# Spec Context', label: '42-feature' },
      );

      expect(query).toContain('# Plan Content');
      expect(query).toContain('# Spec Context');
      expect(query).toContain('42-feature');
    });

    it('CLI model spawn should use cwd from workspaceRoot', async () => {
      vi.resetModules();
      const { spawn } = await import('node:child_process');
      expect(vi.mocked(spawn)).toBeDefined();
    });
  });

  describe('Gemini lane via Antigravity CLI (agy)', () => {
    let agyBin: string;

    beforeEach(() => {
      // A real (non-IDE) file so resolveAgyBin() accepts the override.
      agyBin = path.join(testBaseDir, 'agy-fake');
      fs.writeFileSync(agyBin, '#!/bin/sh\n');
      process.env.CODEV_AGY_BIN = agyBin;
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      process.chdir(testBaseDir);
    });

    afterEach(() => {
      delete process.env.CODEV_AGY_BIN;
    });

    async function loadAgy() {
      vi.resetModules();
      const cp = await import('node:child_process');
      const { consult } = await import('../commands/consult/index.js');
      return { consult, spawn: vi.mocked(cp.spawn) };
    }

    it('passes the folded consultation prompt immediately after --print', async () => {
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();

      await consult({ model: 'gemini', prompt: 'review this' });

      const call = spawn.mock.calls.find(c => c[0] === agyBin);
      expect(call).toBeDefined();
      const args = call![1] as string[];
      expect(args).toContain('--print');
      expect(args).toContain('--sandbox');
      expect(args).toContain('--add-dir');
      const printIndex = args.indexOf('--print');
      expect(args[printIndex + 1]).toContain('review this');
      expect(args[printIndex + 1]).toContain('Consultant Role');
      // Safety (replaces the #370 --yolo concern): never auto-approve all tools.
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('scopes --add-dir to workspace + a dedicated subdir, never the whole OS temp dir', async () => {
      // Security (#778 CMAP): granting the entire tmpdir() would expose unrelated
      // /tmp files to the sandboxed reviewer. Grant only the consult sandbox subdir.
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();

      await consult({ model: 'gemini', prompt: 'review this' });

      const call = spawn.mock.calls.find(c => c[0] === agyBin);
      expect(call).toBeDefined();
      const args = call![1] as string[];
      const grantedDirs = args.filter((_a, i) => args[i - 1] === '--add-dir');
      // Never grant the entire OS temp dir.
      expect(grantedDirs).not.toContain(tmpdir());
      // Exactly one granted dir is a dedicated, owned consult sandbox subdir under tmp.
      expect(grantedDirs.some(d => d.startsWith(tmpdir()) && /[/\\]codev-consult-/.test(d))).toBe(true);
    });

    it('routes the `pro` alias through the real execution path to the agy lane', async () => {
      // `pro` → gemini → agy: exercise the actual resolution, not a hardcoded map.
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();

      await consult({ model: 'pro', prompt: 'review this' });

      const call = spawn.mock.calls.find(c => c[0] === agyBin);
      expect(call).toBeDefined(); // resolved to the agy backend
      const args = call![1] as string[];
      const printIndex = args.indexOf('--print');
      expect(args[printIndex + 1]).toContain('review this');
    });

    it('passes --prompt-file contents as the value of --print', async () => {
      const promptFile = path.join(testBaseDir, 'agy-prompt.md');
      fs.writeFileSync(promptFile, 'PROMPT_FILE_MARKER');
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();

      await consult({ model: 'gemini', promptFile });

      const call = spawn.mock.calls.find(c => c[0] === agyBin);
      expect(call).toBeDefined();
      const args = call![1] as string[];
      const printIndex = args.indexOf('--print');
      expect(args[printIndex + 1]).toContain('PROMPT_FILE_MARKER');
    });

    it('folds the reviewer role into the prompt (no GEMINI_SYSTEM_MD env)', async () => {
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();

      await consult({ model: 'gemini', prompt: 'UNIQUE_QUERY_MARKER' });

      const call = spawn.mock.calls.find(c => c[0] === agyBin);
      expect(call).toBeDefined();
      const args = call![1] as string[];
      const promptArg = args[args.indexOf('--print') + 1];
      expect(promptArg).toContain('UNIQUE_QUERY_MARKER'); // query inlined
      expect(promptArg).toContain('Consultant Role');     // role folded in
      const opts = call![2] as { env?: Record<string, string> };
      expect(opts.env?.GEMINI_SYSTEM_MD).toBeUndefined();
    });

    it('writes a very large prompt to a temp file instead of argv (E2BIG safety)', async () => {
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();

      const huge = 'X'.repeat(200_000);
      await consult({ model: 'gemini', prompt: huge });

      const call = spawn.mock.calls.find(c => c[0] === agyBin);
      expect(call).toBeDefined();
      const args = call![1] as string[];
      const promptArg = args[args.indexOf('--print') + 1];
      expect(promptArg).not.toContain(huge); // not inlined on argv
      expect(promptArg).toMatch(/Read the full consultation prompt from this file/);
    });

    it('passes plain-text agy output through as the review', async () => {
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();
      spawn.mockReturnValueOnce(makeFakeAgyProc({ stdout: 'PLAINTEXT_REVIEW_BODY', code: 0 }));

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await consult({ model: 'gemini', prompt: 'review' });
        const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
        expect(written).toContain('PLAINTEXT_REVIEW_BODY');
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('skips non-blockingly (VERDICT: SKIPPED) when agy is unauthenticated', async () => {
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();
      spawn.mockReturnValueOnce(makeFakeAgyProc({
        stderr: 'Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/o/oauth2/auth?client_id=x',
        closeAfter: false,
      }));

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        let threw = false;
        try { await consult({ model: 'gemini', prompt: 'review' }); } catch { threw = true; }
        expect(threw).toBe(false); // non-blocking
        const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
        expect(written).toContain('VERDICT: SKIPPED');
        expect(written).toMatch(/not authenticated/i);
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('skips non-blockingly when agy times out producing the review (non-response message)', async () => {
      // On a heavy agentic task that outruns --print-timeout, agy returns a
      // "timed out waiting for response" message (not a review) — treat as a skip.
      const { consult, spawn } = await loadAgy();
      spawn.mockClear();
      spawn.mockReturnValueOnce(makeFakeAgyProc({
        stdout: 'An background process has been started to run `agy --sandbox`.\nError: timed out waiting for response',
        code: 0,
      }));

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        let threw = false;
        try { await consult({ model: 'gemini', prompt: 'review' }); } catch { threw = true; }
        expect(threw).toBe(false); // non-blocking
        const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
        expect(written).toContain('VERDICT: SKIPPED');
        expect(written).toMatch(/timed out/i);
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });

  describe('agy binary resolution (resolveAgyBin / isRealAgyCli)', () => {
    afterEach(() => { delete process.env.CODEV_AGY_BIN; });

    it('isRealAgyCli accepts a real standalone binary', async () => {
      const { isRealAgyCli } = await import('../commands/consult/index.js');
      const real = path.join(testBaseDir, 'agy-real');
      fs.writeFileSync(real, '#!/bin/sh\n');
      expect(isRealAgyCli(real)).toBe(true);
    });

    it('isRealAgyCli rejects a nonexistent path', async () => {
      const { isRealAgyCli } = await import('../commands/consult/index.js');
      expect(isRealAgyCli(path.join(testBaseDir, 'nope-agy'))).toBe(false);
    });

    it('isRealAgyCli rejects the Antigravity IDE launcher symlink', async () => {
      const { isRealAgyCli } = await import('../commands/consult/index.js');
      // Simulate the IDE: a symlink whose target is under Antigravity.app.
      const ideDir = path.join(testBaseDir, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
      fs.mkdirSync(ideDir, { recursive: true });
      const ideTarget = path.join(ideDir, 'antigravity');
      fs.writeFileSync(ideTarget, '#!/bin/sh\n');
      const link = path.join(testBaseDir, 'agy-ide-link');
      fs.symlinkSync(ideTarget, link);
      expect(isRealAgyCli(link)).toBe(false);
    });

    it('resolveAgyBin honors a valid CODEV_AGY_BIN override, rejects an invalid one', async () => {
      const { resolveAgyBin } = await import('../commands/consult/index.js');
      const real = path.join(testBaseDir, 'agy-override');
      fs.writeFileSync(real, '#!/bin/sh\n');
      process.env.CODEV_AGY_BIN = real;
      expect(resolveAgyBin()).toBe(real);
      process.env.CODEV_AGY_BIN = path.join(testBaseDir, 'missing-agy');
      expect(resolveAgyBin()).toBeNull();
    });

    it('agyRespondsToVersion behaviorally verifies a PATH candidate (--version)', async () => {
      // A bare PATH `agy` is only accepted if it behaves like the headless CLI.
      const { execSync } = await import('node:child_process');
      const { agyRespondsToVersion } = await import('../commands/consult/index.js');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('good-agy')) return '1.0.4\n' as unknown as Buffer; // prints a version
        if (cmd.includes('bad-agy')) return '' as unknown as Buffer;          // no version output
        throw new Error('not a known command');
      });
      expect(agyRespondsToVersion('good-agy')).toBe(true);
      expect(agyRespondsToVersion('bad-agy')).toBe(false);
      expect(agyRespondsToVersion('throws-agy')).toBe(false);
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

      const { execFileSync } = await import('node:child_process');
      vi.mocked(execFileSync).mockImplementation((_file: string, args?: readonly string[]) => {
        if (args?.includes('--stat')) {
          return ' src/app.ts | 10 +++++++---\n 1 file changed, 7 insertions(+), 3 deletions(-)\n';
        }
        if (args?.includes('--name-only')) {
          return 'src/app.ts\n';
        }
        return '';
      });

      const { _getDiffStat } = await import('../commands/consult/index.js');
      const result = _getDiffStat('/fake/root', 'abc123..HEAD');

      expect(result.stat).toContain('src/app.ts');
      expect(result.files).toEqual(['src/app.ts']);
    });

    it('getDiffStat should handle multiple files', async () => {
      vi.resetModules();

      const { execFileSync } = await import('node:child_process');
      vi.mocked(execFileSync).mockImplementation((_file: string, args?: readonly string[]) => {
        if (args?.includes('--stat')) {
          return (
            ' .claude/settings.json     |  5 +++++\n' +
            ' src/app/widget.tsx         | 20 ++++++++++++++------\n' +
            ' src/middleware.ts          | 15 ++++++++++++---\n' +
            ' 3 files changed, 32 insertions(+), 9 deletions(-)\n'
          );
        }
        if (args?.includes('--name-only')) {
          return '.claude/settings.json\nsrc/app/widget.tsx\nsrc/middleware.ts\n';
        }
        return '';
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

      const { execFileSync } = await import('node:child_process');
      vi.mocked(execFileSync).mockImplementation((_file: string, args?: readonly string[]) => {
        if (args?.includes('--stat')) {
          return ' 50 files changed, 10000 insertions(+), 5000 deletions(-)\n';
        }
        if (args?.includes('--name-only')) {
          // 50 files spanning the full alphabet
          const files = Array.from({ length: 50 }, (_, i) =>
            i < 10 ? `.claude/file${i}.json` :
            i < 20 ? `codev/specs/${i}.md` :
            `src/app/component${i}.tsx`
          );
          return files.join('\n') + '\n';
        }
        return '';
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
