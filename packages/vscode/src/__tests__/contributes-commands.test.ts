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
