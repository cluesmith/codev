/**
 * Spec 786 Phase 6: unit tests for the architect-related command
 * registrations in `extension.ts`.
 *
 * These are source-level sentinel tests for the same reason the workspace
 * and terminal-manager tests are: spinning up the full extension activation
 * path requires mocking the entire `vscode` module. The behavioral guarantees
 * end-to-end are exercised by the verify phase. These tests guard against
 * specific regressions:
 *
 *   1. `codev.openArchitectTerminal` accepts an optional architect name
 *      argument (the pre-786 command took none).
 *   2. The command resolves from `state.architects` (Phase 5 collection)
 *      with a fallback to the scalar `state.architect` for older Tower.
 *   3. `codev.removeArchitect` is registered, refuses 'main', shows a modal
 *      confirmation, and calls `workspaceProvider.refresh()` on success.
 *   4. `codev.openArchitectTerminal` returns the resolved architect name and
 *      `codev.referenceIssueInArchitect` passes it to `injectArchitectText`,
 *      so the Backlog button honors the multi-architect QuickPick selection
 *      (Issue 1139) instead of always targeting main.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_SRC = readFileSync(
  resolve(__dirname, '../extension.ts'),
  'utf8',
);

describe('Spec 786 Phase 6 — extension.ts architect commands', () => {
  it('codev.openArchitectTerminal accepts an optional architectName arg', () => {
    expect(EXT_SRC).toMatch(
      /(?:registerCommand|reg)\(['"]codev\.openArchitectTerminal['"],\s*async\s*\(architectName\?: string\)/
    );
  });

  it('resolves from state.architects (Phase 5) with scalar fallback', () => {
    // Backward-compat with older Tower versions that haven't shipped the
    // Phase 5 architects[] collection: fall through to the scalar.
    expect(EXT_SRC).toMatch(
      /const architects = state\?\.architects \?\? \(state\?\.architect \? \[state\.architect\] : \[\]\)/
    );
  });

  it("targetName defaults to 'main' for a no-arg, single-architect workspace", () => {
    // Issue 841 Gap 2 restructured this: no-arg invocations only default to
    // 'main' when there's at most one architect; with >1 a picker runs. The
    // single-architect branch still preserves today's open-main behaviour.
    const openBlock = EXT_SRC.split("reg('codev.openArchitectTerminal'")[1] ?? '';
    expect(openBlock).toMatch(/let targetName = architectName/);
    expect(openBlock).toMatch(/targetName = ['"]main['"]/);
  });

  it('codev.openArchitectTerminal shows a picker when no-arg and >1 architect', () => {
    // Gap 2: keyboard/palette invocation with multiple architects prompts.
    const openBlock = EXT_SRC.split("reg('codev.openArchitectTerminal'")[1] ?? '';
    expect(openBlock).toMatch(/targetName === undefined/);
    expect(openBlock).toMatch(/architects\.length > 1/);
    expect(openBlock).toMatch(/showQuickPick/);
    expect(openBlock).toMatch(/sortArchitectsForPicker/);
  });

  it('codev.addArchitect is registered and validates with the shared rule', () => {
    // Issue 1104: the command is now CONVERSATIONAL — it still validates the
    // name via the codev-sdk validator (parity with the CLI) but no longer
    // creates the architect directly.
    expect(EXT_SRC).toMatch(/(?:registerCommand|regCli)\(['"]codev\.addArchitect['"]/);
    const addBlock = EXT_SRC.split("regCli('codev.addArchitect'")[1] ?? '';
    expect(addBlock).toMatch(/showInputBox/);
    expect(addBlock).toMatch(/validateInput:.*validateArchitectName/);
  });

  it('codev.addArchitect routes the request to main instead of creating directly (Issue 1104)', () => {
    // The handler resolves main from the live roster and dispatches the request
    // via sendMessage to the `architect:main` recipient — NOT a direct
    // client.addArchitect / REST creation from the sidebar.
    const addBlock = EXT_SRC.split("regCli('codev.addArchitect'")[1] ?? '';
    expect(addBlock).toMatch(/resolveMainArchitect\(/);
    expect(addBlock).toMatch(/client\.sendMessage\(/);
    expect(addBlock).toMatch(/ADD_ARCHITECT_RECIPIENT|architect:main/);
    expect(addBlock).toMatch(/addArchitectRequestMessage\(/);
    // It must NOT fall back to direct creation from the sidebar `+`.
    const beforeRemove = addBlock.split("regCli('codev.removeArchitect'")[0] ?? '';
    expect(beforeRemove).not.toMatch(/client\.addArchitect\(/);
  });

  it('codev.addArchitect refuses when no main architect is active, with a modal CLI fallback', () => {
    // Main is the workspace orchestrator; if no main session is running there is
    // nothing to ask, so the action refuses (modal) rather than silently
    // creating an unbriefed architect. The modal points at the CLI fallback.
    const addBlock = (EXT_SRC.split("regCli('codev.addArchitect'")[1] ?? '')
      .split("regCli('codev.removeArchitect'")[0] ?? '';
    expect(addBlock).toMatch(/if \(!main\)/);
    expect(addBlock).toMatch(/modal: true/);
    expect(addBlock).toMatch(/add-architect/);
  });

  it('codev.addArchitect imports its helpers from the pure module (single source)', () => {
    expect(EXT_SRC).toMatch(
      /import \{ validateArchitectName \} from ['"]@cluesmith\/codev-sdk\/architect-name['"]/
    );
    expect(EXT_SRC).toMatch(
      /import \{ resolveMainArchitect, addArchitectRequestMessage, ADD_ARCHITECT_RECIPIENT \} from ['"]\.\/commands\/add-architect\.js['"]/
    );
  });

  it("codev.removeArchitect resolves the raw name from item.id, not the (uppercased) label", () => {
    // Issue 841 Gap 3: with UPPERCASE labels, arg.label != the canonical name,
    // so removeArchitect MUST read the raw name from item.id
    // (`workspace-architect-<name>`). Reading the label would DELETE a name
    // Tower doesn't know (e.g. 'WEB' vs 'web').
    const removeBlock = EXT_SRC.split("regCli('codev.removeArchitect'")[1] ?? '';
    expect(removeBlock).toMatch(/workspace-architect-/);
    expect(removeBlock).toMatch(/arg\.id/);
  });

  it('codev.removeArchitect is registered', () => {
    expect(EXT_SRC).toMatch(/(?:registerCommand|regCli)\(['"]codev\.removeArchitect['"]/);
  });

  it("codev.removeArchitect refuses 'main' before calling Tower", () => {
    // The server enforces this too (Phase 4 OQ-B), but the client gate gives
    // a faster error and keeps the modal from appearing for an impossible
    // operation.
    const removeBlock = EXT_SRC.split("regCli('codev.removeArchitect'")[1] ?? '';
    expect(removeBlock).toMatch(/if \(name === ['"]main['"]\)/);
    expect(removeBlock).toMatch(/Cannot remove.*main/i);
  });

  it('codev.removeArchitect uses a modal confirmation', () => {
    const removeBlock = EXT_SRC.split("regCli('codev.removeArchitect'")[1] ?? '';
    expect(removeBlock).toMatch(/showInformationMessage/);
    expect(removeBlock).toMatch(/modal: true/);
  });

  it('codev.removeArchitect refreshes the workspace tree on success', () => {
    // Spec 786 Phase 6 (post iter-1 CMAP): without this call, the removed
    // sibling stays visible in the sidebar until the next unrelated state
    // event.
    const removeBlock = EXT_SRC.split("regCli('codev.removeArchitect'")[1] ?? '';
    expect(removeBlock).toMatch(/workspaceProvider\.refresh\(\)/);
  });

  it('codev.openArchitectTerminal returns the resolved architect name on success', () => {
    // Issue 1139: callers (the reference-injection commands) depend on the
    // command returning the name that was actually opened, whether it came
    // from an explicit arg, the multi-architect QuickPick, or the
    // single-architect 'main' default.
    const openBlock = EXT_SRC.split("reg('codev.openArchitectTerminal'")[1] ?? '';
    expect(openBlock).toMatch(/Promise<string \| undefined>/);
    expect(openBlock).toMatch(/return targetName/);
  });

  it('codev.referenceIssueInArchitect injects into the architect resolved by the open command', () => {
    // Issue 1139: the Backlog inline button previously called
    // injectArchitectText with no name, so the QuickPick selection made in
    // codev.openArchitectTerminal was ignored and the text always landed in
    // architect:main. The command now captures the open command's resolved
    // name and passes it through to the injection.
    //
    // Post-#808 the injection text comes from buildArchitectReferenceInjection.
    const refBlock = EXT_SRC.split("regCli('codev.referenceIssueInArchitect'")[1] ?? '';
    expect(refBlock).toMatch(
      /const resolvedName = await vscode\.commands\.executeCommand<string \| undefined>\('codev\.openArchitectTerminal'\)/
    );
    expect(refBlock).toMatch(/injectArchitectText\(buildArchitectReferenceInjection\([^)]*\), resolvedName\)/);
  });

  it('codev.referenceIssueInArchitect skips injection when the open is cancelled or fails', () => {
    // A dismissed picker (or a failed open) resolves to undefined; the
    // command must not fall back to injecting into main.
    const refBlock = EXT_SRC.split("regCli('codev.referenceIssueInArchitect'")[1] ?? '';
    expect(refBlock).toMatch(/if \(!resolvedName\) \{ return; \}/);
  });

  it('workspaceProvider is held in a const so commands can call .refresh()', () => {
    expect(EXT_SRC).toMatch(/const workspaceProvider = new WorkspaceProvider/);
    expect(EXT_SRC).toMatch(/registerTreeDataProvider\(['"]codev\.workspace['"], workspaceProvider\)/);
  });
});
