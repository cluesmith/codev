/**
 * Per-lane model configuration reaching the SDKs (spec 1286, Phase 2).
 *
 * Covers spec scenarios 1, 2, 3 and 12: a configured id reaches each SDK, `--model-id` outranks
 * config, and a provider rejection fails loudly naming the config key *and* the layer that supplied
 * it.
 *
 * Default-model assertions are deliberately two-layer (see the plan):
 *   - Layer A (most tests): assert the SDK receives the module's DEFAULT_* constant. Rebase-proof —
 *     stays correct when a shipped default changes (issue #1288) with no edit here.
 *   - Layer B (one test): pin the constants to the literal ids shipped at this commit. This is the
 *     single intended edit point when defaults change, and it fails loudly on accidental drift.
 * Layer A alone would be tautological; that is precisely why B exists separately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertLaneAcceptsModelOverride } from '../../../lib/consult-lanes.js';

// --- SDK mocks: capture exactly what each provider was asked to run -------------------

let mockStartThreadArgs: Record<string, unknown> | undefined;
let mockCodexEvents: unknown[] = [];

async function* asGenerator(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

vi.mock('@openai/codex-sdk', () => {
  class MockCodex {
    startThread(...args: unknown[]) {
      mockStartThreadArgs = args[0] as Record<string, unknown>;
      return { runStreamed: () => Promise.resolve({ events: asGenerator(mockCodexEvents) }) };
    }
  }
  return { Codex: MockCodex };
});

let mockClaudeOptions: Record<string, unknown> | undefined;
let mockClaudeMessages: unknown[] = [];
let mockClaudeThrow: Error | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    mockClaudeOptions = args.options;
    return (async function* () {
      if (mockClaudeThrow) throw mockClaudeThrow;
      for (const m of mockClaudeMessages) yield m;
    })();
  },
}));

const {
  runCodexConsultation,
  runClaudeConsultation,
  resolveLaneModelChoice,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  computeCodexCost,
} = await import('../index.js');

// --- fixture ------------------------------------------------------------------------

const CODEX_OK = [
  { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
];

const CLAUDE_OK = [
  { type: 'assistant', message: { content: [{ text: 'ok' }] } },
  { type: 'result', subtype: 'success' },
];

let tmpDir: string;
let origHome: string | undefined;

/** Write a `.codev/config.json` into the fake workspace. */
function writeConfig(config: unknown): void {
  mkdirSync(join(tmpDir, '.codev'), { recursive: true });
  writeFileSync(join(tmpDir, '.codev', 'config.json'), JSON.stringify(config));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lane-models-'));
  // A real ~/.codev/config.json setting consult.models would otherwise leak into every assertion.
  origHome = process.env.HOME;
  process.env.HOME = join(tmpDir, 'fake-home');
  mockStartThreadArgs = undefined;
  mockClaudeOptions = undefined;
  mockClaudeThrow = null;
  mockCodexEvents = CODEX_OK;
  mockClaudeMessages = CLAUDE_OK;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = origHome;
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// --- Scenario 1 & 2 — configured ids reach the SDKs ---------------------------------

describe('configured lane models reach the SDK (scenarios 1, 2)', () => {
  it('codex runs the configured model id', async () => {
    writeConfig({ consult: { models: { codex: 'gpt-5.6-sol' } } });
    await runCodexConsultation('q', 'role', tmpDir);
    expect(mockStartThreadArgs?.model).toBe('gpt-5.6-sol');
  });

  it('claude runs the configured model id', async () => {
    writeConfig({ consult: { models: { claude: 'claude-opus-5' } } });
    await runClaudeConsultation('q', 'role', tmpDir);
    expect(mockClaudeOptions?.model).toBe('claude-opus-5');
  });

  it('codex runs the configured reasoning effort', async () => {
    writeConfig({ consult: { models: { codex: 'gpt-5.6-sol' }, reasoningEffort: { codex: 'high' } } });
    await runCodexConsultation('q', 'role', tmpDir);
    expect(mockStartThreadArgs?.modelReasoningEffort).toBe('high');
  });

  it('configuring one lane leaves the other on its default', async () => {
    writeConfig({ consult: { models: { codex: 'gpt-5.6-sol' } } });
    await runClaudeConsultation('q', 'role', tmpDir);
    expect(mockClaudeOptions?.model).toBe(DEFAULT_CLAUDE_MODEL);
  });
});

// --- Layer A — zero-config behavior, asserted against the constants ------------------

describe('unset config preserves pre-change behavior (Layer A)', () => {
  it('codex falls back to the default constant at the default effort', async () => {
    await runCodexConsultation('q', 'role', tmpDir);
    expect(mockStartThreadArgs?.model).toBe(DEFAULT_CODEX_MODEL);
    expect(mockStartThreadArgs?.modelReasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
  });

  it('claude falls back to the default constant', async () => {
    await runClaudeConsultation('q', 'role', tmpDir);
    expect(mockClaudeOptions?.model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('a config with no consult block is the same as no config', async () => {
    writeConfig({ porch: { consultation: { models: ['codex'] } } });
    await runCodexConsultation('q', 'role', tmpDir);
    expect(mockStartThreadArgs?.model).toBe(DEFAULT_CODEX_MODEL);
  });
});

// --- Layer B — the one deliberate pin ----------------------------------------------

describe('shipped defaults (Layer B — update this test when defaults change)', () => {
  it('pins the model ids this commit ships', () => {
    // #1288 landed on main mid-branch and changed both defaults. This is the ONE line the
    // two-layer design exists to make it — every other assertion reads the constants and needed
    // no edit. `default-models.test.ts` (from #1288) is the primary guard; this is the local one.
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5');
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(DEFAULT_CODEX_REASONING_EFFORT).toBe('medium');
  });
});

// --- Scenario 12 — --model-id outranks config ---------------------------------------

describe('--model-id overrides config (scenario 12)', () => {
  it('outranks a configured id for codex', async () => {
    writeConfig({ consult: { models: { codex: 'gpt-from-config' } } });
    const choice = resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL, 'gpt-from-flag');
    await runCodexConsultation('q', 'role', tmpDir, undefined, undefined, choice);
    expect(mockStartThreadArgs?.model).toBe('gpt-from-flag');
  });

  it('outranks a configured id for claude', async () => {
    writeConfig({ consult: { models: { claude: 'claude-from-config' } } });
    const choice = resolveLaneModelChoice(tmpDir, 'claude', DEFAULT_CLAUDE_MODEL, 'claude-from-flag');
    await runClaudeConsultation('q', 'role', tmpDir, undefined, undefined, choice);
    expect(mockClaudeOptions?.model).toBe('claude-from-flag');
  });

  it('applies where no config exists at all', () => {
    expect(resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL, 'gpt-flag').id).toBe('gpt-flag');
  });

  it('is rejected by the same syntax rule as config', () => {
    expect(() => resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL, '-leading-dash'))
      .toThrow(/Invalid model id/);
    expect(() => resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL, 'has spaces'))
      .toThrow(/Invalid model id/);
  });

  // The shared validator appends "in Codev config", which is actively misleading for a flag —
  // it sends the user to a file to fix something they typed on the command line.
  it('is not blamed on Codev config, since a flag is not config', () => {
    let message = '';
    try {
      resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL, 'has spaces');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('--model-id');
    expect(message).not.toContain('in Codev config');
  });
});

// --- lanes that cannot honour the override -------------------------------------------
//
// Found by codex at the phase_2 review: --model-id was documented as applying to "whichever lane
// -m selected", but only the claude and codex branches read it, so `-m hermes --model-id foo`
// parsed, showed in --help, and did nothing. That is the same registered-documented-inert failure
// this phase existed to eliminate, reintroduced by the flag's own description.

describe('--model-id is refused by lanes with no model selector', () => {
  it('rejects hermes rather than ignoring the flag', () => {
    expect(() => assertLaneAcceptsModelOverride('hermes')).toThrow(/not supported for the "hermes" lane/);
    expect(() => assertLaneAcceptsModelOverride('hermes')).toThrow(/no model selector/);
  });

  it('names the lanes that do accept a model id', () => {
    let message = '';
    try {
      assertLaneAcceptsModelOverride('hermes');
    } catch (err) {
      message = (err as Error).message;
    }
    for (const lane of ['claude', 'codex', 'gemini']) expect(message).toContain(lane);
  });

  it('accepts every configurable lane, gemini included', () => {
    // gemini is configurable by spec; its passthrough lands in phase_3. Asserting it here means
    // phase_3 cannot narrow this contract without failing a test.
    for (const lane of ['claude', 'codex', 'gemini']) {
      expect(() => assertLaneAcceptsModelOverride(lane)).not.toThrow();
    }
  });

  it('names the flag it was given, so other overrides can reuse it', () => {
    expect(() => assertLaneAcceptsModelOverride('hermes', '--some-other-flag'))
      .toThrow(/--some-other-flag is not supported/);
  });
});

// --- codex cost accounting (scenario 14) ---------------------------------------------
//
// CODEX_PRICING describes the DEFAULT model. Applying it to a model the user configured would
// report a confidently wrong number that aggregates silently into `consult stats` totals — and a
// wrong cost is worse than a missing one, because it looks authoritative.

describe('codex cost accounting', () => {
  // Signature is main's (#1288): (model, input, cached, output, workspaceRoot?). The optional
  // workspaceRoot is spec 1286's addition — it enables the config-pricing override.
  const cost = (model: string, input: number, cached: number, out: number) =>
    computeCodexCost(model, input, cached, out, tmpDir);

  it('prices the default model from the shipped table', () => {
    // 1M uncached @ $5 + 1M output @ $30 = $35.
    expect(cost(DEFAULT_CODEX_MODEL, 1_000_000, 0, 1_000_000)).toBeCloseTo(35, 5);
  });

  it('returns null for a model with no known rates and no configured pricing', () => {
    // The heart of this phase: refuse to price a model whose rates we do not know, rather than
    // borrowing another model's and reporting a confidently wrong number.
    expect(cost('some-unpriced-model', 1_000_000, 0, 1_000_000)).toBeNull();
  });

  it('uses configured pricing for a model absent from the shipped table', () => {
    writeConfig({
      consult: {
        models: { codex: 'some-unpriced-model' },
        pricing: { codex: { inputPer1M: 1, cachedInputPer1M: 0.5, outputPer1M: 3 } },
      },
    });
    expect(cost('some-unpriced-model', 1_000_000, 0, 1_000_000)).toBeCloseTo(4, 5); // $1 + $3
  });

  it('configured pricing outranks the shipped table even for the default model', () => {
    writeConfig({ consult: { pricing: { codex: { inputPer1M: 1, cachedInputPer1M: 0.5, outputPer1M: 3 } } } });
    expect(cost(DEFAULT_CODEX_MODEL, 1_000_000, 0, 1_000_000)).toBeCloseTo(4, 5);
  });

  it('counts cached input at the cached rate', () => {
    expect(cost(DEFAULT_CODEX_MODEL, 1_000_000, 1_000_000, 0)).toBeCloseTo(0.5, 5);
  });
});

// --- provenance ---------------------------------------------------------------------

describe('model provenance', () => {
  it('records the config key and the layer that supplied the id', () => {
    writeConfig({ consult: { models: { codex: 'gpt-5.6-sol' } } });
    const choice = resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL);
    expect(choice.id).toBe('gpt-5.6-sol');
    expect(choice.key).toBe('consult.models.codex');
    expect(choice.source).toContain(join('.codev', 'config.json'));
    expect(choice.fromFlag).toBe(false);
  });

  it('reports no config key when the default is used', () => {
    const choice = resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL);
    expect(choice.id).toBe(DEFAULT_CODEX_MODEL);
    expect(choice.key).toBeNull();
    expect(choice.source).toBeNull();
  });

  it('names the flag, not a config key, when --model-id supplied the id', () => {
    writeConfig({ consult: { models: { codex: 'gpt-from-config' } } });
    const choice = resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL, 'gpt-from-flag');
    expect(choice.key).toBe('--model-id');
    expect(choice.fromFlag).toBe(true);
  });
});

// --- Scenario 3 — provider rejection fails loudly -----------------------------------

describe('provider rejection fails loudly with no fallback (scenario 3)', () => {
  it('codex: error keeps the provider text and names the key and layer', async () => {
    writeConfig({ consult: { models: { codex: 'gpt-nonexistent' } } });
    mockCodexEvents = [{ type: 'turn.failed', error: { message: 'unknown model: gpt-nonexistent' } }];

    const err = await runCodexConsultation('q', 'role', tmpDir).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('unknown model: gpt-nonexistent'); // provider text, verbatim
    expect(err.message).toContain('consult.models.codex');           // the key
    expect(err.message).toContain(join('.codev', 'config.json'));     // the layer
  });

  it('claude: error keeps the provider text and names the key and layer', async () => {
    writeConfig({ consult: { models: { claude: 'claude-nonexistent' } } });
    mockClaudeThrow = new Error('model not found: claude-nonexistent');

    const err = await runClaudeConsultation('q', 'role', tmpDir).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('model not found: claude-nonexistent');
    expect(err.message).toContain('consult.models.claude');
    expect(err.message).toContain(join('.codev', 'config.json'));
  });

  it('writes no output file when the provider rejects the id', async () => {
    writeConfig({ consult: { models: { codex: 'gpt-nonexistent' } } });
    mockCodexEvents = [{ type: 'turn.failed', error: { message: 'unknown model' } }];
    const outputPath = join(tmpDir, 'review.txt');

    await runCodexConsultation('q', 'role', tmpDir, outputPath).catch(() => {});

    expect(existsSync(outputPath)).toBe(false);
  });

  it('names --model-id rather than a config key when the flag supplied the id', async () => {
    const choice = resolveLaneModelChoice(tmpDir, 'codex', DEFAULT_CODEX_MODEL, 'gpt-bogus');
    mockCodexEvents = [{ type: 'turn.failed', error: { message: 'unknown model: gpt-bogus' } }];

    const err = await runCodexConsultation('q', 'role', tmpDir, undefined, undefined, choice)
      .catch((e: unknown) => e as Error);

    expect(err.message).toContain('--model-id');
    expect(err.message).not.toContain('consult.models.codex');
  });

  it('leaves a default-model failure unannotated — the user configured nothing to fix', async () => {
    mockCodexEvents = [{ type: 'turn.failed', error: { message: 'transient upstream outage' } }];

    const err = await runCodexConsultation('q', 'role', tmpDir).catch((e: unknown) => e as Error);

    expect(err.message).toBe('transient upstream outage');
    expect(err.message).not.toContain('consult.models');
  });
});
