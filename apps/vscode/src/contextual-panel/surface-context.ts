/**
 * PURE core for deriving a `SurfaceContext` from the active VS Code surface.
 *
 * No `vscode` / `node:` imports — takes plain inputs, so it is exhaustively unit-testable without a
 * host (the live-state reader that feeds it lives in `surface-reader.ts`). It returns INDEPENDENT
 * predicate signals (never pre-collapsing to one mode) so the resolver applies the locked precedence
 * and overlaps stay representable.
 */

import type { ModeDescriptor, SurfaceContext } from './types.js';

const ARTIFACT_PATH = /\/codev\/(plans|specs|reviews)\//;
const WORKTREE_SEGMENT = /(?:^|\/)\.builders\/([^/]+)\//;

/** Which VS Code surface currently has focus. Editors do not clear `activeTerminal`, so this is
 *  tracked from focus events rather than read from a single API. */
export type FocusedSurface = 'editor' | 'terminal';

/** A plain, host-free description of the active tab (produced by `classifyTab`). */
export interface TabInfo {
  kind: 'text' | 'diff' | 'custom' | 'other' | 'none';
  /** Posix path (for artifact matching) — `text` / `custom` tabs. */
  uriPath?: string;
  /** Fs path (the resourcePath value) — `text` / `custom` tabs. */
  uriFsPath?: string;
  /** The modified (right/worktree) side fs path — `diff` tabs. */
  modifiedFsPath?: string;
  /** Custom-editor view type — `custom` tabs. */
  viewType?: string;
}

export interface DeriveInputs {
  tab: TabInfo;
  /** `window.activeTextEditor?.document.uri.fsPath`. */
  activeEditorFsPath?: string;
  focused: FocusedSurface;
  /** `getActiveBuilderId()` (null coerced to undefined). */
  activeTerminalBuilderId?: string;
  /** Registry lookup: `getDiffInjectEntry(fsPath)?.builderId`. */
  lookupDiffBuilderId(fsPath: string): string | undefined;
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

  const artifact = deriveArtifact(inputs.tab);
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
  const tabIsPlainEditor = tab.kind === 'text' || tab.kind === 'custom';
  if (!tabIsPlainEditor && inputs.activeEditorFsPath !== undefined) {
    return inputs.lookupDiffBuilderId(inputs.activeEditorFsPath);
  }
  return undefined;
}

function deriveArtifact(tab: TabInfo): { resourcePath: string; builderId?: string } | undefined {
  let uriPath: string | undefined;
  let uriFsPath: string | undefined;
  if (tab.kind === 'text') {
    uriPath = tab.uriPath;
    uriFsPath = tab.uriFsPath;
  }
  if (tab.kind === 'custom' && tab.viewType === 'codev.markdownPreview') {
    uriPath = tab.uriPath;
    uriFsPath = tab.uriFsPath;
  }
  if (uriPath === undefined || uriFsPath === undefined) {
    return undefined;
  }
  if (!ARTIFACT_PATH.test(uriPath)) {
    return undefined;
  }
  const artifact: { resourcePath: string; builderId?: string } = { resourcePath: uriFsPath };
  const builderId = builderIdFromPath(uriPath);
  if (builderId !== undefined) {
    artifact.builderId = builderId;
  }
  return artifact;
}

function builderIdFromPath(path: string): string | undefined {
  const match = WORKTREE_SEGMENT.exec(path);
  if (match !== null) {
    return match[1];
  }
  return undefined;
}

/**
 * Stable identity of a resolved surface: `(kind, builderId, resourcePath)`. A change in builderId
 * or resourcePath is a transition even when the kind is unchanged (builder A terminal -> builder B
 * terminal), which is what keeps a transient selection from crossing builders (#1497 class).
 */
export function surfaceIdentity(descriptor: ModeDescriptor): string {
  return [
    descriptor.kind,
    descriptor.context.builderId ?? '',
    descriptor.context.resourcePath ?? '',
  ].join('|');
}
