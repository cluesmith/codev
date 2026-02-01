/**
 * Tests for porch Claude Worker (Agent SDK adapter)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock the Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { buildWithTimeout } from '../claude.js';

describe('buildWithTimeout', () => {
  let testDir: string;
  let outputPath: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `porch-claude-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    outputPath = path.join(testDir, 'output.txt');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should return success result when SDK completes successfully', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Created the file.' }],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done.',
          total_cost_usd: 0.05,
          duration_ms: 3000,
        };
      })()
    );

    const result = await buildWithTimeout('Write hello world', outputPath, testDir);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Created the file.');
    expect(result.output).toContain('Done.');
    expect(result.cost).toBe(0.05);
    expect(result.duration).toBe(3000);

    // Output file should have content
    const fileContent = fs.readFileSync(outputPath, 'utf-8');
    expect(fileContent).toContain('Created the file.');

    // Prompt file should be saved
    const promptFile = outputPath.replace(/\.txt$/, '-prompt.txt');
    expect(fs.readFileSync(promptFile, 'utf-8')).toBe('Write hello world');
  });

  it('should return failure on SDK error result', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'error',
          duration_ms: 500,
        };
      })()
    );

    const result = await buildWithTimeout('Bad prompt', outputPath, testDir);

    expect(result.success).toBe(false);
    expect(result.output).toContain('[Agent SDK error: error]');
    expect(result.duration).toBe(500);
  });

  it('should handle SDK exception gracefully', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        throw new Error('Network timeout');
      })()
    );

    const result = await buildWithTimeout('Prompt', outputPath, testDir);

    expect(result.success).toBe(false);
    expect(result.output).toContain('[Agent SDK exception: Network timeout]');
  });

  it('should pass correct options to query()', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        yield { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 0 };
      })()
    );

    await buildWithTimeout('test prompt', outputPath, '/custom/cwd');

    expect(query).toHaveBeenCalledWith({
      prompt: 'test prompt',
      options: {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        cwd: '/custom/cwd',
        maxTurns: 200,
      },
    });
  });

  it('should stream multiple assistant messages to output file', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    (query as ReturnType<typeof vi.fn>).mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Step 1' }] },
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Step 2' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
          total_cost_usd: 0.01,
          duration_ms: 1000,
        };
      })()
    );

    const result = await buildWithTimeout('Multi-step', outputPath, testDir);

    expect(result.success).toBe(true);
    const fileContent = fs.readFileSync(outputPath, 'utf-8');
    expect(fileContent).toContain('Step 1');
    expect(fileContent).toContain('Step 2');
  });
});
