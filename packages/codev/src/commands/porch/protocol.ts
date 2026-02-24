/**
 * Porch Protocol Loading
 *
 * Loads protocol definitions from JSON files.
 * Fails loudly if protocol not found or invalid.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Protocol, ProtocolPhase, BuildConfig, VerifyConfig, OnCompleteConfig, CheckDef, CheckOverrides } from './types.js';

/** Known protocol locations (relative to project root) */
const PROTOCOL_PATHS = [
  'codev/protocols',
  'codev-skeleton/protocols',
];

// ============================================================================
// Protocol Loading
// ============================================================================

/**
 * Find and load a protocol by name
 * Fails loudly if not found or invalid.
 */
export function loadProtocol(workspaceRoot: string, protocolName: string): Protocol {
  const protocolFile = findProtocolFile(workspaceRoot, protocolName);

  if (!protocolFile) {
    throw new Error(
      `Protocol '${protocolName}' not found.\n` +
      `Searched in: ${PROTOCOL_PATHS.map(p => path.join(workspaceRoot, p, protocolName)).join(', ')}`
    );
  }

  try {
    const content = fs.readFileSync(protocolFile, 'utf-8');
    const json = JSON.parse(content);
    return normalizeProtocol(json);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid protocol '${protocolName}': JSON parse error\n${err.message}`);
    }
    throw err;
  }
}

/**
 * Find protocol.json file in {name}/protocol.json format.
 * Falls back to alias lookup: scans all protocol.json files for a matching "alias" field.
 */
function findProtocolFile(workspaceRoot: string, protocolName: string): string | null {
  // Direct lookup first
  for (const basePath of PROTOCOL_PATHS) {
    const fullPath = path.resolve(workspaceRoot, basePath, protocolName, 'protocol.json');
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Alias lookup: scan all protocol.json files for matching alias
  for (const basePath of PROTOCOL_PATHS) {
    const protocolsDir = path.resolve(workspaceRoot, basePath);
    if (!fs.existsSync(protocolsDir)) continue;
    try {
      const dirs = fs.readdirSync(protocolsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dir of dirs) {
        const jsonPath = path.join(protocolsDir, dir.name, 'protocol.json');
        if (!fs.existsSync(jsonPath)) continue;
        try {
          const content = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          if (content.alias === protocolName) {
            return jsonPath;
          }
        } catch { /* skip invalid JSON */ }
      }
    } catch { /* skip unreadable dirs */ }
  }

  return null;
}

/**
 * Normalize protocol JSON to our simplified Protocol type
 */
function normalizeProtocol(json: unknown): Protocol {
  const obj = json as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== 'string') {
    throw new Error('Invalid protocol: missing "name" field');
  }

  if (!obj.phases || !Array.isArray(obj.phases)) {
    throw new Error('Invalid protocol: missing "phases" array');
  }

  const phases: ProtocolPhase[] = obj.phases.map((p: unknown) => normalizePhase(p));

  // Set next phase based on array order (if not explicitly set)
  for (let i = 0; i < phases.length; i++) {
    if (!phases[i].next && i + 1 < phases.length) {
      phases[i].next = phases[i + 1].id;
    }
  }

  // Extract default checks
  const checks: Record<string, CheckDef> = {};
  const defaults = obj.defaults as Record<string, unknown> | undefined;
  if (defaults?.checks) {
    for (const [name, val] of Object.entries(defaults.checks as Record<string, unknown>)) {
      if (typeof val === 'string') {
        checks[name] = { command: val };
      } else if (typeof val === 'object' && val !== null && 'command' in val) {
        const checkObj = val as Record<string, unknown>;
        checks[name] = { command: checkObj.command as string, cwd: checkObj.cwd as string | undefined };
      }
    }
  }

  // Also collect per-phase checks (override defaults)
  for (const phase of obj.phases as Array<Record<string, unknown>>) {
    if (phase.checks && typeof phase.checks === 'object') {
      for (const [name, check] of Object.entries(phase.checks as Record<string, unknown>)) {
        if (typeof check === 'object' && check !== null && 'command' in check) {
          const checkObj = check as Record<string, unknown>;
          checks[name] = { command: checkObj.command as string, cwd: checkObj.cwd as string | undefined };
        } else if (typeof check === 'string') {
          checks[name] = { command: check };
        }
      }
    }
  }

  // Extract phase_completion checks (string predicates)
  let phase_completion: Record<string, string> | undefined;
  if (obj.phase_completion && typeof obj.phase_completion === 'object') {
    phase_completion = {};
    for (const [name, val] of Object.entries(obj.phase_completion as Record<string, unknown>)) {
      if (typeof val === 'string') {
        phase_completion[name] = val;
      }
    }
  }

  return {
    name: obj.name as string,
    version: obj.version as string | undefined,
    description: obj.description as string | undefined,
    phases,
    checks,
    phase_completion,
  };
}

/**
 * Normalize a phase from JSON
 */
function normalizePhase(p: unknown): ProtocolPhase {
  const phase = p as Record<string, unknown>;

  if (!phase.id || typeof phase.id !== 'string') {
    throw new Error('Invalid protocol phase: missing "id"');
  }

  // Determine next phase from transition or gate
  let next: string | null | undefined;
  const transition = phase.transition as Record<string, unknown> | undefined;

  // Gate can be a string (gate name) or object { name, next }
  let gateName: string | undefined;
  if (typeof phase.gate === 'string') {
    gateName = phase.gate;
  } else if (typeof phase.gate === 'object' && phase.gate !== null) {
    const gateObj = phase.gate as Record<string, unknown>;
    gateName = gateObj.name as string | undefined;
    if (gateObj.next !== undefined) {
      next = gateObj.next as string | null;
    }
  }

  if (transition?.on_complete) {
    next = transition.on_complete as string;
  }

  // Collect check names
  const checks: string[] = [];
  if (phase.checks && typeof phase.checks === 'object') {
    checks.push(...Object.keys(phase.checks as Record<string, unknown>));
  }

  // Parse build config (for build_verify phases)
  let build: BuildConfig | undefined;
  const buildRaw = phase.build as Record<string, unknown> | undefined;
  if (buildRaw) {
    build = {
      prompt: buildRaw.prompt as string,
      artifact: buildRaw.artifact as string,
    };
  }

  // Parse verify config (for build_verify phases)
  let verify: VerifyConfig | undefined;
  const verifyRaw = phase.verify as Record<string, unknown> | undefined;
  if (verifyRaw) {
    verify = {
      type: verifyRaw.type as string,
      models: verifyRaw.models as string[],
      parallel: (verifyRaw.parallel as boolean) ?? true,
    };
  }

  // Parse on_complete config
  let on_complete: OnCompleteConfig | undefined;
  const onCompleteRaw = phase.on_complete as Record<string, unknown> | undefined;
  if (onCompleteRaw) {
    on_complete = {
      commit: onCompleteRaw.commit as boolean | undefined,
      push: onCompleteRaw.push as boolean | undefined,
    };
  }

  return {
    id: phase.id as string,
    name: (phase.name as string) || phase.id as string,
    type: phase.type as 'once' | 'per_plan_phase' | 'build_verify' | undefined,
    build,
    verify,
    max_iterations: (phase.max_iterations as number) ?? 1,
    on_complete,
    gate: gateName,
    checks: checks.length > 0 ? checks : undefined,
    next,
  };
}

// ============================================================================
// Phase Queries
// ============================================================================

/**
 * Get phase configuration by id
 */
export function getPhaseConfig(protocol: Protocol, phaseId: string): ProtocolPhase | null {
  return protocol.phases.find(p => p.id === phaseId) || null;
}

/**
 * Get the next phase after the given phase
 */
export function getNextPhase(protocol: Protocol, currentPhaseId: string): ProtocolPhase | null {
  const current = getPhaseConfig(protocol, currentPhaseId);
  if (!current || !current.next) {
    return null;
  }
  return getPhaseConfig(protocol, current.next);
}

/**
 * Get check definitions for a phase, optionally merging in af-config.json overrides.
 *
 * Override semantics (applied per check name):
 *   - skip: true   → check is omitted from the result
 *   - command set  → replaces the protocol's command
 *   - cwd set      → replaces the protocol's cwd
 *
 * Unknown override names (not found in this phase's check list) are warned
 * via a chalk.yellow log line. All existing call sites that pass no overrides
 * continue to work unchanged.
 */
export function getPhaseChecks(
  protocol: Protocol,
  phaseId: string,
  overrides?: CheckOverrides
): Record<string, CheckDef> {
  const phase = getPhaseConfig(protocol, phaseId);
  if (!phase || !phase.checks) {
    return {};
  }

  // Warn about override keys that don't exist anywhere in the protocol.
  // Keys valid in other phases or phase_completion are silently accepted here.
  if (overrides) {
    const phaseNames = new Set(phase.checks);
    const allProtocolChecks = new Set([
      ...Object.keys(protocol.checks ?? {}),
      ...Object.keys(protocol.phase_completion ?? {}),
    ]);
    for (const name of Object.keys(overrides)) {
      if (phaseNames.has(name)) continue; // In this phase — normal case
      if (allProtocolChecks.has(name)) continue; // Valid elsewhere in protocol
      process.stderr.write(
        `\x1b[33m  ⚠ Unknown check override "${name}" (not found in protocol)\x1b[0m\n`
      );
    }
  }

  const result: Record<string, CheckDef> = {};
  for (const checkName of phase.checks) {
    const base = protocol.checks?.[checkName];
    if (!base) continue;

    const override = overrides?.[checkName];
    if (override) {
      if (override.skip) continue; // Omit this check
      result[checkName] = {
        command: override.command ?? base.command,
        cwd: override.cwd ?? base.cwd,
      };
    } else {
      result[checkName] = base;
    }
  }
  return result;
}

/**
 * Get gate name for a phase (if any)
 */
export function getPhaseGate(protocol: Protocol, phaseId: string): string | null {
  const phase = getPhaseConfig(protocol, phaseId);
  return phase?.gate || null;
}

/**
 * Check if a phase runs per plan phase
 */
export function isPhased(protocol: Protocol, phaseId: string): boolean {
  const phase = getPhaseConfig(protocol, phaseId);
  return phase?.type === 'per_plan_phase';
}

/**
 * Get checks to run when a plan phase completes (after evaluate stage).
 *
 * Accepts optional overrides from af-config.json:
 *   - skip: true   → condition removed from gating (does NOT auto-pass)
 *   - command set  → replaces the protocol's command string
 *
 * Note: phase_completion checks are simple string predicates, not CheckDef
 * objects. Skipping one removes that gating condition entirely.
 */
export function getPhaseCompletionChecks(
  protocol: Protocol,
  overrides?: CheckOverrides
): Record<string, string> {
  const base = protocol.phase_completion ?? {};
  if (!overrides) return base;

  // Warn about override keys that don't exist anywhere in the protocol.
  const allProtocolChecks = new Set([
    ...Object.keys(protocol.checks ?? {}),
    ...Object.keys(protocol.phase_completion ?? {}),
  ]);
  for (const name of Object.keys(overrides)) {
    if (allProtocolChecks.has(name)) continue;
    process.stderr.write(
      `\x1b[33m  ⚠ Unknown check override "${name}" (not found in protocol)\x1b[0m\n`
    );
  }

  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(base)) {
    const override = overrides[name];
    if (override?.skip) continue; // Remove this gating condition
    if (override?.command) {
      result[name] = override.command;
    } else {
      result[name] = command;
    }
  }
  return result;
}

/**
 * Check if a phase uses the build-verify cycle.
 * A phase uses build-verify if it has both build and verify configs,
 * regardless of whether type is 'build_verify' or 'per_plan_phase'.
 */
export function isBuildVerify(protocol: Protocol, phaseId: string): boolean {
  const phase = getPhaseConfig(protocol, phaseId);
  return !!(phase?.build && phase?.verify);
}

/**
 * Get build config for a phase
 */
export function getBuildConfig(protocol: Protocol, phaseId: string): BuildConfig | null {
  const phase = getPhaseConfig(protocol, phaseId);
  return phase?.build || null;
}

/**
 * Get verify config for a phase
 */
export function getVerifyConfig(protocol: Protocol, phaseId: string): VerifyConfig | null {
  const phase = getPhaseConfig(protocol, phaseId);
  return phase?.verify || null;
}

/**
 * Get max iterations for a build_verify phase
 */
export function getMaxIterations(protocol: Protocol, phaseId: string): number {
  const phase = getPhaseConfig(protocol, phaseId);
  return phase?.max_iterations ?? 1;
}

/**
 * Get on_complete config for a phase
 */
export function getOnCompleteConfig(protocol: Protocol, phaseId: string): OnCompleteConfig | null {
  const phase = getPhaseConfig(protocol, phaseId);
  return phase?.on_complete || null;
}
