/**
 * Consult lane configuration — per-lane model ids and per-review-type lane selection.
 *
 * Two distinct concerns live here (spec 1286):
 *
 *  1. WHICH MODEL a lane runs — `consult.models.<lane>` / `consult.reasoningEffort.codex`.
 *  2. WHICH LANES run for a given protocol + review type — `porch.consultation.*`.
 *
 * Validation philosophy, which differs deliberately between the two value kinds:
 *
 *  - Model **ids** are NEVER validated against a local catalog. A list of known ids goes stale the
 *    day a provider ships a model, which is the exact problem this feature exists to fix. Ids are
 *    checked for *syntax* only; the provider is the sole authority on whether an id exists, and a
 *    rejection fails loudly with no fallback to a hardcoded default.
 *  - Reasoning **effort** IS validated locally, because it is a closed union shipped as a type by a
 *    dependency we pin (`ModelReasoningEffort`). That is a compile-time fact, not a remote one.
 *    The `satisfies` clause below is what keeps the two in sync: if the SDK changes the union, this
 *    file stops compiling rather than silently diverging.
 */

import type { ModelReasoningEffort } from '@openai/codex-sdk';
import { canonicalProtocolName, listProtocolNames, listReviewTypes } from './skeleton.js';

// ---------------------------------------------------------------------------
// Lane / value spaces
// ---------------------------------------------------------------------------

/** Lanes whose model id can be configured. `hermes` is absent: `hermes chat -q` has no model selector. */
export const MODEL_CONFIGURABLE_LANES = ['claude', 'codex', 'gemini'] as const;
export type ConfigurableLane = (typeof MODEL_CONFIGURABLE_LANES)[number];

/** Lanes exposing a reasoning-effort knob. Deliberately narrower than MODEL_CONFIGURABLE_LANES. */
export const REASONING_EFFORT_LANES = ['codex'] as const;

/**
 * Accepted reasoning-effort values.
 *
 * `satisfies` is load-bearing: it binds this list to the SDK's exported union so that an SDK upgrade
 * which adds/removes/renames a member is a COMPILE ERROR here. A plain `string[]` would type-check
 * and pass tests while silently drifting — the same class of bug as a stale model-id allowlist.
 */
export const REASONING_EFFORTS = [
  'minimal', 'low', 'medium', 'high', 'xhigh',
] as const satisfies readonly ModelReasoningEffort[];

/** Lane names accepted in `porch.consultation.*` lists (includes hermes — it IS a review backend). */
export const VALID_LANE_NAMES = ['gemini', 'codex', 'claude', 'hermes'];

/** Whole-value special modes, accepted wherever a lane list is accepted. */
export const SPECIAL_MODES = ['none', 'parent'] as const;

/**
 * Model-id syntax. Deliberately permissive: ASCII alphanumerics plus `. _ : / @ + -`, 1–200 chars,
 * not starting with `-`.
 *
 * Covers the id conventions in use across providers — dotted/namespaced
 * (`us.anthropic.claude-opus-5`), vendor-prefixed (`openai/gpt-5.6`), tagged (`gpt-5.6:latest`),
 * and suffixed (`gpt-5.6-sol`). The leading-`-` exclusion is the one hard safety requirement: the
 * gemini lane passes the id as an argv element, and a leading `-` would be parsed by `agy` as a flag.
 *
 * If a provider ever adopts a character outside this set, widen the class. That is a change to
 * SYNTAX (slow, safe) rather than to a catalog of IDS (stale immediately).
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodexPricing {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}

export interface ConsultLaneConfig {
  models?: Partial<Record<ConfigurableLane, string>>;
  reasoningEffort?: { codex?: ModelReasoningEffort };
  pricing?: { codex?: CodexPricing };
}

export type LaneList = string | string[];

export interface ConsultationConfig {
  models?: LaneList;
  modelsByType?: Record<string, LaneList>;
  byProtocol?: Record<string, { models?: LaneList; modelsByType?: Record<string, LaneList> }>;
}

export type ConsultMode = 'normal' | 'none' | 'parent';

export interface ResolvedLaneModel {
  /** Configured id, or undefined meaning "use the backend's own default". */
  id?: string;
  /** Dotted config key that supplied the id, for diagnostics. */
  key?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message);
}

function quoted(values: readonly string[]): string {
  return values.map(v => `"${v}"`).join(', ');
}

/** Validate a model id's syntax. Never validates existence — that is the provider's job. */
export function validateModelId(id: unknown, key: string): asserts id is string {
  if (typeof id !== 'string') {
    fail(`Invalid ${key} in Codev config: expected a string, got ${id === null ? 'null' : typeof id}.`);
  }
  if (!MODEL_ID_RE.test(id)) {
    fail(
      `Invalid model id ${JSON.stringify(id)} for ${key} in Codev config.\n` +
      `Model ids must be 1-200 characters of letters, digits, and ". _ : / @ + -", ` +
      `and must not start with "-".\n` +
      `Note: Codev does not check whether a model exists — the provider does. This is a syntax error.`
    );
  }
}

export function validateConsultModels(models: unknown): void {
  if (models === undefined) return;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    fail(`Invalid consult.models in Codev config: expected an object mapping lane -> model id.`);
  }
  for (const [lane, id] of Object.entries(models as Record<string, unknown>)) {
    if (!(MODEL_CONFIGURABLE_LANES as readonly string[]).includes(lane)) {
      const extra = lane === 'hermes'
        ? `\nThe "hermes" backend is invoked as \`hermes chat -q\` and exposes no model selector, ` +
          `so configuring a model for it would silently do nothing. ` +
          `("hermes" is still valid in porch.consultation lane lists.)`
        : '';
      fail(
        `Unknown lane "${lane}" in consult.models. ` +
        `Lanes that accept a model id: ${quoted(MODEL_CONFIGURABLE_LANES)}.${extra}`
      );
    }
    validateModelId(id, `consult.models.${lane}`);
  }
}

export function validateReasoningEffort(effort: unknown): void {
  if (effort === undefined) return;
  if (typeof effort !== 'object' || effort === null || Array.isArray(effort)) {
    fail(`Invalid consult.reasoningEffort in Codev config: expected an object mapping lane -> effort.`);
  }
  for (const [lane, value] of Object.entries(effort as Record<string, unknown>)) {
    if (!(REASONING_EFFORT_LANES as readonly string[]).includes(lane)) {
      fail(
        `Unknown lane "${lane}" in consult.reasoningEffort. ` +
        `Only ${quoted(REASONING_EFFORT_LANES)} exposes a reasoning-effort setting.\n` +
        `(This key space is narrower than consult.models', which also accepts ` +
        `${quoted(MODEL_CONFIGURABLE_LANES.filter(l => l !== 'codex'))}.)`
      );
    }
    if (typeof value !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
      fail(
        `Invalid consult.reasoningEffort.${lane} value ${JSON.stringify(value)}. ` +
        `Valid values: ${quoted(REASONING_EFFORTS)}.`
      );
    }
  }
}

export function validatePricing(pricing: unknown): void {
  if (pricing === undefined) return;
  if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) {
    fail(`Invalid consult.pricing in Codev config: expected an object.`);
  }
  for (const [lane, rates] of Object.entries(pricing as Record<string, unknown>)) {
    if (lane !== 'codex') {
      fail(
        `Unknown lane "${lane}" in consult.pricing. Only "codex" needs a pricing override ` +
        `(Claude reports its own cost; the gemini/agy lane reports no usage data).`
      );
    }
    if (typeof rates !== 'object' || rates === null || Array.isArray(rates)) {
      fail(`Invalid consult.pricing.codex: expected an object with per-1M token rates.`);
    }
    const required = ['inputPer1M', 'cachedInputPer1M', 'outputPer1M'];
    const present = Object.keys(rates as Record<string, unknown>);
    const missing = required.filter(k => !present.includes(k));
    if (missing.length > 0) {
      fail(
        `Incomplete consult.pricing.codex: missing ${quoted(missing)}. ` +
        `All of ${quoted(required)} must be supplied together — defaulting any one of them to a ` +
        `stale built-in rate would reintroduce the wrong-cost problem this override exists to fix.`
      );
    }
    for (const k of required) {
      const v = (rates as Record<string, unknown>)[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        fail(`Invalid consult.pricing.codex.${k}: expected a non-negative number, got ${JSON.stringify(v)}.`);
      }
    }
  }
}

/** Validate a lane list (or a whole-value special mode) wherever one is accepted. */
export function validateLaneList(value: unknown, key: string): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    if ((SPECIAL_MODES as readonly string[]).includes(value)) return;
    if (VALID_LANE_NAMES.includes(value)) return;
    fail(
      `Invalid consultation model "${value}" in ${key}. ` +
      `Valid models: ${quoted(VALID_LANE_NAMES)}. Special modes: ${quoted(SPECIAL_MODES)}.`
    );
  }
  if (!Array.isArray(value)) {
    fail(`Invalid ${key} in Codev config: expected a lane name, an array of lane names, or ${quoted(SPECIAL_MODES)}.`);
  }
  for (const lane of value) {
    if (typeof lane !== 'string' || !VALID_LANE_NAMES.includes(lane)) {
      fail(
        `Invalid consultation model ${JSON.stringify(lane)} in ${key}. ` +
        `Valid models: ${quoted(VALID_LANE_NAMES)}. Special modes: ${quoted(SPECIAL_MODES)}.`
      );
    }
  }
}

/**
 * Validate `porch.consultation`, including the discovered key spaces for `modelsByType` and
 * `byProtocol`.
 *
 * Key-space discovery is deliberately asymmetric (see spec):
 *   - protocol names: UNION across all four resolver tiers (any visible name is runnable)
 *   - review types:   from the RESOLVED protocol.json per name only (a shadowed copy never runs)
 *
 * Discovery touches the filesystem, so it runs only when the relevant keys are actually present —
 * zero-config workspaces pay nothing.
 */
export function validateConsultationConfig(consultation: unknown, workspaceRoot: string): void {
  if (consultation === undefined) return;
  if (typeof consultation !== 'object' || consultation === null || Array.isArray(consultation)) {
    fail(`Invalid porch.consultation in Codev config: expected an object.`);
  }
  const c = consultation as ConsultationConfig;

  validateLaneList(c.models, 'porch.consultation.models');

  if (c.modelsByType !== undefined) {
    if (typeof c.modelsByType !== 'object' || c.modelsByType === null || Array.isArray(c.modelsByType)) {
      fail(`Invalid porch.consultation.modelsByType: expected an object mapping review type -> lanes.`);
    }
    const knownTypes = listReviewTypes(workspaceRoot);
    for (const [type, lanes] of Object.entries(c.modelsByType)) {
      if (!knownTypes.has(type)) {
        fail(
          `Unknown review type "${type}" in porch.consultation.modelsByType. ` +
          `Review types declared by the protocols available here: ${quoted([...knownTypes].sort())}.`
        );
      }
      validateLaneList(lanes, `porch.consultation.modelsByType.${type}`);
    }
  }

  if (c.byProtocol !== undefined) {
    if (typeof c.byProtocol !== 'object' || c.byProtocol === null || Array.isArray(c.byProtocol)) {
      fail(`Invalid porch.consultation.byProtocol: expected an object mapping protocol name -> overrides.`);
    }
    const knownProtocols = listProtocolNames(workspaceRoot);
    const seenCanonical = new Map<string, string>();

    for (const [name, overrides] of Object.entries(c.byProtocol)) {
      if (!knownProtocols.has(name)) {
        fail(
          `Unknown protocol "${name}" in porch.consultation.byProtocol. ` +
          `Protocols available here (including aliases): ${quoted([...knownProtocols].sort())}.`
        );
      }
      // An alias and its canonical name are the SAME entry. Accepting both would make review
      // cost depend on which spelling won, so it is an error rather than a silent coin flip.
      const canonical = canonicalProtocolName(workspaceRoot, name);
      const prior = seenCanonical.get(canonical);
      if (prior !== undefined && prior !== name) {
        fail(
          `porch.consultation.byProtocol contains both "${prior}" and "${name}", which are the same ` +
          `protocol ("${canonical}"). Use one spelling.`
        );
      }
      seenCanonical.set(canonical, name);

      if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
        fail(`Invalid porch.consultation.byProtocol.${name}: expected an object.`);
      }
      validateLaneList(overrides.models, `porch.consultation.byProtocol.${name}.models`);
      if (overrides.modelsByType !== undefined) {
        // `=== null` is load-bearing: typeof null === 'object', so without it a null slips through
        // to Object.entries() and raises a bare TypeError instead of a keyed config error.
        if (
          typeof overrides.modelsByType !== 'object' ||
          overrides.modelsByType === null ||
          Array.isArray(overrides.modelsByType)
        ) {
          fail(`Invalid porch.consultation.byProtocol.${name}.modelsByType: expected an object mapping review type -> lanes.`);
        }
        const knownTypes = listReviewTypes(workspaceRoot);
        for (const [type, lanes] of Object.entries(overrides.modelsByType)) {
          if (!knownTypes.has(type)) {
            fail(
              `Unknown review type "${type}" in porch.consultation.byProtocol.${name}.modelsByType. ` +
              `Review types declared by the protocols available here: ${quoted([...knownTypes].sort())}.`
            );
          }
          validateLaneList(lanes, `porch.consultation.byProtocol.${name}.modelsByType.${type}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the model id for a lane.
 *
 * Returns `{}` when unconfigured — callers keep their own hardcoded default, so zero-config
 * behavior is preserved by construction rather than by a default duplicated here.
 */
export function resolveLaneModel(
  consult: ConsultLaneConfig | undefined,
  lane: ConfigurableLane,
): ResolvedLaneModel {
  const id = consult?.models?.[lane];
  if (id === undefined) return {};
  return { id, key: `consult.models.${lane}` };
}

/** Resolve codex reasoning effort; undefined means "keep the backend's current default". */
export function resolveReasoningEffort(consult: ConsultLaneConfig | undefined): ModelReasoningEffort | undefined {
  return consult?.reasoningEffort?.codex;
}

function normalizeLaneList(value: LaneList): { models: string[]; mode: ConsultMode } | null {
  if (typeof value === 'string') {
    if (value === 'none') return { models: [], mode: 'none' };
    if (value === 'parent') return { models: [], mode: 'parent' };
    return { models: [value], mode: 'normal' };
  }
  return { models: value, mode: 'normal' };
}

/**
 * Resolve which lanes run, for a protocol + review type.
 *
 * Precedence (highest first):
 *   1. porch.consultation.byProtocol[P].modelsByType[T]
 *   2. porch.consultation.byProtocol[P].models
 *   3. porch.consultation.modelsByType[T]
 *   4. porch.consultation.models
 *   5. the protocol's own verify.models
 *
 * `protocol` is canonicalized so an alias key (`byProtocol.spider`) matches a project running under
 * the canonical name (`spir`) and vice versa — otherwise the key would validate and silently no-op.
 */
export function resolveLaneComposition(
  consultation: ConsultationConfig | undefined,
  protocol: string,
  reviewType: string | undefined,
  protocolModels: string[],
  workspaceRoot: string,
): { models: string[]; mode: ConsultMode } {
  const fallback = { models: protocolModels, mode: 'normal' as const };
  if (!consultation) return fallback;

  const canonical = canonicalProtocolName(workspaceRoot, protocol);
  let scoped: { models?: LaneList; modelsByType?: Record<string, LaneList> } | undefined;
  for (const [name, overrides] of Object.entries(consultation.byProtocol ?? {})) {
    if (canonicalProtocolName(workspaceRoot, name) === canonical) {
      scoped = overrides;
      break;
    }
  }

  const candidates: (LaneList | undefined)[] = [
    reviewType ? scoped?.modelsByType?.[reviewType] : undefined,
    scoped?.models,
    reviewType ? consultation.modelsByType?.[reviewType] : undefined,
    consultation.models,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const normalized = normalizeLaneList(candidate);
    if (normalized) return normalized;
  }

  return fallback;
}
