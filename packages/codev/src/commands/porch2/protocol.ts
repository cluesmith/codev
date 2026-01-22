/**
 * Porch2 Protocol Loading
 *
 * Loads protocol definitions from JSON files.
 * Fails loudly if protocol not found or invalid.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Protocol, ProtocolPhase } from './types.js';

/** Known protocol locations (relative to project root) */
const PROTOCOL_PATHS = [
  'codev/porch/protocols',
  'codev-skeleton/porch/protocols',
];

// ============================================================================
// Protocol Loading
// ============================================================================

/**
 * Find and load a protocol by name
 * Fails loudly if not found or invalid.
 */
export function loadProtocol(projectRoot: string, protocolName: string): Protocol {
  const protocolFile = findProtocolFile(projectRoot, protocolName);

  if (!protocolFile) {
    throw new Error(
      `Protocol '${protocolName}' not found.\n` +
      `Searched in: ${PROTOCOL_PATHS.map(p => path.join(projectRoot, p, protocolName)).join(', ')}`
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
 * Find protocol file (supports both {name}.json and {name}/protocol.json)
 */
function findProtocolFile(projectRoot: string, protocolName: string): string | null {
  for (const basePath of PROTOCOL_PATHS) {
    // Try {name}.json first (flat structure)
    const flatPath = path.resolve(projectRoot, basePath, `${protocolName}.json`);
    if (fs.existsSync(flatPath)) {
      return flatPath;
    }
    // Then try {name}/protocol.json (directory structure)
    const dirPath = path.resolve(projectRoot, basePath, protocolName, 'protocol.json');
    if (fs.existsSync(dirPath)) {
      return dirPath;
    }
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

  // Extract default checks
  const checks: Record<string, string> = {};
  const defaults = obj.defaults as Record<string, unknown> | undefined;
  if (defaults?.checks) {
    Object.assign(checks, defaults.checks);
  }

  // Also collect per-phase checks
  for (const phase of obj.phases as Array<Record<string, unknown>>) {
    if (phase.checks && typeof phase.checks === 'object') {
      for (const [name, check] of Object.entries(phase.checks as Record<string, unknown>)) {
        if (typeof check === 'object' && check !== null && 'command' in check) {
          checks[name] = (check as { command: string }).command;
        } else if (typeof check === 'string') {
          checks[name] = check;
        }
      }
    }
  }

  return {
    name: obj.name as string,
    version: obj.version as string | undefined,
    description: obj.description as string | undefined,
    phases,
    checks,
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
  const gate = phase.gate as Record<string, unknown> | undefined;

  if (transition?.on_complete) {
    next = transition.on_complete as string;
  } else if (gate?.next !== undefined) {
    next = gate.next as string | null;
  }

  // Collect check names
  const checks: string[] = [];
  if (phase.checks && typeof phase.checks === 'object') {
    checks.push(...Object.keys(phase.checks as Record<string, unknown>));
  }

  return {
    id: phase.id as string,
    name: (phase.name as string) || phase.id as string,
    type: phase.type as 'once' | 'per_plan_phase' | 'phased' | undefined,
    gate: gate?.name as string | undefined,
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
 * Get check commands for a phase
 */
export function getPhaseChecks(protocol: Protocol, phaseId: string): Record<string, string> {
  const phase = getPhaseConfig(protocol, phaseId);
  if (!phase || !phase.checks) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const checkName of phase.checks) {
    if (protocol.checks?.[checkName]) {
      result[checkName] = protocol.checks[checkName];
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
 * Check if a phase is "phased" (runs per plan phase)
 */
export function isPhased(protocol: Protocol, phaseId: string): boolean {
  const phase = getPhaseConfig(protocol, phaseId);
  return phase?.type === 'per_plan_phase' || phase?.type === 'phased';
}
