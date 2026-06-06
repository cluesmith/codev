/**
 * Spec 786 Phase 6: unit tests for `TerminalManager`'s per-name terminal-slot
 * keying.
 *
 * Constructing a full `TerminalManager` requires a `vscode.OutputChannel`,
 * `vscode.Uri`, `ConnectionManager`, and `OverviewCache` — heavyweight deps
 * that would force broad vscode-API mocking. Instead, this test file
 * verifies the keying invariants at the source level:
 *
 *   1. `openArchitect` keys terminals by `architect:${architectName}` (not the
 *      pre-786 singleton `'architect'` key).
 *   2. `injectArchitectText` looks up the same key.
 *   3. Both methods default `architectName` to `'main'` so existing no-arg
 *      callers (e.g. `codev.referenceIssueInArchitect`) keep targeting `main`.
 *
 * The integration behavior (open `main` then `ob-refine` → two separate
 * VSCode terminals) is exercised by the verify-phase manual round-trip.
 * These sentinel tests catch any regression that re-introduces the singleton
 * key without requiring a full vscode harness.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TM_SRC = readFileSync(
  resolve(__dirname, '../terminal-manager.ts'),
  'utf8',
);

describe('Spec 786 Phase 6 — TerminalManager per-name keying', () => {
  it('openArchitect builds map key as `architect:${architectName}`', () => {
    // The keying scheme is critical: pre-786 used the literal `'architect'`
    // singleton, conflating all architects into one terminal slot.
    expect(TM_SRC).toMatch(/openArchitect\([^)]*architectName[^)]*\)/);
    expect(TM_SRC).toMatch(/const key = `architect:\$\{architectName\}`/);
  });

  it('injectArchitectText also keys by `architect:${architectName}`', () => {
    // Symmetric with openArchitect — same key shape so a `main` terminal
    // opened by openArchitect can be injected to by injectArchitectText.
    expect(TM_SRC).toMatch(/injectArchitectText\([^)]*architectName[^)]*\)/);
    // The key construction inside injectArchitectText.
    const injectBody = TM_SRC.split('injectArchitectText')[1] ?? '';
    expect(injectBody).toMatch(/const key = `architect:\$\{architectName\}`/);
  });

  it("both methods default architectName to 'main' for backward compat", () => {
    // Existing no-arg callers like codev.referenceIssueInArchitect MUST keep
    // targeting `main` — Phase 6 plan pin.
    expect(TM_SRC).toMatch(/openArchitect\(terminalId: string,\s*architectName: string = 'main'/);
    expect(TM_SRC).toMatch(/injectArchitectText\(text: string,\s*architectName: string = 'main'/);
  });

  it('no longer uses the pre-786 singleton `terminals.get(\'architect\')` lookup', () => {
    // The singleton key was the root cause of the "all architects share one
    // terminal" bug. Regression guard: if a future refactor brings the
    // literal back, this test fails.
    expect(TM_SRC).not.toMatch(/terminals\.get\(['"]architect['"]\)/);
  });

  it('architect label distinguishes main from siblings', () => {
    // UX detail: a sibling's VSCode terminal title includes its name so the
    // user can tell `main` from `ob-refine` in the terminal-list dropdown.
    expect(TM_SRC).toMatch(/Codev: Architect \(\$\{architectName\}\)/);
  });
});

describe('#921 — dev surface refresh on manual terminal close', () => {
  // Regression guard: a dev terminal closed via the generic onDidCloseTerminal
  // path (tab ✕ / process exit) must clear devStartedAt AND re-fire
  // onDidChangeDevTerminals, or the chip / Codev Dev tab / devServerRunning
  // context strand as "running". The explicit close paths fired the event; the
  // generic path previously only unmapped. Source-level per this file's harness
  // rationale (constructing TerminalManager needs heavy vscode mocking).
  const closeHandler = TM_SRC.split('onDidCloseTerminal((t)')[1]?.split('terminal.show')[0] ?? '';

  it('clears devStartedAt for a dev terminal closed via the generic path', () => {
    expect(closeHandler).toMatch(/mapKey\.startsWith\(['"]dev-['"]\)/);
    expect(closeHandler).toMatch(/devStartedAt\.delete\(/);
  });

  it('re-fires the dev-terminal change event from the generic close path', () => {
    expect(closeHandler).toMatch(/_onDidChangeDevTerminals\.fire\(\)/);
  });
});

describe('#991 — close on Tower stop, reopen on reconnect', () => {
  it('closeAllTerminals disposes every terminal and clears the map', () => {
    const body = TM_SRC.split('closeAllTerminals()')[1] ?? '';
    expect(body).toMatch(/entry\.pty\.close\(\)/);
    expect(body).toMatch(/entry\.terminal\.dispose\(\)/);
    expect(body).toMatch(/this\.terminals\.clear\(\)/);
  });

  it('closeAllTerminals remembers builder/architect terminals for reopen (not shell/dev)', () => {
    const body = TM_SRC.split('closeAllTerminals()')[1]?.split('reopenAfterReconnect')[0] ?? '';
    expect(body).toMatch(/mapKey\.startsWith\(['"]builder-['"]\)/);
    expect(body).toMatch(/mapKey\.startsWith\(['"]architect:['"]\)/);
    expect(body).toMatch(/this\.pendingReopen\.push/);
  });

  it('reopenAfterReconnect resolves successors from fresh state and re-opens via openBuilder/openArchitect', () => {
    const body = TM_SRC.split('async reopenAfterReconnect')[1] ?? '';
    expect(body).toMatch(/getWorkspaceState\(workspacePath\)/);
    expect(body).toMatch(/resolveAgentName\(d\.builderId/);
    expect(body).toMatch(/this\.openBuilder\(builder\.terminalId/);
    expect(body).toMatch(/this\.openArchitect\(arch\.terminalId/);
  });

  it('reopenAfterReconnect retries the reconcile race a bounded number of times', () => {
    const body = TM_SRC.split('async reopenAfterReconnect')[1] ?? '';
    expect(body).toMatch(/attempt < REOPEN_MAX_ATTEMPTS/);
    expect(body).toMatch(/await delay\(REOPEN_RETRY_MS\)/);
    expect(body).toMatch(/stillPending/);
  });
});

describe('#991 — wiring: close on disconnect, reopen on reconnect', () => {
  const EXT_SRC = readFileSync(resolve(__dirname, '../extension.ts'), 'utf8');

  it('extension closes terminals when Tower disconnects and reopens when it reconnects', () => {
    expect(EXT_SRC).toMatch(/connectionManager\.onStateChange\(\(state\) =>/);
    expect(EXT_SRC).toMatch(/terminalManager\?\.closeAllTerminals\(\)/);
    expect(EXT_SRC).toMatch(/terminalManager\?\.reopenAfterReconnect\(\)/);
  });

  it("reopen is gated on a prior connect (skips the initial activation 'connected')", () => {
    expect(EXT_SRC).toMatch(/hasConnectedToTower/);
  });
});
