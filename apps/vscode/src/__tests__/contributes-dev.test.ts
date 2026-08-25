/**
 * Contributes invariants for the Codev Dev surface (#921), post-#1049:
 * - #1049 removed the `codev.dev` panel VIEW and its title-bar actions (the contextual panel now owns
 *   `codevPanel`); the always-visible status-bar chip stays.
 * - the #1158 "no dev server terminology" guard still applies to the surviving dev commands.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const EXT_SRC = readFileSync(resolve(ROOT, 'src/extension.ts'), 'utf8');

interface View { id: string; name: string; when?: string }
interface Menu { command: string; when?: string; group?: string }
interface Command { command: string; title: string; icon?: string }

const views = PKG.contributes.views as Record<string, View[]>;
const titleMenus = (PKG.contributes.menus['view/title'] ?? []) as Menu[];
const commands = PKG.contributes.commands as Command[];

describe('codev.dev panel view removed (#1049)', () => {
  it('no longer contributes a codev.dev view in any container', () => {
    const allViews = Object.values(views).flat();
    expect(allViews.find((v) => v.id === 'codev.dev')).toBeUndefined();
  });

  it('has no view/title actions gated on the removed view', () => {
    expect(titleMenus.filter((m) => (m.when ?? '').includes('view == codev.dev'))).toEqual([]);
  });

  it('no longer creates the codev.dev tree view', () => {
    expect(EXT_SRC).not.toMatch(/createTreeView\(['"]codev\.dev['"]/);
    expect(EXT_SRC).not.toMatch(/devView/);
  });
});

describe('dev status-bar chip survives (#921)', () => {
  it('drives the display-only chip + devRunning context key off the dev-terminal event', () => {
    expect(EXT_SRC).toMatch(/onDidChangeDevTerminals\(refreshDevSurface\)/);
    expect(EXT_SRC).toMatch(/setContext['"],\s*['"]codev\.devRunning['"]/);
    expect(EXT_SRC).toMatch(/createStatusBarItem/);
  });
});

// Regression guard for #1158: the runnable-worktrees surfaces must read "dev",
// never "dev server" / "devServer". The abstraction is stack-agnostic (a dev
// server, `cargo run`, `expo start`, a test watcher, a build script, …), so the
// web-centric "Server" wording is banned from every command title and id. This
// fails loudly if a title or id ever reintroduces the term.
describe('#1158: no "dev server" terminology on VS Code surfaces', () => {
  const devCommands = commands.filter(
    (c) => /\bdev\b/i.test(c.command) || /\bdev\b/i.test(c.title),
  );

  it('has dev commands to check (guards against a silently empty filter)', () => {
    expect(devCommands.length).toBeGreaterThan(0);
  });

  it('no command title contains "Server"', () => {
    const offenders = devCommands.filter((c) => /server/i.test(c.title));
    expect(offenders.map((c) => c.title)).toEqual([]);
  });

  it('no command id contains "devServer"', () => {
    const offenders = commands.filter((c) => c.command.includes('devServer'));
    expect(offenders.map((c) => c.command)).toEqual([]);
  });

  it('no view id references codev.devServer', () => {
    const allViews = Object.values(views).flat();
    expect(allViews.filter((v) => v.id.includes('devServer')).map((v) => v.id)).toEqual([]);
  });

  // Scan EVERY contributed menu group (not just view/title) and every keybinding,
  // so a reintroduced devServer id / when-clause in the command palette,
  // view/item/context, or a keybinding can't slip past this guard.
  it('no menu entry (any group) references devServer in its command or when-clause', () => {
    const allMenus = Object.values(
      (PKG.contributes.menus ?? {}) as Record<string, Menu[]>,
    ).flat();
    const offenders = allMenus.filter(
      (m) => (m.command ?? '').includes('devServer') || (m.when ?? '').includes('devServer'),
    );
    expect(offenders).toEqual([]);
  });

  it('no keybinding references a devServer command', () => {
    const keybindings = (PKG.contributes.keybindings ?? []) as Array<{ command?: string; when?: string }>;
    const offenders = keybindings.filter(
      (k) => (k.command ?? '').includes('devServer') || (k.when ?? '').includes('devServer'),
    );
    expect(offenders).toEqual([]);
  });
});
