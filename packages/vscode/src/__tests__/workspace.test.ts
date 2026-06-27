/**
 * Spec 786 Phase 6: unit tests for `WorkspaceProvider` tree structure.
 *
 * Like the terminal-manager test, instantiating `WorkspaceProvider` requires
 * a `ConnectionManager`, `TerminalManager`, and `vscode.EventEmitter`. Rather
 * than mock all of vscode for sentinel checks, this file verifies the tree-
 * shape invariants at the source level:
 *
 *   1. The root emits an expandable "Architects" parent (collapsibleState =
 *      Expanded) — not the pre-786 singleton "Open Architect" leaf.
 *   2. `getArchitectChildren` exists and is reached when expanding the
 *      Architects parent.
 *   3. Architect children carry `command.arguments: [name]` so
 *      `codev.openArchitectTerminal` receives the name.
 *   4. Sibling children get `contextValue: 'workspace-architect-sibling'`;
 *      `main` gets `'workspace-architect-main'`. This drives the right-click
 *      remove menu in `package.json`.
 *   5. Fallback to `['main']` when Tower is unreachable preserves baseline UX.
 *
 * Integration behavior (adding a sibling refreshes the tree end-to-end) is
 * exercised by the verify phase.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WS_SRC = readFileSync(
  resolve(__dirname, '../views/workspace.ts'),
  'utf8',
);

describe('Spec 786 Phase 6 — WorkspaceProvider expandable Architects tree', () => {
  it('emits an Architects parent with TreeItemCollapsibleState.Expanded', () => {
    expect(WS_SRC).toMatch(
      /new vscode\.TreeItem\(\s*['"]Architects['"],[\s\S]*?TreeItemCollapsibleState\.Expanded/
    );
  });

  it('uses id "workspace-architects-root" to identify the parent in getChildren', () => {
    expect(WS_SRC).toMatch(/element\?\.id === ['"]workspace-architects-root['"]/);
    expect(WS_SRC).toMatch(/architectsRoot\.id = ['"]workspace-architects-root['"]/);
  });

  it('getArchitectChildren passes the architect name as command.arguments', () => {
    // The command receives the name so it knows which architect to open. The
    // pre-786 singleton command took no args.
    expect(WS_SRC).toMatch(/command: ['"]codev\.openArchitectTerminal['"]/);
    expect(WS_SRC).toMatch(/arguments: \[name\]/);
  });

  it('renders the row label via displayArchitectName (Issue 841 Gap 3 — UPPERCASE)', () => {
    expect(WS_SRC).toMatch(/new vscode\.TreeItem\(displayArchitectName\(name\)\)/);
    expect(WS_SRC).toMatch(/import \{ displayArchitectName \} from ['"]\.\/architect-display\.js['"]/);
  });

  it('carries the raw lowercase name in item.id so removeArchitect can resolve it', () => {
    // The label is uppercased; the canonical name must travel through a
    // channel independent of the label. item.id = `workspace-architect-<name>`.
    expect(WS_SRC).toMatch(/item\.id = `workspace-architect-\$\{name\}`/);
  });

  it('contextValue distinguishes main from siblings', () => {
    // Right-click "Remove Architect" is gated on `viewItem ==
    // workspace-architect-sibling` in package.json. Main MUST get a different
    // contextValue so the menu doesn't surface for it.
    expect(WS_SRC).toMatch(/name === ['"]main['"] \? ['"]workspace-architect-main['"] : ['"]workspace-architect-sibling['"]/);
  });

  it('falls back to ["main"] when Tower is unreachable or workspace has no architects', () => {
    // Baseline UX preservation: a workspace that isn't activated yet still
    // shows a "main" entry in the sidebar, matching the pre-786 single-row
    // behaviour.
    expect(WS_SRC).toMatch(/let names: string\[\] = \['main'\]/);
  });

  it('removes the pre-786 singleton "Open Architect" tree item', () => {
    // Regression guard: the old singleton row had context value
    // `'workspace-architect'` (no `-main` or `-sibling` suffix). Replacing it
    // is the entire point of Phase 6.
    expect(WS_SRC).not.toMatch(/contextValue\s*=\s*['"]workspace-architect['"]/);
  });

  it('exposes refresh() for command handlers to force a tree re-render', () => {
    // Spec 786 Phase 6 (post iter-1 CMAP): commands like
    // codev.removeArchitect call refresh() so the sidebar reflects state
    // changes immediately, without waiting for an unrelated SSE event.
    expect(WS_SRC).toMatch(/refresh\(\):\s*void/);
    expect(WS_SRC).toMatch(/this\.changeEmitter\.fire\(\)/);
  });
});

describe('Spec 823 — WorkspaceProvider subscribes to architects-updated SSE', () => {
  it('SSE subscriber matches the architects-updated envelope type', () => {
    // The subscriber callback uses the SAME `connectionManager.onSSEEvent`
    // subscription that already handles `codev-config-updated`. Phase 4
    // extends the type check to also accept `architects-updated`.
    expect(WS_SRC).toMatch(/envelope\.type === ['"]codev-config-updated['"]/);
    expect(WS_SRC).toMatch(/envelope\.type === ['"]architects-updated['"]/);
  });

  it('both subscriber branches fire changeEmitter (single shared subscriber, no duplicate)', () => {
    // Phase 4 implementation rule: extend the existing subscriber callback
    // with an additional `||` branch — do NOT register a second
    // `connectionManager.onSSEEvent(...)` (which would parse the envelope
    // twice). Confirm the file has exactly ONE `onSSEEvent` call.
    const sseSubscribeCalls = WS_SRC.match(/connectionManager\.onSSEEvent\(/g) ?? [];
    expect(sseSubscribeCalls.length).toBe(1);
  });

  it('subscriber callback parses the envelope JSON safely (catch malformed payloads)', () => {
    // Regression guard for the existing try/catch — must still be present so
    // a malformed envelope from a future event source doesn't crash the
    // tree-data provider.
    expect(WS_SRC).toMatch(/JSON\.parse\(data\)/);
    expect(WS_SRC).toMatch(/} catch[\s\S]*?\/\/ benign/);
  });

  it('subscriber fires changeEmitter on match, does not filter by workspace', () => {
    // Per spec OQ-F + plan iter-2 Codex internal-consistency fix: the
    // SSE-subscriber layer fires unconditionally on a matching envelope
    // type (the WorkspaceProvider instance is workspace-scoped at
    // construction, so per-event workspace filtering would add complexity
    // without benefit). The workspace field stays in the event body for
    // dashboards or other listeners that DO want to filter.
    //
    // Verify the subscriber doesn't contain a workspace comparison around
    // the changeEmitter.fire() call.
    expect(WS_SRC).not.toMatch(/envelope\.workspace\s*===/);
    expect(WS_SRC).not.toMatch(/workspace\.path\s*===\s*envelope/);
  });
});
