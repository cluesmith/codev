/**
 * Architect-name utilities (Spec 755).
 *
 * - validateArchitectName: enforces the [a-z][a-z0-9-]* rule with a 64-char cap.
 * - autoNumberArchitectName: returns the next available `architect-<N>` name
 *   (smallest unused integer ≥ 2) given the set of already-registered names.
 *
 * `validateArchitectName`, `autoNumberArchitectName`, and the name constants
 * live in codev-sdk (Issue 841) so the VS Code extension's "Add Architect"
 * InputBox validates with the exact same rule Tower enforces server-side; we
 * re-export them here so existing agent-farm callsites are unaffected.
 * `currentArchitectName` reads the process env and stays local to this package.
 */

export {
  ARCHITECT_NAME_PATTERN,
  MAX_ARCHITECT_NAME_LENGTH,
  DEFAULT_ARCHITECT_NAME,
  validateArchitectName,
  autoNumberArchitectName,
} from '@cluesmith/codev-sdk/architect-name';
import { DEFAULT_ARCHITECT_NAME } from '@cluesmith/codev-sdk/architect-name';

/**
 * Resolve the *current* terminal session's architect name (Spec 1057).
 *
 * Tower injects `CODEV_ARCHITECT_NAME` into every architect terminal it starts
 * (see `commands/spawn.ts` and `servers/tower-instances.ts`). When present, it
 * names the architect whose terminal this command is running in — exactly what
 * `afx status --mine` needs to scope builders to "my own". When absent (a plain
 * shell, or a pre-#786 single-architect workspace) we fall back to the reserved
 * default `main`.
 *
 * Pure apart from the default `env` binding; pass an explicit `env` in tests.
 */
export function currentArchitectName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.CODEV_ARCHITECT_NAME?.trim();
  return value || DEFAULT_ARCHITECT_NAME;
}
