/**
 * Unit tests for consult lane configuration (spec 1286, Phase 1).
 *
 * Covers spec test scenarios 6, 7, 9, 10, 11, 16, 17, 18 plus pricing/effort validation and
 * load-time enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MODEL_ID_RE,
  REASONING_EFFORTS,
  validateModelId,
  validateConsultModels,
  validateReasoningEffort,
  validatePricing,
  validateLaneList,
  validateConsultationConfig,
  resolveLaneModel,
  resolveReasoningEffort,
  resolveLaneComposition,
} from '../lib/consult-lanes.js';
import {
  listProtocolNames,
  canonicalProtocolName,
  listReviewTypes,
  setFrameworkCacheDir,
  getSkeletonDir,
} from '../lib/skeleton.js';
import { loadConfig, findConfigSource } from '../lib/config.js';

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-lanes-test-'));
  origHome = process.env.HOME;
  process.env.HOME = path.join(tmpDir, 'fake-home');
  fs.mkdirSync(path.join(tmpDir, 'fake-home', '.codev'), { recursive: true });
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a protocol.json into a given tier of a fake workspace. */
function writeProtocol(
  root: string,
  tier: '.codev' | 'codev',
  name: string,
  body: Record<string, unknown>,
) {
  const dir = path.join(root, tier, 'protocols', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify(body, null, 2));
}

function writeProjectConfig(root: string, config: Record<string, unknown>) {
  const dir = path.join(root, '.codev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Scenario 10 — model id syntax
// ---------------------------------------------------------------------------

describe('model id syntax (scenario 10)', () => {
  const accepted = [
    'claude-opus-4-6',
    'claude-opus-5',
    'gpt-5.4',
    'gpt-5.6-sol',                  // #1288: the -sol suffix is load-bearing
    'us.anthropic.claude-opus-5',   // namespaced
    'openai/gpt-5.6',               // vendor-prefixed
    'gpt-5.6:latest',               // tagged
    'model_with_underscores',
    'a',
    'future-model-9-nobody-has-heard-of',  // the no-allowlist guarantee
  ];

  for (const id of accepted) {
    it(`accepts ${id}`, () => {
      expect(MODEL_ID_RE.test(id)).toBe(true);
      expect(() => validateModelId(id, 'consult.models.codex')).not.toThrow();
    });
  }

  const rejected: [string, unknown][] = [
    ['empty string', ''],
    ['whitespace inside', 'gpt 5.6'],
    ['leading whitespace', ' gpt-5.6'],
    ['shell metacharacters', '; rm -rf /'],
    ['leading dash (agy would parse as a flag)', '--print'],
    ['too long', 'a'.repeat(201)],
    ['non-string number', 5],
    ['non-string null', null],
  ];

  for (const [label, id] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => validateModelId(id, 'consult.models.codex')).toThrow();
    });
  }

  it('does not reject an id merely for being unknown to Codev', () => {
    // The whole point: Codev never asserts a model does not exist.
    expect(() => validateModelId('totally-made-up-model-2099', 'consult.models.claude')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenarios 9, 17, 18 — lane key spaces
// ---------------------------------------------------------------------------

describe('consult.models key space (scenarios 9, 17)', () => {
  it('accepts claude, codex, gemini', () => {
    expect(() => validateConsultModels({ claude: 'claude-opus-5', codex: 'gpt-5.6-sol', gemini: 'g-3' })).not.toThrow();
  });

  it('rejects an unknown lane', () => {
    expect(() => validateConsultModels({ gpt: 'gpt-5.6' })).toThrow(/Unknown lane "gpt"/);
  });

  it('rejects hermes with an explanation (no model selector)', () => {
    expect(() => validateConsultModels({ hermes: 'anything' })).toThrow(/hermes.*no model selector/s);
  });

  it('rejects a non-object', () => {
    expect(() => validateConsultModels(['claude'])).toThrow(/expected an object/);
  });

  it('accepts undefined (zero-config)', () => {
    expect(() => validateConsultModels(undefined)).not.toThrow();
  });
});

describe('consult.reasoningEffort key/value space (scenarios 3, 18)', () => {
  it('accepts every SDK enum value for codex', () => {
    for (const effort of REASONING_EFFORTS) {
      expect(() => validateReasoningEffort({ codex: effort })).not.toThrow();
    }
  });

  it('rejects claude — key space is narrower than consult.models', () => {
    expect(() => validateReasoningEffort({ claude: 'high' })).toThrow(/Unknown lane "claude"/);
  });

  it('rejects gemini', () => {
    expect(() => validateReasoningEffort({ gemini: 'high' })).toThrow(/Unknown lane "gemini"/);
  });

  it('rejects an out-of-enum value', () => {
    expect(() => validateReasoningEffort({ codex: 'highest' })).toThrow(/Invalid consult.reasoningEffort.codex/);
  });

  it('rejects an empty string and a non-string', () => {
    expect(() => validateReasoningEffort({ codex: '' })).toThrow();
    expect(() => validateReasoningEffort({ codex: 3 })).toThrow();
  });
});

describe('consult.pricing completeness (scenario 14)', () => {
  it('accepts a complete rate set', () => {
    expect(() => validatePricing({ codex: { inputPer1M: 2, cachedInputPer1M: 1, outputPer1M: 8 } })).not.toThrow();
  });

  it('rejects a partial rate set', () => {
    expect(() => validatePricing({ codex: { inputPer1M: 2 } })).toThrow(/Incomplete consult.pricing.codex/);
  });

  it('rejects a non-codex lane', () => {
    expect(() => validatePricing({ claude: { inputPer1M: 1, cachedInputPer1M: 1, outputPer1M: 1 } }))
      .toThrow(/Unknown lane "claude"/);
  });

  it('rejects negative or non-numeric rates', () => {
    expect(() => validatePricing({ codex: { inputPer1M: -1, cachedInputPer1M: 1, outputPer1M: 8 } })).toThrow();
    expect(() => validatePricing({ codex: { inputPer1M: 'x', cachedInputPer1M: 1, outputPer1M: 8 } })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 11 — lane lists
// ---------------------------------------------------------------------------

describe('lane list validation (scenario 11)', () => {
  it('accepts known lanes including hermes', () => {
    expect(() => validateLaneList(['gemini', 'codex', 'claude', 'hermes'], 'k')).not.toThrow();
  });

  it('accepts special modes', () => {
    expect(() => validateLaneList('none', 'k')).not.toThrow();
    expect(() => validateLaneList('parent', 'k')).not.toThrow();
  });

  it('accepts a single lane name as a bare string', () => {
    expect(() => validateLaneList('codex', 'k')).not.toThrow();
  });

  it('rejects an unknown lane name', () => {
    expect(() => validateLaneList(['codexx'], 'k')).toThrow(/Invalid consultation model/);
  });

  // `[]` would otherwise validate and resolve to zero lanes in normal mode — an undocumented
  // synonym for "none". One spelling per intent; the error has to name the sanctioned one.
  it('rejects an empty lane list and points at "none"', () => {
    expect(() => validateLaneList([], 'k')).toThrow(/empty list is not a valid lane selection/);
    expect(() => validateLaneList([], 'k')).toThrow(/"none"/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 16 — key-space discovery
// ---------------------------------------------------------------------------

describe('key-space discovery (scenario 16)', () => {
  it('lists protocol names from any tier, plus aliases', () => {
    writeProtocol(tmpDir, 'codev', 'spir', { name: 'spir', alias: 'spider', phases: [] });
    writeProtocol(tmpDir, '.codev', 'custom', { name: 'custom', phases: [] });

    const names = listProtocolNames(tmpDir);
    expect(names.has('spir')).toBe(true);
    expect(names.has('spider')).toBe(true);   // alias must be configurable
    expect(names.has('custom')).toBe(true);
  });

  it('canonicalizes an alias to its directory name', () => {
    writeProtocol(tmpDir, 'codev', 'spir', { name: 'spir', alias: 'spider', phases: [] });
    expect(canonicalProtocolName(tmpDir, 'spider')).toBe('spir');
    expect(canonicalProtocolName(tmpDir, 'spir')).toBe('spir');
  });

  it('takes review types from the RESOLVED protocol only, not a shadowed copy', () => {
    // Same protocol name at two tiers. `.codev/` wins, so only its verify types are legal.
    writeProtocol(tmpDir, 'codev', 'dup', {
      name: 'dup',
      phases: [{ id: 'a', name: 'A', verify: { type: 'shadowed-type', models: ['codex'] } }],
    });
    writeProtocol(tmpDir, '.codev', 'dup', {
      name: 'dup',
      phases: [{ id: 'a', name: 'A', verify: { type: 'live-type', models: ['codex'] } }],
    });

    const types = listReviewTypes(tmpDir);
    expect(types.has('live-type')).toBe(true);
    expect(types.has('shadowed-type')).toBe(false); // that file will never execute
  });

  it('lists protocol names from the framework cache tier', () => {
    const cacheDir = path.join(tmpDir, 'fake-cache');
    const dir = path.join(cacheDir, 'protocols', 'cached-proto');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'protocol.json'), JSON.stringify({ name: 'cached-proto', alias: 'cp', phases: [] }));

    setFrameworkCacheDir(cacheDir);
    try {
      const names = listProtocolNames(tmpDir);
      expect(names.has('cached-proto')).toBe(true);
      expect(names.has('cp')).toBe(true);
      expect(canonicalProtocolName(tmpDir, 'cp')).toBe('cached-proto');
    } finally {
      setFrameworkCacheDir(null);
    }
  });

  it('lists protocol names from the installed skeleton tier', () => {
    // No protocols written into tmpDir at all — anything found comes from the package skeleton.
    // Skipped when the skeleton has not been copied (it is produced by `pnpm build`).
    const skeletonProtocols = path.join(getSkeletonDir(), 'protocols');
    if (!fs.existsSync(skeletonProtocols)) return;

    const names = listProtocolNames(tmpDir);
    expect(names.has('spir')).toBe(true);
    expect(names.has('spider')).toBe(true); // spir's shipped alias
    expect(canonicalProtocolName(tmpDir, 'spider')).toBe('spir');
    // And the skeleton's review types are discoverable for modelsByType validation.
    const types = listReviewTypes(tmpDir);
    for (const t of ['spec', 'plan', 'impl', 'pr']) expect(types.has(t)).toBe(true);
  });

  it('a local protocol shadows the skeleton copy of the same name for review types', () => {
    const skeletonProtocols = path.join(getSkeletonDir(), 'protocols');
    if (!fs.existsSync(path.join(skeletonProtocols, 'spir'))) return;

    // Shadow the shipped `spir` with one declaring a different verify type.
    writeProtocol(tmpDir, '.codev', 'spir', {
      name: 'spir',
      phases: [{ id: 'p', name: 'P', verify: { type: 'local-only-type', models: ['codex'] } }],
    });
    const types = listReviewTypes(tmpDir);
    expect(types.has('local-only-type')).toBe(true);
  });

  it('rejects an unknown byProtocol key', () => {
    writeProtocol(tmpDir, 'codev', 'spir', { name: 'spir', phases: [] });
    expect(() => validateConsultationConfig({ byProtocol: { nosuch: { models: ['codex'] } } }, tmpDir))
      .toThrow(/Unknown protocol "nosuch"/);
  });

  it('rejects an unknown modelsByType key (never warns)', () => {
    writeProtocol(tmpDir, 'codev', 'spir', {
      name: 'spir', phases: [{ id: 'p', name: 'P', verify: { type: 'spec', models: ['codex'] } }],
    });
    expect(() => validateConsultationConfig({ modelsByType: { implement: ['codex'] } }, tmpDir))
      .toThrow(/Unknown review type "implement"/);
  });

  it('accepts an alias as a byProtocol key', () => {
    writeProtocol(tmpDir, 'codev', 'spir', { name: 'spir', alias: 'spider', phases: [] });
    expect(() => validateConsultationConfig({ byProtocol: { spider: { models: ['codex'] } } }, tmpDir))
      .not.toThrow();
  });

  describe('malformed shapes raise keyed config errors, never a bare TypeError', () => {
    beforeEach(() => {
      writeProtocol(tmpDir, 'codev', 'spir', {
        name: 'spir', phases: [{ id: 'p', name: 'P', verify: { type: 'spec', models: ['codex'] } }],
      });
    });

    // typeof null === 'object', so every object guard needs an explicit null check. A null that
    // slips through reaches Object.entries() and raises an unkeyed TypeError, which tells the user
    // nothing about which config key is wrong.
    const nullShapes: [string, unknown][] = [
      ['byProtocol.<name>.modelsByType', { byProtocol: { spir: { modelsByType: null } } }],
      ['byProtocol.<name>', { byProtocol: { spir: null } }],
      ['byProtocol', { byProtocol: null }],
      ['modelsByType', { modelsByType: null }],
      ['the consultation block itself', null],
    ];

    for (const [label, config] of nullShapes) {
      it(`rejects null at ${label}`, () => {
        let thrown: unknown;
        try {
          validateConsultationConfig(config, tmpDir);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, `null at ${label} should be rejected`).toBeInstanceOf(Error);
        expect((thrown as Error).constructor.name).toBe('Error'); // not TypeError
        expect((thrown as Error).message).toMatch(/porch\.consultation|expected an object/);
      });
    }

    it('rejects an array where an object is expected', () => {
      expect(() => validateConsultationConfig({ modelsByType: [] }, tmpDir)).toThrow(/expected an object/);
      expect(() => validateConsultationConfig({ byProtocol: [] }, tmpDir)).toThrow(/expected an object/);
      expect(() => validateConsultationConfig({ byProtocol: { spir: { modelsByType: [] } } }, tmpDir))
        .toThrow(/expected an object/);
    });

    it('rejects a malformed nested lane list', () => {
      expect(() => validateConsultationConfig(
        { byProtocol: { spir: { modelsByType: { spec: ['nope'] } } } }, tmpDir,
      )).toThrow(/Invalid consultation model/);
    });

    // Same failure family as the null guard above: the rejection has to fire in every nested copy,
    // not just the top-level one. `[]` is the ambiguous synonym for "none" that must not validate.
    const emptyListPositions: [string, unknown][] = [
      ['models', { models: [] }],
      ['modelsByType.<type>', { modelsByType: { spec: [] } }],
      ['byProtocol.<name>.models', { byProtocol: { spir: { models: [] } } }],
      ['byProtocol.<name>.modelsByType.<type>', { byProtocol: { spir: { modelsByType: { spec: [] } } } }],
    ];

    for (const [label, config] of emptyListPositions) {
      it(`rejects an empty lane list at ${label}`, () => {
        expect(() => validateConsultationConfig(config as never, tmpDir))
          .toThrow(/empty list is not a valid lane selection/);
      });
    }
  });

  it('rejects a config naming the same protocol by both alias and canonical name', () => {
    writeProtocol(tmpDir, 'codev', 'spir', { name: 'spir', alias: 'spider', phases: [] });
    expect(() => validateConsultationConfig(
      { byProtocol: { spir: { models: ['codex'] }, spider: { models: ['claude'] } } },
      tmpDir,
    )).toThrow(/same protocol/);
  });
});

// ---------------------------------------------------------------------------
// Scenarios 6, 7 — precedence ladder
// ---------------------------------------------------------------------------

describe('lane composition precedence (scenarios 6, 7)', () => {
  const PROTOCOL_MODELS = ['gemini', 'codex', 'claude'];

  beforeEach(() => {
    writeProtocol(tmpDir, 'codev', 'spir', { name: 'spir', alias: 'spider', phases: [] });
    writeProtocol(tmpDir, 'codev', 'pir', { name: 'pir', phases: [] });
  });

  it('falls back to protocol models when nothing is configured', () => {
    expect(resolveLaneComposition(undefined, 'spir', 'spec', PROTOCOL_MODELS, tmpDir))
      .toEqual({ models: PROTOCOL_MODELS, mode: 'normal' });
  });

  it('level 4: porch.consultation.models overrides the protocol', () => {
    expect(resolveLaneComposition({ models: ['codex'] }, 'spir', 'spec', PROTOCOL_MODELS, tmpDir))
      .toEqual({ models: ['codex'], mode: 'normal' });
  });

  it('level 3: modelsByType outranks models', () => {
    const cfg = { models: ['codex'], modelsByType: { spec: ['claude'] } };
    expect(resolveLaneComposition(cfg, 'spir', 'spec', PROTOCOL_MODELS, tmpDir).models).toEqual(['claude']);
    // A different review type still falls through to `models`.
    expect(resolveLaneComposition(cfg, 'spir', 'impl', PROTOCOL_MODELS, tmpDir).models).toEqual(['codex']);
  });

  it('level 2: byProtocol.models outranks modelsByType', () => {
    const cfg = {
      models: ['codex'],
      modelsByType: { spec: ['claude'] },
      byProtocol: { spir: { models: ['gemini'] } },
    };
    expect(resolveLaneComposition(cfg, 'spir', 'spec', PROTOCOL_MODELS, tmpDir).models).toEqual(['gemini']);
    // Unscoped protocol is unaffected.
    expect(resolveLaneComposition(cfg, 'pir', 'spec', PROTOCOL_MODELS, tmpDir).models).toEqual(['claude']);
  });

  it('level 1: byProtocol.modelsByType outranks everything', () => {
    const cfg = {
      models: ['codex'],
      modelsByType: { spec: ['claude'] },
      byProtocol: { spir: { models: ['gemini'], modelsByType: { spec: ['hermes'] } } },
    };
    expect(resolveLaneComposition(cfg, 'spir', 'spec', PROTOCOL_MODELS, tmpDir).models).toEqual(['hermes']);
  });

  it('scenario 5: byProtocol preserves a lighter protocol under a widened global default', () => {
    const cfg = { models: ['gemini', 'codex', 'claude'], byProtocol: { pir: { models: ['gemini', 'codex'] } } };
    expect(resolveLaneComposition(cfg, 'spir', 'pr', PROTOCOL_MODELS, tmpDir).models).toHaveLength(3);
    expect(resolveLaneComposition(cfg, 'pir', 'pr', PROTOCOL_MODELS, tmpDir).models).toHaveLength(2);
  });

  it('matches a byProtocol alias key against the canonical protocol name', () => {
    const cfg = { models: ['codex'], byProtocol: { spider: { models: ['claude'] } } };
    // Project runs as "spir"; config says "spider". Must still apply.
    expect(resolveLaneComposition(cfg, 'spir', 'spec', PROTOCOL_MODELS, tmpDir).models).toEqual(['claude']);
  });

  it('matches a canonical byProtocol key against a project running under the alias', () => {
    const cfg = { models: ['codex'], byProtocol: { spir: { models: ['claude'] } } };
    expect(resolveLaneComposition(cfg, 'spider', 'spec', PROTOCOL_MODELS, tmpDir).models).toEqual(['claude']);
  });

  it('honours "none" and "parent" at every level (scenario 7)', () => {
    expect(resolveLaneComposition({ models: 'none' }, 'spir', 'spec', PROTOCOL_MODELS, tmpDir))
      .toEqual({ models: [], mode: 'none' });
    expect(resolveLaneComposition({ modelsByType: { spec: 'parent' } }, 'spir', 'spec', PROTOCOL_MODELS, tmpDir))
      .toEqual({ models: [], mode: 'parent' });
    expect(resolveLaneComposition({ byProtocol: { pir: { models: 'none' } } }, 'pir', 'pr', PROTOCOL_MODELS, tmpDir))
      .toEqual({ models: [], mode: 'none' });
    expect(resolveLaneComposition(
      { byProtocol: { spir: { modelsByType: { spec: 'parent' } } } }, 'spir', 'spec', PROTOCOL_MODELS, tmpDir,
    )).toEqual({ models: [], mode: 'parent' });
  });

  it('normalizes a single lane name string to an array', () => {
    expect(resolveLaneComposition({ models: 'codex' }, 'spir', 'spec', PROTOCOL_MODELS, tmpDir).models)
      .toEqual(['codex']);
  });
});

// ---------------------------------------------------------------------------
// Lane model resolution
// ---------------------------------------------------------------------------

describe('resolveLaneModel', () => {
  it('returns nothing when unconfigured, so callers keep their own default', () => {
    expect(resolveLaneModel(undefined, 'claude')).toEqual({});
    expect(resolveLaneModel({ models: {} }, 'claude')).toEqual({});
  });

  it('returns the configured id and the key that supplied it', () => {
    expect(resolveLaneModel({ models: { claude: 'claude-opus-5' } }, 'claude'))
      .toEqual({ id: 'claude-opus-5', key: 'consult.models.claude' });
  });

  it('resolves reasoning effort, or undefined when unset', () => {
    expect(resolveReasoningEffort({ reasoningEffort: { codex: 'high' } })).toBe('high');
    expect(resolveReasoningEffort(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Load-time enforcement + provenance
// ---------------------------------------------------------------------------

describe('validation happens at config-load time', () => {
  it('loadConfig throws on a malformed model id (not deferred to consult)', () => {
    writeProjectConfig(tmpDir, { consult: { models: { codex: 'bad id with spaces' } } });
    expect(() => loadConfig(tmpDir)).toThrow(/Invalid model id/);
  });

  it('loadConfig throws on an unknown consult.models lane', () => {
    writeProjectConfig(tmpDir, { consult: { models: { hermes: 'x' } } });
    expect(() => loadConfig(tmpDir)).toThrow(/Unknown lane "hermes"/);
  });

  it('loadConfig throws on an out-of-enum reasoning effort', () => {
    writeProjectConfig(tmpDir, { consult: { reasoningEffort: { codex: 'turbo' } } });
    expect(() => loadConfig(tmpDir)).toThrow(/Invalid consult.reasoningEffort.codex/);
  });

  it('loadConfig accepts a valid consult block', () => {
    writeProjectConfig(tmpDir, {
      consult: { models: { claude: 'claude-opus-5', codex: 'gpt-5.6-sol' }, reasoningEffort: { codex: 'high' } },
    });
    const config = loadConfig(tmpDir);
    expect(config.consult?.models?.codex).toBe('gpt-5.6-sol');
    expect(config.consult?.reasoningEffort?.codex).toBe('high');
  });

  it('zero-config workspaces are unaffected', () => {
    const config = loadConfig(tmpDir);
    expect(config.consult?.models).toBeUndefined();
    expect(config.porch?.consultation?.models).toEqual(['gemini', 'codex', 'claude']);
  });
});

describe('findConfigSource', () => {
  it('names the project config file that supplied a key', () => {
    writeProjectConfig(tmpDir, { consult: { models: { codex: 'gpt-5.6-sol' } } });
    const source = findConfigSource(tmpDir, ['consult', 'models', 'codex']);
    expect(source).toBe(path.join(tmpDir, '.codev', 'config.json'));
  });

  it('prefers the higher-precedence layer when several define the key', () => {
    writeProjectConfig(tmpDir, { consult: { models: { codex: 'from-project' } } });
    const localPath = path.join(tmpDir, '.codev', 'config.local.json');
    fs.writeFileSync(localPath, JSON.stringify({ consult: { models: { codex: 'from-local' } } }));
    expect(findConfigSource(tmpDir, ['consult', 'models', 'codex'])).toBe(localPath);
  });

  it('returns null for a key no file defines', () => {
    expect(findConfigSource(tmpDir, ['consult', 'models', 'codex'])).toBeNull();
  });
});
