/**
 * Host-side glue that reads live `vscode` surface state and feeds the pure `deriveSurfaceContext`.
 *
 * Kept separate from `surface-context.ts` so that pure core stays `vscode`-free and unit-testable;
 * this module (which touches `vscode` and the diff-inject registry) is exercised via the provider
 * integration test.
 */

import * as vscode from 'vscode';
import { getDiffInjectEntry } from '../diff-inject-codelens.js';
import {
  deriveSurfaceContext,
  surfaceKey,
  type DeriveInputs,
  type FocusedSurface,
  type TabInfo,
} from './surface-context.js';
import type { SurfaceContext } from './types.js';

/** Classify the active tab's (untyped) input into a plain `TabInfo`. */
export function classifyTab(input: unknown): TabInfo {
  if (input instanceof vscode.TabInputText) {
    return { kind: 'text', uriPath: input.uri.path, uriFsPath: input.uri.fsPath };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { kind: 'diff', modifiedPath: input.modified.path, modifiedFsPath: input.modified.fsPath };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { kind: 'custom', uriPath: input.uri.path, uriFsPath: input.uri.fsPath, viewType: input.viewType };
  }
  if (input instanceof vscode.TabInputTerminal) {
    // A terminal moved into the editor area. It carries no resource; classifying it (rather than
    // letting it fall through to `other`) lets the provider recognise that activating it is terminal
    // focus, not editor focus.
    return { kind: 'terminal' };
  }
  if (input === undefined || input === null) {
    return { kind: 'none' };
  }
  return { kind: 'other' };
}

/** The raw resource of a `TabInfo` — used to detect a genuine active-tab *activation*. Includes kind
 *  + viewType so the same file's raw editor and its codev.markdownPreview count as distinct tabs. */
function tabResource(tab: TabInfo): string {
  if (tab.kind === 'diff') {
    return `diff:${tab.modifiedFsPath ?? ''}`;
  }
  if (tab.kind === 'text' || tab.kind === 'custom') {
    return `${tab.kind}:${tab.viewType ?? ''}:${tab.uriFsPath ?? ''}`;
  }
  return tab.kind;
}

/** The active surface, plus a raw key that identifies it (for transition detection). */
export interface SurfaceRead {
  context: SurfaceContext;
  key: string;
}

/** Reads live `vscode` surface state and tracks the last-focused surface (editor vs terminal). */
export class SurfaceContextReader {
  private focused: FocusedSurface = 'editor';

  constructor(private readonly getActiveBuilderId: () => string | null) {}

  noteEditorFocused(): void {
    this.focused = 'editor';
  }

  noteTerminalFocused(): void {
    this.focused = 'terminal';
  }

  /** The active tab's resource — the provider compares this to gate focus on real activation. */
  activeTabResource(): string {
    return tabResource(classifyTab(vscode.window.tabGroups.activeTabGroup?.activeTab?.input));
  }

  /** Whether the active tab is a terminal living in the editor area. Activating such a tab is terminal
   *  focus (tracked by `onDidChangeActiveTerminal`), so the provider must not read it as editor focus. */
  activeTabIsTerminal(): boolean {
    return classifyTab(vscode.window.tabGroups.activeTabGroup?.activeTab?.input).kind === 'terminal';
  }

  /**
   * Whether focus most likely just moved to a builder terminal. VS Code fires no terminal-focus event
   * when re-entering the already-active terminal, but it does fire `onDidChangeActiveTextEditor(undefined)`
   * as focus leaves the editor. So when the active editor becomes undefined, a builder terminal is the
   * active terminal, and the active tab is not a custom editor (which would itself hold focus — the
   * markdownPreview → Document Review case), the terminal is the new focus. (Best-effort: focus moving
   * to another non-editor UI while a builder terminal is active is a rare false positive that self-heals
   * on the next editor interaction.)
   */
  terminalFocusLikely(): boolean {
    if (this.getActiveBuilderId() === null) {
      return false;
    }
    return classifyTab(vscode.window.tabGroups.activeTabGroup?.activeTab?.input).kind !== 'custom';
  }

  read(): SurfaceRead {
    const inputs = this.buildInputs();
    return { context: deriveSurfaceContext(inputs), key: surfaceKey(inputs) };
  }

  private buildInputs(): DeriveInputs {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return {
      tab: classifyTab(vscode.window.tabGroups.activeTabGroup?.activeTab?.input),
      activeEditorFsPath: activeUri?.fsPath,
      activeEditorPath: activeUri?.path,
      focused: this.focused,
      activeTerminalBuilderId: this.getActiveBuilderId() ?? undefined,
      lookupDiffBuilderId: (fsPath) => getDiffInjectEntry(fsPath)?.builderId,
    };
  }
}
