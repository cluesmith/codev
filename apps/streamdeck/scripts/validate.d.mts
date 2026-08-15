// Type declarations for validate.mjs so its exported, unit-tested core resolves under tsc
// (NodeNext maps a `./validate.mjs` import to this `./validate.d.mts`) without a suppression.

/** One run of the validate command: its exit code and combined stdout+stderr. */
export interface RunResult {
  code: number;
  output: string;
}

/** A finished attempt loop: the last run's result plus how many attempts it took. */
export interface BackoffResult extends RunResult {
  attempts: number;
}

export interface BackoffOptions {
  run: (attempt: number) => Promise<RunResult>;
  attempts?: number;
  baseBackoffMs?: number;
  isTransient?: (output: string) => boolean;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (message: string) => void;
}

export const TRANSIENT_SIGNATURES: string[];
export const DEFAULTS: { attempts: number; baseBackoffMs: number };
export function isTransientError(output: string): boolean;
export function runWithBackoff(options?: BackoffOptions): Promise<BackoffResult>;
