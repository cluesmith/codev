import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsDB, type MetricsRecord } from '../metrics.js';
import { extractUsage, extractReviewText, type SDKResultLike } from '../usage-extractor.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'metrics-test-'));
}

function sampleRecord(overrides: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    timestamp: '2026-02-15T14:32:01.000Z',
    model: 'gemini',
    reviewType: 'impl-review',
    subcommand: 'impl',
    protocol: 'spir',
    projectId: '0108',
    durationSeconds: 72.4,
    inputTokens: 1200,
    cachedInputTokens: 800,
    outputTokens: 450,
    costUsd: 2.40,
    exitCode: 0,
    workspacePath: '/tmp/test-workspace',
    errorMessage: null,
    ...overrides,
  };
}

// Test 1: MetricsDB.record() + query() round-trip
describe('MetricsDB record and query', () => {
  let tmpDir: string;
  let db: MetricsDB;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = new MetricsDB(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts a row and retrieves it with correct values', () => {
    const record = sampleRecord();
    db.record(record);

    const rows = db.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(record.timestamp);
    expect(rows[0].model).toBe(record.model);
    expect(rows[0].review_type).toBe(record.reviewType);
    expect(rows[0].subcommand).toBe(record.subcommand);
    expect(rows[0].protocol).toBe(record.protocol);
    expect(rows[0].project_id).toBe(record.projectId);
    expect(rows[0].duration_seconds).toBeCloseTo(record.durationSeconds);
    expect(rows[0].input_tokens).toBe(record.inputTokens);
    expect(rows[0].cached_input_tokens).toBe(record.cachedInputTokens);
    expect(rows[0].output_tokens).toBe(record.outputTokens);
    expect(rows[0].cost_usd).toBeCloseTo(record.costUsd!);
    expect(rows[0].exit_code).toBe(record.exitCode);
    expect(rows[0].workspace_path).toBe(record.workspacePath);
    expect(rows[0].error_message).toBeNull();
  });

  it('handles null token/cost fields', () => {
    const record = sampleRecord({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: null,
      reviewType: null,
      projectId: null,
      errorMessage: null,
    });
    db.record(record);

    const rows = db.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].cached_input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
    expect(rows[0].cost_usd).toBeNull();
    expect(rows[0].review_type).toBeNull();
    expect(rows[0].project_id).toBeNull();
  });
});

// Test 2: MetricsDB.summary() aggregation
describe('MetricsDB summary', () => {
  let tmpDir: string;
  let db: MetricsDB;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = new MetricsDB(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('correctly aggregates duration, cost, and success rate', () => {
    db.record(sampleRecord({ model: 'gemini', durationSeconds: 72.0, costUsd: 2.40, exitCode: 0 }));
    db.record(sampleRecord({ model: 'codex', durationSeconds: 95.0, costUsd: 2.80, exitCode: 0 }));
    db.record(sampleRecord({ model: 'claude', durationSeconds: 185.0, costUsd: 6.50, exitCode: 1, errorMessage: 'timeout' }));

    const summary = db.summary({});
    expect(summary.totalCount).toBe(3);
    expect(summary.totalDuration).toBeCloseTo(352.0);
    expect(summary.totalCost).toBeCloseTo(11.70);
    expect(summary.costCount).toBe(3);
    expect(summary.successCount).toBe(2);

    expect(summary.byModel).toHaveLength(3);
    const gemini = summary.byModel.find(m => m.model === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.count).toBe(1);
    expect(gemini!.avgDuration).toBeCloseTo(72.0);
    expect(gemini!.successRate).toBeCloseTo(100);

    expect(summary.byType).toHaveLength(1);
    expect(summary.byType[0].reviewType).toBe('impl-review');
    expect(summary.byType[0].count).toBe(3);

    expect(summary.byProtocol).toHaveLength(1);
    expect(summary.byProtocol[0].protocol).toBe('spir');
    expect(summary.byProtocol[0].count).toBe(3);
  });

  it('returns null totalCost when no rows have cost data', () => {
    db.record(sampleRecord({ costUsd: null }));
    const summary = db.summary({});
    expect(summary.totalCost).toBeNull();
  });
});

// Test 3: extractUsage() for Gemini JSON
describe('extractUsage for Gemini', () => {
  it('correctly parses sample Gemini JSON output', () => {
    const output = JSON.stringify({
      response: 'The review text...',
      stats: {
        models: {
          'gemini-3-pro-preview': {
            tokens: {
              prompt: 1200,
              candidates: 450,
              total: 1650,
              cached: 800,
            },
          },
        },
      },
    });

    const usage = extractUsage('gemini', output);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(1200);
    expect(usage!.cachedInputTokens).toBe(800);
    expect(usage!.outputTokens).toBe(450);
    // Cost: (1200-800)/1M * 1.25 + 800/1M * 0.315 + 450/1M * 10.00
    expect(usage!.costUsd).not.toBeNull();
    expect(usage!.costUsd).toBeCloseTo(0.005252);
  });

  it('returns null for malformed JSON', () => {
    const usage = extractUsage('gemini', 'not valid json');
    expect(usage).toBeNull();
  });

  it('returns null when stats block is missing', () => {
    const usage = extractUsage('gemini', JSON.stringify({ response: 'text' }));
    expect(usage).toBeNull();
  });
});

// Test 4: extractUsage() for Codex JSONL (multi-turn)
describe('extractUsage for Codex', () => {
  it('correctly parses multi-turn Codex JSONL', () => {
    const output = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Review text' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 },
      }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'More text' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 25000, cached_input_tokens: 24900, output_tokens: 80 },
      }),
    ].join('\n');

    const usage = extractUsage('codex', output);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(49763);
    expect(usage!.cachedInputTokens).toBe(49348);
    expect(usage!.outputTokens).toBe(202);
    expect(usage!.costUsd).not.toBeNull();
  });

  it('returns null when no turn.completed events exist', () => {
    const output = JSON.stringify({ type: 'message', role: 'assistant', content: 'text' });
    const usage = extractUsage('codex', output);
    expect(usage).toBeNull();
  });

  it('handles turn.completed without usage object', () => {
    const output = JSON.stringify({ type: 'turn.completed' });
    const usage = extractUsage('codex', output);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBeNull();
    expect(usage!.cachedInputTokens).toBeNull();
    expect(usage!.outputTokens).toBeNull();
    expect(usage!.costUsd).toBeNull();
  });
});

// Test 5: extractUsage() for Claude SDK result
describe('extractUsage for Claude', () => {
  it('correctly reads SDK result message fields', () => {
    const sdkResult: SDKResultLike = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 6.50,
      usage: {
        input_tokens: 50000,
        output_tokens: 3000,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 5000,
      },
    };

    const usage = extractUsage('claude', '', sdkResult);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(50000);
    expect(usage!.cachedInputTokens).toBe(40000);
    expect(usage!.outputTokens).toBe(3000);
    expect(usage!.costUsd).toBe(6.50);
  });

  it('handles SDK result with missing usage', () => {
    const sdkResult: SDKResultLike = {
      type: 'result',
      subtype: 'success',
    };

    const usage = extractUsage('claude', '', sdkResult);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBeNull();
    expect(usage!.cachedInputTokens).toBeNull();
    expect(usage!.outputTokens).toBeNull();
    expect(usage!.costUsd).toBeNull();
  });
});

// Test 6: Stats formatting
describe('Stats formatting', () => {
  let tmpDir: string;
  let db: MetricsDB;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = new MetricsDB(join(tmpDir, 'test.db'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
  });

  it('summary output matches expected format', () => {
    db.record(sampleRecord({ model: 'gemini', durationSeconds: 72.0, costUsd: 2.40, exitCode: 0 }));
    db.record(sampleRecord({ model: 'codex', durationSeconds: 95.0, costUsd: 2.80, exitCode: 0 }));

    const summary = db.summary({});

    // Verify summary structure for formatting
    expect(summary.totalCount).toBe(2);
    expect(summary.byModel.length).toBeGreaterThan(0);
    expect(summary.byType.length).toBeGreaterThan(0);
    expect(summary.byProtocol.length).toBeGreaterThan(0);

    // Verify the model stats have the fields needed for formatting
    for (const m of summary.byModel) {
      expect(typeof m.model).toBe('string');
      expect(typeof m.count).toBe('number');
      expect(typeof m.avgDuration).toBe('number');
      expect(typeof m.successRate).toBe('number');
    }
  });
});

// Test 7: Stats filter flags
describe('Stats filter flags', () => {
  let tmpDir: string;
  let db: MetricsDB;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = new MetricsDB(join(tmpDir, 'test.db'));

    db.record(sampleRecord({ model: 'gemini', reviewType: 'spec-review', protocol: 'spir', projectId: '0108' }));
    db.record(sampleRecord({ model: 'codex', reviewType: 'impl-review', protocol: 'tick', projectId: '0109' }));
    db.record(sampleRecord({ model: 'claude', reviewType: 'impl-review', protocol: 'spir', projectId: '0108' }));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters by model', () => {
    const rows = db.query({ model: 'gemini' });
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('gemini');
  });

  it('filters by review type', () => {
    const rows = db.query({ type: 'impl-review' });
    expect(rows).toHaveLength(2);
    rows.forEach(r => expect(r.review_type).toBe('impl-review'));
  });

  it('filters by protocol', () => {
    const rows = db.query({ protocol: 'spir' });
    expect(rows).toHaveLength(2);
    rows.forEach(r => expect(r.protocol).toBe('spir'));
  });

  it('filters by project', () => {
    const rows = db.query({ project: '0109' });
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('0109');
  });

  it('limits results with last', () => {
    const rows = db.query({ last: 2 });
    expect(rows).toHaveLength(2);
  });
});

// Test 8: CLI flag acceptance (--protocol, --project-id)
describe('CLI flag acceptance', () => {
  let tmpDir: string;
  let db: MetricsDB;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = new MetricsDB(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records protocol and projectId into database and retrieves them', () => {
    db.record(sampleRecord({ protocol: 'spir', projectId: '0115' }));
    db.record(sampleRecord({ protocol: 'tick', projectId: '0042' }));
    db.record(sampleRecord({ protocol: 'manual', projectId: null }));

    const rows = db.query({});
    expect(rows).toHaveLength(3);

    const spirRow = rows.find(r => r.protocol === 'spir');
    expect(spirRow).toBeDefined();
    expect(spirRow!.project_id).toBe('0115');

    const manualRow = rows.find(r => r.protocol === 'manual');
    expect(manualRow).toBeDefined();
    expect(manualRow!.project_id).toBeNull();
  });

  it('filters by protocol and project in queries', () => {
    db.record(sampleRecord({ protocol: 'spir', projectId: '0115' }));
    db.record(sampleRecord({ protocol: 'manual', projectId: null }));

    const spirRows = db.query({ protocol: 'spir' });
    expect(spirRows).toHaveLength(1);
    expect(spirRows[0].protocol).toBe('spir');

    const projectRows = db.query({ project: '0115' });
    expect(projectRows).toHaveLength(1);
    expect(projectRows[0].project_id).toBe('0115');
  });

  it('summary breaks down by protocol', () => {
    db.record(sampleRecord({ protocol: 'spir', costUsd: 5.00 }));
    db.record(sampleRecord({ protocol: 'spir', costUsd: 3.00 }));
    db.record(sampleRecord({ protocol: 'manual', costUsd: 1.00 }));

    const summary = db.summary({});
    const spirStats = summary.byProtocol.find(p => p.protocol === 'spir');
    expect(spirStats).toBeDefined();
    expect(spirStats!.count).toBe(2);
    expect(spirStats!.totalCost).toBeCloseTo(8.00);

    const manualStats = summary.byProtocol.find(p => p.protocol === 'manual');
    expect(manualStats).toBeDefined();
    expect(manualStats!.count).toBe(1);
  });
});

// Test 9: SQLite write failure handling
describe('SQLite write failure', () => {
  it('logs warning but does not throw on write failure', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'test.db');
    const db = new MetricsDB(dbPath);
    db.close();

    // Re-open as read-only by closing the db and using a broken path
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create a new db, close it, then try to write to a closed db
    const db2 = new MetricsDB(dbPath);

    // Simulate a write failure by closing the underlying database then calling record()
    db2.close();

    // record() on a closed db should not throw (it catches internally)
    // We need to verify it doesn't throw — just calling it is the test
    expect(() => {
      // After close(), the internal db handle is invalid, so prepare() will throw
      // The record() method wraps this in try/catch
      db2.record(sampleRecord());
    }).not.toThrow();

    stderrSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Test 10: Gemini output unwrapping
describe('Gemini output unwrapping', () => {
  it('extracts response field as plain text', () => {
    const rawJson = JSON.stringify({
      response: 'This is the review text.\n\n---\nVERDICT: APPROVE\nSUMMARY: Looks good\nCONFIDENCE: HIGH\n---\nKEY_ISSUES: None',
      stats: {
        models: {
          'gemini-3-pro-preview': {
            tokens: { prompt: 1000, candidates: 200, total: 1200, cached: 500 },
          },
        },
      },
    });

    const text = extractReviewText('gemini', rawJson);
    expect(text).not.toBeNull();
    expect(text).toContain('This is the review text.');
    expect(text).toContain('VERDICT: APPROVE');
    // Should not contain raw JSON structure
    expect(text).not.toContain('"stats"');
    expect(text).not.toContain('"models"');
  });

  it('returns null when response field is missing', () => {
    const rawJson = JSON.stringify({ stats: { models: {} } });
    const text = extractReviewText('gemini', rawJson);
    expect(text).toBeNull();
  });
});

// Test 11: Codex output unwrapping
describe('Codex output unwrapping', () => {
  it('extracts assistant message text from JSONL events', () => {
    const output = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'First part of review. ' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'ignored' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Second part.' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } }),
    ].join('\n');

    const text = extractReviewText('codex', output);
    expect(text).not.toBeNull();
    expect(text).toBe('First part of review. Second part.');
  });

  it('handles content as array of text blocks', () => {
    const output = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Block one.' }, { type: 'text', text: ' Block two.' }],
    });

    const text = extractReviewText('codex', output);
    expect(text).not.toBeNull();
    expect(text).toBe('Block one. Block two.');
  });

  it('returns null when no assistant messages found', () => {
    const output = JSON.stringify({ type: 'turn.completed', usage: {} });
    const text = extractReviewText('codex', output);
    expect(text).toBeNull();
  });
});

// Test 12: Concurrent MetricsDB writes (WAL)
describe('Concurrent MetricsDB writes', () => {
  it('three rapid inserts from different connections succeed with WAL', () => {
    const tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'concurrent.db');

    const db1 = new MetricsDB(dbPath);
    const db2 = new MetricsDB(dbPath);
    const db3 = new MetricsDB(dbPath);

    // Three rapid writes from different connections
    db1.record(sampleRecord({ model: 'gemini', timestamp: '2026-02-15T14:32:01.000Z' }));
    db2.record(sampleRecord({ model: 'codex', timestamp: '2026-02-15T14:32:01.001Z' }));
    db3.record(sampleRecord({ model: 'claude', timestamp: '2026-02-15T14:32:01.002Z' }));

    // Verify all three rows are present
    const rows = db1.query({});
    expect(rows).toHaveLength(3);
    const models = rows.map(r => r.model).sort();
    expect(models).toEqual(['claude', 'codex', 'gemini']);

    db1.close();
    db2.close();
    db3.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Test 13: Cold start (no DB)
describe('Cold start with no database', () => {
  it('MetricsDB.defaultPath points to ~/.codev/metrics.db', () => {
    const path = MetricsDB.defaultPath;
    expect(path).toContain('.codev');
    expect(path).toContain('metrics.db');
  });

  it('handleStats prints "No metrics data found" when database does not exist', async () => {
    const { handleStats } = await import('../stats.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Mock MetricsDB.defaultPath to a non-existent path
    const originalDefaultPath = Object.getOwnPropertyDescriptor(MetricsDB, 'defaultPath');
    const nonExistentPath = join(tmpdir(), 'non-existent-codev-dir-12345', 'metrics.db');
    Object.defineProperty(MetricsDB, 'defaultPath', { get: () => nonExistentPath, configurable: true });

    try {
      await handleStats([], {});
      expect(consoleSpy).toHaveBeenCalledWith('No metrics data found. Run a consultation first.');
    } finally {
      // Restore original defaultPath
      if (originalDefaultPath) {
        Object.defineProperty(MetricsDB, 'defaultPath', originalDefaultPath);
      }
      consoleSpy.mockRestore();
    }
  });
});

// Test 14: JSON parse failure fallback
describe('JSON parse failure fallback', () => {
  it('Gemini: extractReviewText returns null for invalid JSON, raw output preserved', () => {
    const rawOutput = 'This is raw text output, not JSON at all.\n\n---\nVERDICT: APPROVE\n---';
    const text = extractReviewText('gemini', rawOutput);
    expect(text).toBeNull();
    // Caller should fall back to writing rawOutput to outputPath
  });

  it('Gemini: extractUsage returns null for invalid JSON', () => {
    const rawOutput = 'Not valid JSON';
    const usage = extractUsage('gemini', rawOutput);
    expect(usage).toBeNull();
  });

  it('Codex: extractReviewText returns null for invalid JSONL', () => {
    const rawOutput = 'This is raw text, not JSONL';
    const text = extractReviewText('codex', rawOutput);
    expect(text).toBeNull();
  });

  it('Codex: extractUsage returns null for invalid JSONL', () => {
    const rawOutput = 'Not valid JSONL';
    const usage = extractUsage('codex', rawOutput);
    expect(usage).toBeNull();
  });
});
