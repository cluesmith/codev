/**
 * Signal Parser
 *
 * Extracts signals from Claude output and validates them against protocol definitions.
 * Signals use XML-style tags: <signal>SIGNAL_NAME</signal>
 */

import type { Protocol, Phase } from './types.js';

/**
 * Signal extraction result
 */
export interface SignalResult {
  signal: string | null;
  allSignals: string[];
  isValid: boolean;
  error?: string;
}

/**
 * Extract signal from Claude output
 *
 * Rules:
 * - Scan for <signal>...</signal> patterns
 * - Return the LAST signal found (multiple signals → last wins)
 * - Return null if no signal found
 */
export function extractSignal(output: string): string | null {
  const matches = output.match(/<signal>([^<]+)<\/signal>/gi);
  if (!matches || matches.length === 0) return null;

  // Get the last match
  const lastMatch = matches[matches.length - 1];
  const signalMatch = lastMatch.match(/<signal>([^<]+)<\/signal>/i);
  return signalMatch ? signalMatch[1].trim() : null;
}

/**
 * Extract all signals from output
 */
export function extractAllSignals(output: string): string[] {
  const matches = output.match(/<signal>([^<]+)<\/signal>/gi);
  if (!matches) return [];

  return matches.map(match => {
    const signalMatch = match.match(/<signal>([^<]+)<\/signal>/i);
    return signalMatch ? signalMatch[1].trim() : '';
  }).filter(Boolean);
}

/**
 * Validate a signal against the protocol definition
 *
 * Returns true if the signal is valid for the current phase.
 * Unknown signals are logged but considered valid (lenient mode).
 */
export function validateSignal(
  signal: string,
  protocol: Protocol,
  currentState: string
): { valid: boolean; nextState?: string; warning?: string } {
  const [phaseId, substate] = currentState.split(':');
  const phase = protocol.phases.find(p => p.id === phaseId);

  if (!phase) {
    return {
      valid: false,
      warning: `Unknown phase: ${phaseId}`,
    };
  }

  // Check if signal is defined for this phase
  if (phase.signals && phase.signals[signal]) {
    return {
      valid: true,
      nextState: phase.signals[signal],
    };
  }

  // Signal not defined - lenient mode: allow but warn
  return {
    valid: true, // Allow unknown signals to prevent blocking
    warning: `Signal "${signal}" not defined in protocol for phase ${phaseId}`,
  };
}

/**
 * Extract and validate signal from output
 */
export function parseSignal(
  output: string,
  protocol: Protocol,
  currentState: string
): SignalResult {
  const signal = extractSignal(output);
  const allSignals = extractAllSignals(output);

  if (!signal) {
    return {
      signal: null,
      allSignals: [],
      isValid: true, // No signal is valid (use default transition)
    };
  }

  const validation = validateSignal(signal, protocol, currentState);

  return {
    signal,
    allSignals,
    isValid: validation.valid,
    error: validation.warning,
  };
}

/**
 * Get valid signals for a phase
 */
export function getValidSignals(protocol: Protocol, phaseId: string): string[] {
  const phase = protocol.phases.find(p => p.id === phaseId);
  if (!phase?.signals) return [];
  return Object.keys(phase.signals);
}

/**
 * Common signals used across protocols
 */
export const CommonSignals = {
  // Specify phase
  SPEC_DRAFTED: 'SPEC_DRAFTED',
  SPEC_READY: 'SPEC_READY',
  REVISION_COMPLETE: 'REVISION_COMPLETE',

  // Plan phase
  PLAN_DRAFTED: 'PLAN_DRAFTED',
  PLAN_READY: 'PLAN_READY',

  // Implement phase
  PHASE_IMPLEMENTED: 'PHASE_IMPLEMENTED',
  IMPLEMENTATION_COMPLETE: 'IMPLEMENTATION_COMPLETE',

  // Defend phase
  TESTS_WRITTEN: 'TESTS_WRITTEN',
  TESTS_PASSING: 'TESTS_PASSING',

  // Evaluate phase
  EVALUATION_COMPLETE: 'EVALUATION_COMPLETE',
  PHASE_COMPLETE: 'PHASE_COMPLETE',

  // Review phase
  REVIEW_COMPLETE: 'REVIEW_COMPLETE',

  // TICK protocol
  UNDERSTOOD: 'UNDERSTOOD',
  IMPLEMENTED: 'IMPLEMENTED',
  VERIFIED: 'VERIFIED',

  // BUGFIX protocol
  DIAGNOSED: 'DIAGNOSED',
  FIXED: 'FIXED',
  TESTED: 'TESTED',
  PR_CREATED: 'PR_CREATED',

  // General
  COMPLETE: 'COMPLETE',
  BLOCKED: 'BLOCKED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
} as const;

/**
 * Format a signal for output
 */
export function formatSignal(signal: string): string {
  return `<signal>${signal}</signal>`;
}

/**
 * Check if output contains any signal
 */
export function hasSignal(output: string): boolean {
  return /<signal>[^<]+<\/signal>/i.test(output);
}

/**
 * Strip all signals from output (for clean display)
 */
export function stripSignals(output: string): string {
  return output.replace(/<signal>[^<]+<\/signal>/gi, '').trim();
}
