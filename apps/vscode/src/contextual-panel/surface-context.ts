/**
 * PURE core for deriving a `SurfaceContext` from the active VS Code surface.
 *
 * No `vscode` / `node:` imports — takes plain inputs, so it is exhaustively unit-testable without a
 * host (the live-state reader that feeds it lives in `surface-reader.ts`). It returns INDEPENDENT
 * predicate signals (never pre-collapsing to one mode) so the resolver applies the locked precedence
 * and overlaps stay representable.
 */

import type { SurfaceContext } from './types.js';

const ARTIFACT_PATH = /\/codev\/(plans|specs|reviews)\//;
const WORKTREE_SEGMENT = /(?:^|\/)\.builders\/([^/]+)\//;

/** Which VS Code surface currently has focus. Editors do not clear `activeTerminal`, so this is
 *  tracked from focus events rather than read from a single API. */
export type FocusedSurface = 'editor' | 'terminal';

/** A plain, host-free description of the active tab (produced by `classifyTab`). */
export interface TabInfo {
  /** `terminal` = a terminal living in the editor area (`TabInputTerminal`); it is a terminal
   *  surface, never an editor one, so activating it must not demote a focused builder terminal. */
  kind: 'text' | 'diff' | 'custom' | 'terminal' | 'other' | 'none';
  /** Posix path (for artifact matching) — `text` / `custom` tabs. */
  uriPath?: string;
  /** Fs path (the resourcePath value) — `text` / `custom` tabs. */
  uriFsPath?: string;
  /** The modified (right/worktree) side — `diff` tabs. Posix path for matching. */
  modifiedPath?: string;
  /** The modified (right/worktree) side fs path — `diff` tabs. */
  modifiedFsPath?: string;
  /** Custom-editor view type — `custom` tabs. */
  viewType?: string;
}

export interface DeriveInputs {
  tab: TabInfo;
  /** `window.activeTextEditor?.document.uri.fsPath`. */
  activeEditorFsPath?: string;
  /** `window.activeTextEditor?.document.uri.path` (posix) — for the multi-diff artifact match. */
  activeEditorPath?: string;
  focused: FocusedSurface;
  /** `getActiveBuilderId()` (null coerced to undefined). */
  activeTerminalBuilderId?: string;
  /** Registry lookup: `getDiffInjectEntry(fsPath)?.builderId`. */
  lookupDiffBuilderId(fsPath: string): string | undefined;
}

interface ArtifactSignal {
  resourcePath: string;
  builderId?: string;
}

/** Pure derivation: collect every predicate the surface satisfies (the resolver picks one). */
export function deriveSurfaceContext(inputs: DeriveInputs): SurfaceContext {
  const context: SurfaceContext = {};

  if (inputs.focused === 'terminal' && inputs.activeTerminalBuilderId !== undefined) {
    context.builderTerminal = { builderId: inputs.activeTerminalBuilderId };
  }

  const diffBuilderId = deriveDiffBuilderId(inputs);
  if (diffBuilderId !== undefined) {
    context.builderDiff = { builderId: diffBuilderId };
  }

  // The artifact predicate is INDEPENDENT of the diff predicate: a spec/plan/review viewed inside a
  // diff is both a diff (Code Review wins) AND an artifact (so Document Review stays navigable). The
  // resolver applies precedence; the adapter reports every predicate that holds.
  const artifact = deriveArtifact(inputs);
  if (artifact !== undefined) {
    context.artifact = artifact;
  }

  return context;
}

function deriveDiffBuilderId(inputs: DeriveInputs): string | undefined {
  const { tab } = inputs;
  if (tab.kind === 'diff' && tab.modifiedFsPath !== undefined) {
    return inputs.lookupDiffBuilderId(tab.modifiedFsPath);
  }
  // The multi-file diff (`vscode.changes`) has no typed tab input (`unknown` in the tab model),
  // so its focused sub-file surfaces as the active text editor. Treat that as a diff ONLY when the
  // active tab is not a plain text/custom editor — otherwise a builder file opened as a NORMAL tab
  // (also present in the registry) would be misread as a diff, which the spec forbids.
  if (!tabIsPlainEditor(tab) && inputs.activeEditorFsPath !== undefined) {
    return inputs.lookupDiffBuilderId(inputs.activeEditorFsPath);
  }
  return undefined;
}

function deriveArtifact(inputs: DeriveInputs): ArtifactSignal | undefined {
  const { tab } = inputs;
  if (tab.kind === 'text') {
    return artifactFromPath(tab.uriPath, tab.uriFsPath);
  }
  if (tab.kind === 'custom' && tab.viewType === 'codev.markdownPreview') {
    return artifactFromPath(tab.uriPath, tab.uriFsPath);
  }
  if (tab.kind === 'diff') {
    return artifactFromPath(tab.modifiedPath, tab.modifiedFsPath);
  }
  // Multi-file diff: the focused sub-file (active editor) may itself be an artifact.
  if (!tabIsPlainEditor(tab)) {
    return artifactFromPath(inputs.activeEditorPath, inputs.activeEditorFsPath);
  }
  return undefined;
}

function artifactFromPath(posixPath: string | undefined, fsPath: string | undefined): ArtifactSignal | undefined {
  if (posixPath === undefined || fsPath === undefined) {
    return undefined;
  }
  if (!ARTIFACT_PATH.test(posixPath)) {
    return undefined;
  }
  const artifact: ArtifactSignal = { resourcePath: fsPath };
  const builderId = builderIdFromPath(posixPath);
  if (builderId !== undefined) {
    artifact.builderId = builderId;
  }
  return artifact;
}

function tabIsPlainEditor(tab: TabInfo): boolean {
  return tab.kind === 'text' || tab.kind === 'custom';
}

function builderIdFromPath(path: string): string | undefined {
  const match = WORKTREE_SEGMENT.exec(path);
  if (match !== null) {
    return match[1];
  }
  return undefined;
}

/**
 * A key identifying the raw active surface (not the resolved mode): the focused terminal's builder,
 * or the active tab's resource, or the multi-diff's focused file. Unlike the resolved descriptor,
 * this distinguishes two *different* ordinary files that both resolve to Attention — which is what a
 * transition (which the provider re-posts on) must detect. It is stable across
 * cursor moves within one surface.
 */
export function surfaceKey(inputs: DeriveInputs): string {
  if (inputs.focused === 'terminal' && inputs.activeTerminalBuilderId !== undefined) {
    return `terminal:${inputs.activeTerminalBuilderId}`;
  }
  const { tab } = inputs;
  if (tab.kind === 'diff') {
    return `diff:${tab.modifiedFsPath ?? ''}`;
  }
  if (tab.kind === 'text' || tab.kind === 'custom') {
    // Include kind + viewType so the same file's raw editor and its codev.markdownPreview are
    // distinct surfaces — switching between them is a real transition (focus + re-post).
    return `tab:${tab.kind}:${tab.viewType ?? ''}:${tab.uriFsPath ?? ''}`;
  }
  if (inputs.activeEditorFsPath !== undefined) {
    return `editor:${inputs.activeEditorFsPath}`;
  }
  return 'none';
}
