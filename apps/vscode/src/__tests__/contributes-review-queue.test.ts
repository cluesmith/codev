/**
 * Manifest invariants for the review-comment queue surface (#1037):
 *
 * - `codev.diffCodelensMode` is declared with default `"forward"` (existing
 *   #789 users see no change; comment mode is the per-workspace opt-in).
 * - The editor context menu offers BOTH the comment and the forward action on
 *   builder-diff files with no mode condition — the non-default flow must
 *   always be one right-click away, whatever the codelens shows.
 * - The `editor/title` toggle buttons swap on the mode context key and are
 *   mutually exclusive (exactly one visible per mode).
 * - The builder-review comment menus are scoped to the
 *   `codev-builder-review` controller so they never leak onto the
 *   plan-review controller's threads (and vice versa).
 * - The #789 keybinding (Ctrl/Cmd+K B) is untouched by the mode.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);

interface MenuEntry { command: string; when?: string; group?: string }

const menus: Record<string, MenuEntry[]> = PKG.contributes.menus;

function entry(section: string, command: string): MenuEntry | undefined {
  return (menus[section] ?? []).find(m => m.command === command);
}

describe('codev.diffCodelensMode setting', () => {
  it('is declared with enum comment|forward and default forward (preserves #789 for existing users)', () => {
    const prop = PKG.contributes.configuration.properties['codev.diffCodelensMode'];
    expect(prop).toBeDefined();
    expect(prop.enum).toEqual(['comment', 'forward']);
    expect(prop.default).toBe('forward');
  });
});

describe('editor context menu', () => {
  it('always offers both actions on builder-diff files, independent of mode', () => {
    const comment = entry('editor/context', 'codev.commentSelectionForBuilder');
    const forward = entry('editor/context', 'codev.forwardSelectionToBuilder');
    expect(comment?.when).toBe('codev.activeEditorIsBuilderFile');
    expect(forward?.when).toBe('codev.activeEditorIsBuilderFile');
    for (const e of [comment, forward]) {
      expect(e!.when).not.toContain('diffCodelensMode');
    }
  });
});

describe('editor/title mode toggle', () => {
  it('shows exactly one toggle per mode via mutually exclusive when clauses', () => {
    const toForward = entry('editor/title', 'codev.diffCodelensUseForward');
    const toComment = entry('editor/title', 'codev.diffCodelensUseComment');
    expect(toForward?.when).toBe("codev.activeEditorIsBuilderFile && codev.diffCodelensMode == 'comment'");
    expect(toComment?.when).toBe("codev.activeEditorIsBuilderFile && codev.diffCodelensMode == 'forward'");
  });
});

describe('builder-review comment menus', () => {
  it('scopes every entry to the codev-builder-review controller', () => {
    const sections = [
      'comments/commentThread/context',
      'comments/commentThread/title',
      'comments/comment/title',
      'comments/comment/context',
    ];
    const builderCommands = [
      'codev.submitBuilderComment',
      'codev.cancelBuilderComment',
      'codev.deleteBuilderComment',
      'codev.startEditBuilderComment',
      'codev.saveEditBuilderComment',
      'codev.cancelEditBuilderComment',
    ];
    const found = new Set<string>();
    for (const section of sections) {
      for (const e of menus[section] ?? []) {
        if (builderCommands.includes(e.command)) {
          found.add(e.command);
          expect(e.when, `${section}:${e.command}`).toContain('commentController == codev-builder-review');
        }
      }
    }
    expect([...found].sort()).toEqual([...builderCommands].sort());
  });
});

describe('#789 keybinding is mode-independent', () => {
  it('keeps Ctrl/Cmd+K B on forwardSelectionToBuilder with its original when clause', () => {
    const binding = (PKG.contributes.keybindings as Array<{ command: string; key: string; mac?: string; when?: string }>)
      .find(k => k.command === 'codev.forwardSelectionToBuilder');
    expect(binding?.key).toBe('ctrl+k b');
    expect(binding?.mac).toBe('cmd+k b');
    expect(binding?.when).toBe('codev.activeEditorIsBuilderFile && editorHasSelection');
    expect(binding?.when).not.toContain('diffCodelensMode');
  });
});
