/**
 * Resolution logic for `codev.openArchitectTerminal` (issue #1497).
 *
 * Extracted from `extension.ts` so the not-live-`main` path is unit-testable
 * without activating the extension (its 78-import graph is impractical to load
 * under the vitest `vscode` mock). The command in `extension.ts` is now a thin
 * adapter over `openResolvedArchitect`.
 *
 * ## The invariant this module holds
 *
 * No terminal is ever opened (and therefore cached, in `TerminalManager`, under
 * `architect:<name>`) while hosting a different architect. In `terminal-manager.ts`
 * the architect name is an ADDRESS twice over: the terminal cache key and the
 * `injectArchitectText` lookup. So the name flowed to `openArchitect` MUST be the
 * resolved occupant's own name, never the requested name when they differ.
 *
 * Pre-#1497 the command resolved a non-live `main` to `architects[0]` (a
 * different architect) but flowed the requested name `'main'` onward: the wrong
 * terminal was cached under `architect:main`, wore the unqualified
 * "Codev: Architect" label, and captured any text later injected at `'main'`.
 * That `|| 'main'` fallback is removed here (`resolveArchitectTarget` has no
 * fallback), so a request for a non-live `main` refuses with the existing
 * warning rather than substituting.
 */

/** An architect as carried by the workspace-state / overview roster. */
export interface ResolvableArchitect {
  name: string;
  terminalId?: string;
}

/**
 * The side effects `openResolvedArchitect` needs, injected so the resolution is
 * testable against recorders (a fake `openArchitect`, a fake `warn`) instead of
 * a live `TerminalManager` + Tower pty.
 */
export interface OpenArchitectDeps {
  /** Open + focus the resolved architect's terminal (delegates to TerminalManager). */
  openArchitect(terminalId: string, architectName: string, focus: boolean): Promise<void> | void;
  /** Surface the "no such architect" warning to the user. */
  warn(message: string): void;
}

/**
 * Resolve the architect to open. Exact-name match only: when `targetName` is not
 * in the live roster (a Tower restart window, a crashed/reattaching session, a
 * transiently stale overview) this returns `undefined` rather than substituting a
 * different architect. There is deliberately NO `targetName === 'main'` fallback
 * to `architects[0]` (issue #1497): that fallback only ever ran when `main` was
 * absent, so its entire realized behaviour was the failure window.
 */
export function resolveArchitectTarget(
  architects: ResolvableArchitect[],
  targetName: string,
): ResolvableArchitect | undefined {
  return architects.find(a => a.name === targetName);
}

/**
 * Resolve `targetName` and either open its terminal under ITS OWN name (so the
 * cache key, label, and later injection all address the real occupant) or refuse
 * with the existing warning. Returns the resolved architect's own name on
 * success, or `undefined` on refusal so reference-injection callers skip the
 * injection entirely.
 */
export async function openResolvedArchitect(
  architects: ResolvableArchitect[],
  targetName: string,
  deps: OpenArchitectDeps,
): Promise<string | undefined> {
  const target = resolveArchitectTarget(architects, targetName);
  if (target?.terminalId) {
    // Flow the resolved occupant's OWN name onward, never the requested name.
    // This holds the invariant structurally, even if a fallback is ever
    // reintroduced in resolveArchitectTarget.
    await deps.openArchitect(target.terminalId, target.name, true);
    return target.name;
  }
  // The warning names what the user ASKED for (targetName), e.g. "No 'main'
  // architect found", which is the legible signal during a main flicker.
  deps.warn(`Codev: No '${targetName}' architect found — is the workspace activated?`);
  return undefined;
}
