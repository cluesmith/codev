/**
 * Protocol Loader
 *
 * Loads and validates protocol definitions from JSON files.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Protocol, Phase, Check, ConsultationConfig, GateConfig } from './types.js';

/**
 * Known protocol locations (relative to project root)
 */
const PROTOCOL_PATHS = [
  'codev/protocols',
  'codev-skeleton/protocols',
];

/**
 * Protocol definition as stored in JSON
 */
interface ProtocolJson {
  name: string;
  version: string;
  description: string;
  phases: PhaseJson[];
  signals?: Record<string, SignalJson>;
  defaults?: {
    consultation?: {
      enabled?: boolean;
      models?: string[];
      parallel?: boolean;
    };
    checks?: Record<string, string>;
  };
}

interface PhaseJson {
  id: string;
  name: string;
  description?: string;
  type: 'once' | 'per_plan_phase';
  steps?: string[];
  checks?: Record<string, CheckJson>;
  consultation?: ConsultationJson;
  gate?: GateJson;
  transition?: TransitionJson;
}

interface CheckJson {
  command: string;
  on_fail?: string;
  max_retries?: number;
  retry_delay?: number;
}

interface ConsultationJson {
  on?: 'review' | 'complete';
  models?: string[];
  type?: string;
  parallel?: boolean;
  max_rounds?: number;
  next?: string;
}

interface GateJson {
  name: string;
  description?: string;
  requires?: string[];
  next?: string | null;
}

interface TransitionJson {
  on_complete?: string;
  on_fail?: string;
  on_too_complex?: string;
  on_all_phases_complete?: string;
}

interface SignalJson {
  description?: string;
  transitions_to?: string;
  requires?: string;
}

/**
 * Find protocol JSON file
 */
export function findProtocolFile(projectRoot: string, protocolName: string): string | null {
  for (const basePath of PROTOCOL_PATHS) {
    const fullPath = resolve(projectRoot, basePath, protocolName, 'protocol.json');
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Load protocol from JSON file
 */
export function loadProtocol(projectRoot: string, protocolName: string): Protocol | null {
  const filePath = findProtocolFile(projectRoot, protocolName);

  if (!filePath) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content) as ProtocolJson;
    return convertJsonToProtocol(json);
  } catch (error) {
    console.error(`Failed to load protocol ${protocolName}: ${error}`);
    return null;
  }
}

/**
 * Convert JSON representation to Protocol type
 */
function convertJsonToProtocol(json: ProtocolJson): Protocol {
  const phases: Phase[] = [];

  for (const phaseJson of json.phases) {
    phases.push(convertPhase(phaseJson, json.defaults));
  }

  // Determine initial state - first phase with first substate or just phase id
  const firstPhase = phases[0];
  const initialState = firstPhase.substates && firstPhase.substates.length > 0
    ? `${firstPhase.id}:${firstPhase.substates[0]}`
    : firstPhase.id;

  return {
    name: json.name,
    version: json.version,
    description: json.description,
    phases,
    initial: initialState,
  };
}

/**
 * Convert phase JSON to Phase type
 */
function convertPhase(json: PhaseJson, defaults?: ProtocolJson['defaults']): Phase {
  const phase: Phase = {
    id: json.id,
    name: json.name,
    phased: json.type === 'per_plan_phase',
  };

  // Add substates from steps
  if (json.steps && json.steps.length > 0) {
    phase.substates = json.steps;
  }

  // Add checks
  if (json.checks) {
    phase.checks = {};
    for (const [name, checkJson] of Object.entries(json.checks)) {
      phase.checks[name] = convertCheck(checkJson);
    }
  }

  // Add consultation
  if (json.consultation) {
    phase.consultation = convertConsultation(json.consultation, defaults?.consultation);
  }

  // Add gate - determine when gate triggers based on requires or last step
  if (json.gate) {
    // Gate triggers after the last required substate, or after the last step
    const gateAfter = json.gate.requires?.length
      ? json.gate.requires[json.gate.requires.length - 1]
      : json.steps?.length
        ? json.steps[json.steps.length - 1]
        : null;
    phase.gate = convertGate(json.gate, gateAfter);
  }

  // Build signals from transitions
  if (json.transition) {
    phase.signals = {};
    if (json.transition.on_complete) {
      phase.signals['PHASE_COMPLETE'] = json.transition.on_complete;
    }
    if (json.transition.on_fail) {
      phase.signals['PHASE_FAILED'] = json.transition.on_fail;
    }
    if (json.transition.on_all_phases_complete) {
      phase.signals['ALL_PHASES_COMPLETE'] = json.transition.on_all_phases_complete;
    }
  }

  // Mark as terminal if gate has no next
  if (json.gate && json.gate.next === null) {
    phase.terminal = true;
  }

  return phase;
}

/**
 * Convert check JSON to Check type
 */
function convertCheck(json: CheckJson): Check {
  return {
    command: json.command,
    on_fail: json.on_fail || 'retry',
    max_retries: json.max_retries ?? 3,
    retry_delay: json.retry_delay ?? 5,
  };
}

/**
 * Convert consultation JSON to ConsultationConfig type
 */
function convertConsultation(
  json: ConsultationJson,
  defaults?: { enabled?: boolean; models?: string[]; parallel?: boolean }
): ConsultationConfig {
  return {
    on: json.on || 'review',
    models: json.models || defaults?.models || ['gemini', 'codex', 'claude'],
    type: json.type || 'impl-review',
    parallel: json.parallel ?? defaults?.parallel ?? true,
    max_rounds: json.max_rounds ?? 3,
    next: json.next || '',
  };
}

/**
 * Convert gate JSON to GateConfig type
 * @param json - Gate configuration from protocol JSON
 * @param gateAfter - Substate after which the gate triggers (from requires or last step)
 */
function convertGate(json: GateJson, gateAfter: string | null): GateConfig {
  return {
    after: gateAfter || json.name, // Use computed trigger point, fallback to gate name
    type: 'human',
    next: json.next || '',
  };
}

/**
 * Get all available protocols
 */
export function listProtocols(projectRoot: string): string[] {
  const protocols: string[] = [];

  for (const basePath of PROTOCOL_PATHS) {
    const fullPath = resolve(projectRoot, basePath);
    if (existsSync(fullPath)) {
      try {
        const entries = readdirSync(fullPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const protocolFile = join(fullPath, entry.name, 'protocol.json');
            if (existsSync(protocolFile)) {
              protocols.push(entry.name);
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }
  }

  return [...new Set(protocols)];
}

/**
 * Get default protocol (spider)
 */
export function getDefaultProtocol(projectRoot: string): Protocol | null {
  return loadProtocol(projectRoot, 'spider');
}

/**
 * Validate a protocol has required phases
 */
export function validateProtocol(protocol: Protocol): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!protocol.name) {
    errors.push('Protocol name is required');
  }

  if (!protocol.phases || protocol.phases.length === 0) {
    errors.push('Protocol must have at least one phase');
  }

  if (!protocol.initial) {
    errors.push('Protocol must specify an initial state');
  }

  // Build phase ID lookup
  const phaseIds = new Set(protocol.phases.map(p => p.id));

  // Check phase signals reference valid phases
  for (const phase of protocol.phases) {
    if (phase.signals) {
      for (const [signal, targetPhase] of Object.entries(phase.signals)) {
        // Target might be "phaseId" or "phaseId:substate"
        const targetPhaseId = targetPhase.split(':')[0];
        if (!phaseIds.has(targetPhaseId)) {
          errors.push(`Phase '${phase.id}' signal '${signal}' references unknown phase '${targetPhaseId}'`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get phase by ID
 */
export function getPhase(protocol: Protocol, phaseId: string): Phase | null {
  return protocol.phases.find(p => p.id === phaseId) || null;
}

/**
 * Get the next phase after a given phase
 */
export function getNextPhase(protocol: Protocol, currentPhaseId: string): Phase | null {
  const currentIndex = protocol.phases.findIndex(p => p.id === currentPhaseId);
  if (currentIndex === -1 || currentIndex >= protocol.phases.length - 1) {
    return null;
  }
  return protocol.phases[currentIndex + 1];
}

/**
 * Check if a phase is a terminal phase (no next phase)
 */
export function isTerminalPhase(protocol: Protocol, phaseId: string): boolean {
  const phase = getPhase(protocol, phaseId);
  return phase?.terminal ?? false;
}

/**
 * Get phased phases (phases that run per plan phase)
 */
export function getPhasedPhases(protocol: Protocol): Phase[] {
  return protocol.phases.filter(p => p.phased);
}
