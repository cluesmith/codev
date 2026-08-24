/**
 * Contributes invariants for the Codev Dev surface (#921):
 * - the `codev.dev` view is a real tab in #812's `codevPanel` container (alongside the
 *   contextual `codev.contextualPanel` view added by #1049);
 * - extension.ts registers the view + the chip refresh;
 * - the four title-bar actions are declared with icons and the right `when`
 *   gating (Stop/Restart only while running; Switch/Reveal always).
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

describe('codev.dev view (#921)', () => {
  it('lives in the codevPanel container with the title "Codev Dev"', () => {
    const dev = (views.codevPanel ?? []).find((v) => v.id === 'codev.dev');
    expect(dev).toBeDefined();
    expect(dev!.name).toBe('Codev Dev');
    // Always present (no `when`), so the container is never empty.
    expect(dev!.when).toBeUndefined();
  });
});

describe('codev.dev title-bar actions (#921)', () => {
  const action = (command: string) => titleMenus.find((m) => m.command === command);

  it('declares Stop/Restart gated on a running dev', () => {
    for (const cmd of ['codev.dev.stop', 'codev.dev.restart']) {
      expect(action(cmd)?.when).toBe('view == codev.dev && codev.devRunning');
    }
  });

  it('shows Switch Target whenever the view is active', () => {
    expect(action('codev.dev.switchTarget')?.when).toBe('view == codev.dev');
  });

  it('pairs Reveal / Hide as a sidebar toggle on the Codev viewlet visibility', () => {
    const codevSidebarShown = "sideBarVisible && activeViewlet == 'workbench.view.extension.codev'";
    // Reveal shows when the Codev sidebar is NOT the active, visible viewlet.
    expect(action('codev.dev.showSidebar')?.when)
      .toBe(`view == codev.dev && !(${codevSidebarShown})`);
    // Hide shows when it is — the complementary half of the toggle.
    expect(action('codev.dev.hideSidebar')?.when)
      .toBe(`view == codev.dev && ${codevSidebarShown}`);
  });

  it('gives each action an icon', () => {
    const byId = Object.fromEntries(commands.map((c) => [c.command, c]));
    expect(byId['codev.dev.stop']?.icon).toBe('$(debug-stop)');
    expect(byId['codev.dev.restart']?.icon).toBe('$(debug-restart)');
    expect(byId['codev.dev.switchTarget']?.icon).toBe('$(arrow-swap)');
    expect(byId['codev.dev.showSidebar']?.icon).toBe('$(eye)');
    expect(byId['codev.dev.hideSidebar']?.icon).toBe('$(eye-closed)');
  });
});

describe('extension.ts wiring (#921)', () => {
  it('creates the dev tree view via createTreeView (for the badge handle)', () => {
    expect(EXT_SRC).toMatch(
      /createTreeView\(['"]codev\.dev['"], \{ treeDataProvider: devProvider \}\)/,
    );
  });

  it('drives the chip + devRunning context key + tab badge off the dev-terminal event', () => {
    expect(EXT_SRC).toMatch(/onDidChangeDevTerminals\(refreshDevSurface\)/);
    expect(EXT_SRC).toMatch(/setContext['"],\s*['"]codev\.devRunning['"]/);
    expect(EXT_SRC).toMatch(/devView\.badge\s*=/);
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
