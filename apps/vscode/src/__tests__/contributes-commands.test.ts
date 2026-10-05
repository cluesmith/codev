/**
 * Regression: VS Code's Feature Contributions tab lists every declared
 * command regardless of `commandPalette` `when:false`. So palette-hidden
 * commands surface there too, and identical titles render as duplicate
 * lines on the extension's detail page (issue #838).
 *
 * Additional invariant: a "(internal)" marker may only appear on commands
 * that are not exposed in any user-visible menu surface (the right-click
 * `view/item/context` menus). A command shown to users in a real menu
 * must read naturally there — labeling it "internal" would be a UX
 * regression in that menu.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);

const commands: Array<{ command: string; title: string }> =
  PKG.contributes.commands;

const titleByCommand = new Map(commands.map((c) => [c.command, c.title]));

const viewContextCommands: string[] = (
  PKG.contributes.menus?.['view/item/context'] ?? []
).map((m: { command: string }) => m.command);

describe('package.json contributes.commands', () => {
  it('has no two commands sharing the same title', () => {
    const byTitle = new Map<string, string[]>();
    for (const { command, title } of commands) {
      const list = byTitle.get(title) ?? [];
      list.push(command);
      byTitle.set(title, list);
    }
    const dupes = [...byTitle.entries()].filter(([, ids]) => ids.length > 1);
    expect(dupes, `duplicate titles: ${JSON.stringify(dupes)}`).toEqual([]);
  });

  it('has no debug-note-style parenthetical titles like "(and ...)"', () => {
    const offenders = commands.filter(({ title }) => /\(and\b/i.test(title));
    expect(offenders).toEqual([]);
  });

  it('declares the cross-file diff navigation commands (#1060), palette-discoverable + bound', () => {
    // Palette-discoverable: declared with a title and NOT hidden via a
    // commandPalette `when:false` entry. Also bound to Ctrl+Alt+] / Ctrl+Alt+[,
    // gated by `codev.activeEditorIsBuilderFile` so the keys only fire on a
    // builder diff (and don't shadow those chords elsewhere). Avoids function
    // keys — within-file hunk nav keeps F7 / Shift+F7.
    const palette: Array<{ command: string; when?: string }> =
      PKG.contributes.menus?.commandPalette ?? [];
    const keybindings: Array<{ command: string; key?: string; when?: string }> =
      PKG.contributes.keybindings ?? [];
    const expectedKey: Record<string, string> = {
      'codev.diffNextFile': 'ctrl+alt+]',
      'codev.diffPreviousFile': 'ctrl+alt+[',
    };
    for (const command of ['codev.diffNextFile', 'codev.diffPreviousFile']) {
      expect(titleByCommand.get(command), `${command} missing title`).toBeTruthy();
      const hidden = palette.find((m) => m.command === command && m.when === 'false');
      expect(hidden, `${command} must stay palette-discoverable`).toBeUndefined();

      const binding = keybindings.find((k) => k.command === command);
      expect(binding, `${command} missing keybinding`).toBeDefined();
      expect(binding!.key).toBe(expectedKey[command]);
      expect(binding!.key, `${command} must not use a function key`).not.toMatch(/F\d/i);
      expect(binding!.when).toBe('codev.activeEditorIsBuilderFile');
    }
  });

  it('declares the viewport-anchored hunk-step wrappers, bound over the built-in keys in builder diffs (#1546)', () => {
    const keybindings: Array<{ command: string; key?: string; when?: string }> =
      PKG.contributes.keybindings ?? [];
    const expectedKey: Record<string, string> = {
      'codev.diffNextHunk': 'alt+f5',
      'codev.diffPrevHunk': 'shift+alt+f5',
    };
    for (const [command, key] of Object.entries(expectedKey)) {
      expect(titleByCommand.get(command), `${command} missing title`).toBeTruthy();
      const binding = keybindings.find((k) => k.command === command);
      expect(binding, `${command} missing keybinding`).toBeDefined();
      expect(binding!.key).toBe(key);
      // Either side of a builder diff: the modified side is the registered
      // worktree file; the original side is the codev-diff base document.
      expect(binding!.when).toBe("textCompareEditorVisible && (codev.activeEditorIsBuilderFile || resourceScheme == 'codev-diff')");
    }
  });

  it('does not label a command "(internal)" if it is exposed in view/item/context', () => {
    const offenders = viewContextCommands
      .filter((cmd) => /\(internal\)/i.test(titleByCommand.get(cmd) ?? ''))
      .map((cmd) => ({ command: cmd, title: titleByCommand.get(cmd) }));
    expect(
      offenders,
      `commands marked (internal) but shown in a view menu: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
