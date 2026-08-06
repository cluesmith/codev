/**
 * Pure, vscode-free resolution of a builder's live terminal from Tower's
 * workspace-state, with a bounded retry that absorbs the transient window in
 * which Tower's session registry disagrees with the sidebar (PIR #982).
 *
 * The sidebar lists a builder as soon as its worktree exists on disk
 * (`/api/overview`), but the terminal opener needs a *live* PTY session
 * (`/api/state`, which includes a builder only if `manager.getSession` resolves).
 * `/api/state` rehydrates and on-the-fly-reconnects shellper sessions on every
 * call, so a click that lands mid-rehydration, during Tower's startup
 * reconciliation, or in the spawn race sees the builder momentarily without a
 * live `terminalId` — and the very next call resolves it. Retrying a few times
 * with a short backoff lets that dominant, transient case heal silently instead
 * of dead-ending on the "No active terminal" warning. Only a genuinely
 * persistent miss (dead shellper, reaped session) falls through to `missing`.
 *
 * Kept vscode-free (deps injected) so it unit-tests under the vitest `__tests__/`
 * harness — mirroring `views/builder-row.ts` — rather than needing a full vscode
 * mock. The toast/recovery UX it feeds lives in `terminal-manager.ts`.
 */

import { backoffDelayMs } from '@cluesmith/codev-sdk/reconnect-policy';
import { resolveAgentName } from '@cluesmith/codev-sdk/agent-names';

/**
 * Retry budget for the resolve. The first attempt is the original lookup;
 * the remaining attempts each re-trigger Tower's rehydrate/reconnect. Four
 * attempts with the backoff below spans ~1s of wall-clock total.
 */
export const TERMINAL_RESOLVE_ATTEMPTS = 4;

/**
 * Interactive-tuned backoff parameters fed to the shared `backoffDelayMs`
 * curve (`@cluesmith/codev-sdk/reconnect-policy`). The module's defaults
 * (base 1000ms, cap 30_000ms) are sized for persistent reconnect loops and
 * would make a sidebar click feel laggy; these produce ~150ms, 300ms, 600ms
 * between attempts — snappy enough for a click while still spanning the
 * sub-second self-heal window. Same primitive, interactive parameters.
 */
const RESOLVE_BASE_MS = 150;
const RESOLVE_CAP_MS = 800;

/** Minimum a builder needs for this resolution: an id and a (maybe) terminalId. */
export interface ResolvableBuilder {
  id: string;
  terminalId?: string;
}

export type TerminalResolveOutcome<T extends ResolvableBuilder> =
  /** Builder found with a live terminal session. */
  | { kind: 'ok'; builder: T; terminalId: string }
  /** `roleOrId` matched more than one builder — caller should disambiguate. */
  | { kind: 'ambiguous'; matches: T[] }
  /** No live terminal after all attempts — likely persistent (recovery path). */
  | { kind: 'missing' };

export interface TerminalResolveDeps {
  /** Sleep between attempts. Injected so tests run without real delays. */
  sleep: (ms: number) => Promise<void>;
  /** Override the attempt count (tests). Defaults to {@link TERMINAL_RESOLVE_ATTEMPTS}. */
  attempts?: number;
}

/**
 * Resolve `roleOrId` to a builder with a live terminal, retrying the
 * `fetchBuilders` lookup with a short backoff to absorb the transient
 * session-registry window. Ambiguity is stable (it's a matter of how many
 * builders share the id tail), so it short-circuits immediately rather than
 * retrying.
 */
export async function resolveBuilderTerminal<T extends ResolvableBuilder>(
  roleOrId: string,
  fetchBuilders: () => Promise<T[]>,
  deps: TerminalResolveDeps,
): Promise<TerminalResolveOutcome<T>> {
  const attempts = deps.attempts ?? TERMINAL_RESOLVE_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const builders = await fetchBuilders();
    const { builder, ambiguous } = resolveAgentName(roleOrId, builders);
    if (ambiguous) {
      return { kind: 'ambiguous', matches: ambiguous };
    }
    if (builder?.terminalId) {
      return { kind: 'ok', builder, terminalId: builder.terminalId };
    }
    if (attempt < attempts - 1) {
      await deps.sleep(backoffDelayMs(attempt, { baseMs: RESOLVE_BASE_MS, capMs: RESOLVE_CAP_MS }));
    }
  }
  return { kind: 'missing' };
}

/**
 * The main-checkout root for an `afx` command, given the VSCode window's
 * detected workspace path.
 *
 * A builder worktree lives at `<root>/.builders/<id>` and is itself a full
 * checkout (it has its own `codev/`), so `detectWorkspacePath`'s walk-up stops
 * at the worktree when VSCode is *rooted at* that worktree — `getWorkspacePath()`
 * then returns the worktree, not the main checkout. `afx workspace recover` must
 * run from the main root (repo guidance: never run `afx` from inside a
 * worktree), so strip a trailing `/.builders/<id>` segment when present.
 * A normal main-checkout window has no such suffix and is returned unchanged.
 */
export function mainCheckoutRoot(workspacePath: string): string {
  const match = /[\\/]\.builders[\\/][^\\/]+\/?$/.exec(workspacePath);
  return match ? workspacePath.slice(0, match.index) : workspacePath;
}
