/**
 * The zoom cursor — pure navigation state for the encoder navigators.
 *
 * The plugin browses Tower top-down: workspaces → builders (of the selected
 * workspace) → files (of the selected builder's diff). The cursor holds only the
 * current level + an index per level; the actual lists come from overview data,
 * and mapping an index to a workspace path / builder id / file lives in the
 * action layer. Hunk navigation is a separate encoder (diff-*-hunk verbs), not a
 * zoom level.
 *
 * All functions are pure (state in → state out) so the state machine is testable
 * without the SDK. Indices are clamped to the live counts; rotating at a level
 * resets the deeper indices (a different workspace has different builders).
 */

export const LEVELS = ['workspaces', 'builders', 'files'] as const;
export type Level = (typeof LEVELS)[number];

export interface CursorState {
  level: Level;
  workspace: number;
  builder: number;
  file: number;
}

/** Live item counts at each level, used to clamp indices. */
export interface LevelCounts {
  workspaces: number;
  builders: number;
  files: number;
}

export function initialCursor(): CursorState {
  return { level: 'workspaces', workspace: 0, builder: 0, file: 0 };
}

function clamp(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/**
 * Move the index of the current level by `delta`, clamped to that level's count.
 * Changing the selection at a level resets the deeper indices to 0, since the
 * deeper lists belong to the newly-selected parent.
 */
export function rotate(state: CursorState, delta: number, counts: LevelCounts): CursorState {
  switch (state.level) {
    case 'workspaces': {
      const workspace = clamp(state.workspace + delta, counts.workspaces);
      if (workspace === state.workspace) return state;
      return { ...state, workspace, builder: 0, file: 0 };
    }
    case 'builders': {
      const builder = clamp(state.builder + delta, counts.builders);
      if (builder === state.builder) return state;
      return { ...state, builder, file: 0 };
    }
    case 'files': {
      const file = clamp(state.file + delta, counts.files);
      return { ...state, file };
    }
  }
}

/** Descend one level (workspaces → builders → files); files is the deepest. */
export function descend(state: CursorState): CursorState {
  switch (state.level) {
    case 'workspaces':
      return { ...state, level: 'builders', builder: 0, file: 0 };
    case 'builders':
      return { ...state, level: 'files', file: 0 };
    case 'files':
      return state;
  }
}

/** Ascend one level (files → builders → workspaces); workspaces is the top. */
export function ascend(state: CursorState): CursorState {
  switch (state.level) {
    case 'files':
      return { ...state, level: 'builders' };
    case 'builders':
      return { ...state, level: 'workspaces' };
    case 'workspaces':
      return state;
  }
}
