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

describe('PIR #982 — actionable recovery for a missing terminal', () => {
  // Behavioral coverage of the retry/resolve itself lives in
  // terminal-resolve.test.ts (the vscode-free helper). These source-level
  // guards cover the vscode-side wiring that the heavy TerminalManager harness
  // makes impractical to exercise behaviorally.

  it('delegates the resolve to the bounded-retry helper', () => {
    expect(TM_SRC).toMatch(/import \{[^}]*\bresolveBuilderTerminal\b[^}]*\} from '\.\/terminal-resolve\.js'/);
    expect(TM_SRC).toMatch(/await resolveBuilderTerminal\(/);
  });

  it('no longer dead-ends on the bare "No active terminal" warning', () => {
    // The old unactionable toast must be gone — replaced by the recovery prompt.
    expect(TM_SRC).not.toMatch(/No active terminal for/);
  });

  const recoveryBody = TM_SRC.split('promptNoTerminalRecovery')[2] ?? '';

  it('routes a missing terminal to the recovery prompt', () => {
    expect(TM_SRC).toMatch(/outcome\.kind === 'missing'/);
    expect(TM_SRC).toMatch(/this\.promptNoTerminalRecovery\(/);
  });

  it('offers Retry and Recover Builders actions', () => {
    expect(recoveryBody).toMatch(/showWarningMessage\(/);
    expect(recoveryBody).toMatch(/const RETRY = 'Retry'/);
    expect(recoveryBody).toMatch(/const RECOVER = 'Recover Builders'/);
  });

  it('Retry re-attempts the open; Recover runs `afx workspace recover` at the main checkout root', () => {
    expect(recoveryBody).toMatch(/choice === RETRY[\s\S]*openBuilderByRoleOrId\(roleOrId, focus\)/);
    // cwd must be the main checkout root, not the raw workspace path — a
    // worktree-rooted window would otherwise run afx in the wrong dir (#982).
    expect(recoveryBody).toMatch(/cwd: mainCheckoutRoot\(workspacePath\)/);
    expect(recoveryBody).toMatch(/sendText\('afx workspace recover'\)/);
  });
});

describe('#804 — builder/shell terminals do not force-create a second editor group', () => {
  // The else-branch of openTerminal's location resolution (builder + shell
  // types) must attach to ViewColumn.Two ONLY when a second tab group already
  // exists, else fall back to ViewColumn.One — otherwise VS Code spawns a new
  // group on demand, reshaping a single-column user's layout. Source-level per
  // this file's harness rationale (constructing TerminalManager needs heavy
  // vscode mocking).
  const elseBranch =
    TM_SRC.split("type === 'architect'")[1]?.split('createTerminal')[0] ?? '';

  it('gates the second-group target on existing tab groups', () => {
    expect(elseBranch).toMatch(/vscode\.window\.tabGroups\.all\.length >= 2/);
  });

  it('uses ViewColumn.Two when a second group exists, ViewColumn.One otherwise', () => {
    expect(elseBranch).toMatch(/location = \{ viewColumn: vscode\.ViewColumn\.Two \}/);
    expect(elseBranch).toMatch(/location = \{ viewColumn: vscode\.ViewColumn\.One \}/);
  });

  it('no longer unconditionally targets ViewColumn.Two for builder/shell terminals', () => {
    // Regression guard: the pre-#804 code set `location = { viewColumn:
    // vscode.ViewColumn.Two }` with no surrounding group-count check. The fix
    // must keep that assignment behind the `hasSecondGroup` conditional.
    expect(elseBranch).toMatch(/const hasSecondGroup = vscode\.window\.tabGroups\.all\.length >= 2/);
    expect(elseBranch).toMatch(/if \(hasSecondGroup\)/);
  });
});

describe('#921 — dev surface refresh on manual terminal close', () => {
  // Regression guard: a dev terminal closed via the generic onDidCloseTerminal
  // path (tab ✕ / process exit) must clear devStartedAt AND re-fire
  // onDidChangeDevTerminals, or the chip / Codev Dev tab / devRunning
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

describe('PIR #1052 — repaint all terminals on window refocus', () => {
  // Source-level guard (heavy TerminalManager harness avoided, per this file's
  // rationale): repaintAllOnRefocus must fan a forceRepaint out to every managed
  // pty so a window-refocus SIGWINCH recovers each corrupted pane. Behavioral
  // coverage of forceRepaint itself lives in terminal-adapter.test.ts; the
  // window-state rising-edge wiring is exercised at the dev-approval gate.
  const repaintBody = TM_SRC.split('repaintAllOnRefocus()')[1]?.split('buildWsUrl')[0] ?? '';

  it('iterates every managed terminal', () => {
    expect(TM_SRC).toMatch(/repaintAllOnRefocus\(\): void/);
    expect(repaintBody).toMatch(/for \(const entry of this\.terminals\.values\(\)\)/);
  });

  it('calls forceRepaint on each managed pty', () => {
    expect(repaintBody).toMatch(/entry\.pty\.forceRepaint\(\)/);
  });
});
