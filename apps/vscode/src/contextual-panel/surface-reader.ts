/**
 * Host-side glue that reads live `vscode` surface state and feeds the pure `deriveSurfaceContext`.
 *
 * Kept separate from `surface-context.ts` so that pure core stays `vscode`-free and unit-testable;
 * this module (which touches `vscode` and the diff-inject registry) is exercised via the provider
 * integration test.
 */

import * as vscode from 'vscode';
import { getDiffInjectEntry } from '../diff-inject-codelens.js';
import { deriveSurfaceContext, type FocusedSurface, type TabInfo } from './surface-context.js';
import type { SurfaceContext } from './types.js';

/** Classify the active tab's (untyped) input into a plain `TabInfo`. */
export function classifyTab(input: unknown): TabInfo {
  if (input instanceof vscode.TabInputText) {
    return { kind: 'text', uriPath: input.uri.path, uriFsPath: input.uri.fsPath };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { kind: 'diff', modifiedFsPath: input.modified.fsPath };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { kind: 'custom', uriPath: input.uri.path, uriFsPath: input.uri.fsPath, viewType: input.viewType };
  }
  if (input === undefined || input === null) {
    return { kind: 'none' };
  }
  return { kind: 'other' };
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

  read(): SurfaceContext {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    return deriveSurfaceContext({
      tab: classifyTab(activeTab?.input),
      activeEditorFsPath: vscode.window.activeTextEditor?.document.uri.fsPath,
      focused: this.focused,
      activeTerminalBuilderId: this.getActiveBuilderId() ?? undefined,
      lookupDiffBuilderId: (fsPath) => getDiffInjectEntry(fsPath)?.builderId,
    });
  }
}
