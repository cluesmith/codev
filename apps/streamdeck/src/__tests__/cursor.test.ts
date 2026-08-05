import { describe, it, expect } from 'vitest';
import { initialCursor, rotate, descend, ascend, type LevelCounts } from '../nav/cursor.js';

const counts: LevelCounts = { workspaces: 3, builders: 4, files: 2 };

describe('zoom cursor', () => {
  it('starts at the workspaces level, all indices zero', () => {
    expect(initialCursor()).toEqual({ level: 'workspaces', workspace: 0, builder: 0, file: 0 });
  });

  it('rotates within the current level, clamped to its count', () => {
    let s = initialCursor();
    s = rotate(s, 1, counts);
    expect(s.workspace).toBe(1);
    s = rotate(s, 10, counts); // clamp to workspaces-1
    expect(s.workspace).toBe(2);
    s = rotate(s, -10, counts); // clamp to 0
    expect(s.workspace).toBe(0);
  });

  it('resets deeper indices when the workspace selection changes', () => {
    let s = { level: 'workspaces', workspace: 0, builder: 3, file: 1 } as const;
    const next = rotate(s, 1, counts);
    expect(next).toMatchObject({ workspace: 1, builder: 0, file: 0 });
  });

  it('resets the file index when the builder selection changes', () => {
    const s = { level: 'builders', workspace: 1, builder: 0, file: 1 } as const;
    const next = rotate(s, 1, counts);
    expect(next).toMatchObject({ builder: 1, file: 0 });
  });

  it('does not reset deeper indices when rotation is a no-op (already clamped)', () => {
    const s = { level: 'workspaces', workspace: 2, builder: 3, file: 1 } as const;
    const next = rotate(s, 5, counts); // stays at 2
    expect(next).toBe(s); // unchanged reference → no deeper reset
  });

  it('descends workspaces → builders → files and stops at files', () => {
    let s = initialCursor();
    s = descend(s);
    expect(s.level).toBe('builders');
    s = descend(s);
    expect(s.level).toBe('files');
    s = descend(s);
    expect(s.level).toBe('files'); // deepest
  });

  it('ascends files → builders → workspaces and stops at workspaces', () => {
    let s = { level: 'files', workspace: 1, builder: 2, file: 1 } as const;
    let r = ascend(s);
    expect(r.level).toBe('builders');
    r = ascend(r);
    expect(r.level).toBe('workspaces');
    r = ascend(r);
    expect(r.level).toBe('workspaces'); // top
  });

  it('preserves indices across ascend (returning shows where you were)', () => {
    const s = { level: 'files', workspace: 1, builder: 2, file: 1 } as const;
    expect(ascend(s)).toEqual({ level: 'builders', workspace: 1, builder: 2, file: 1 });
  });

  it('clamps to 0 when a level is empty', () => {
    const empty: LevelCounts = { workspaces: 0, builders: 0, files: 0 };
    const s = { level: 'builders', workspace: 0, builder: 0, file: 0 } as const;
    expect(rotate(s, 1, empty).builder).toBe(0);
  });
});
