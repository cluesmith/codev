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
  if (input === undefined || input === null) {
    return { kind: 'none' };
  }
  return { kind: 'other' };
}

/** The raw resource of a `TabInfo` — used to detect a genuine active-tab *activation*. */
function tabResource(tab: TabInfo): string {
  if (tab.kind === 'diff') {
    return tab.modifiedFsPath ?? 'diff';
  }
  if (tab.kind === 'text' || tab.kind === 'custom') {
    return tab.uriFsPath ?? 'tab';
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
