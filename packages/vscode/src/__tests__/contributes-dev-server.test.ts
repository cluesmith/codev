/**
 * Contributes invariants for the Codev Dev surface (#921):
 * - the `codev.devServer` view is the real tab in #812's `codevPanel` container;
 * - extension.ts flips `codev.panelContainerEmpty` false (so #812's placeholder
 *   yields) and registers the view + the chip refresh;
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

describe('codev.devServer view (#921)', () => {
  it('lives in the codevPanel container with the title "Codev Dev"', () => {
    const dev = (views.codevPanel ?? []).find((v) => v.id === 'codev.devServer');
    expect(dev).toBeDefined();
    expect(dev!.name).toBe('Codev Dev');
    // Always present (no `when`), so the container is never empty.
    expect(dev!.when).toBeUndefined();
  });
});

describe('codev.devServer title-bar actions (#921)', () => {
  const action = (command: string) => titleMenus.find((m) => m.command === command);

  it('declares Stop/Restart gated on a running dev', () => {
    for (const cmd of ['codev.devServer.stop', 'codev.devServer.restart']) {
      expect(action(cmd)?.when).toBe('view == codev.devServer && codev.devServerRunning');
    }
  });

  it('shows Switch Target whenever the view is active', () => {
    expect(action('codev.devServer.switchTarget')?.when).toBe('view == codev.devServer');
  });

  it('pairs Reveal / Hide as a sidebar toggle on the Codev viewlet visibility', () => {
    const codevSidebarShown = "sideBarVisible && activeViewlet == 'workbench.view.extension.codev'";
    // Reveal shows when the Codev sidebar is NOT the active, visible viewlet.
    expect(action('codev.devServer.showSidebar')?.when)
      .toBe(`view == codev.devServer && !(${codevSidebarShown})`);
    // Hide shows when it is — the complementary half of the toggle.
    expect(action('codev.devServer.hideSidebar')?.when)
      .toBe(`view == codev.devServer && ${codevSidebarShown}`);
  });

  it('gives each action an icon', () => {
    const byId = Object.fromEntries(commands.map((c) => [c.command, c]));
    expect(byId['codev.devServer.stop']?.icon).toBe('$(debug-stop)');
    expect(byId['codev.devServer.restart']?.icon).toBe('$(debug-restart)');
    expect(byId['codev.devServer.switchTarget']?.icon).toBe('$(arrow-swap)');
    expect(byId['codev.devServer.showSidebar']?.icon).toBe('$(eye)');
    expect(byId['codev.devServer.hideSidebar']?.icon).toBe('$(eye-closed)');
  });
});

describe('extension.ts wiring (#921)', () => {
  it('creates the dev-server tree view via createTreeView (for the badge handle)', () => {
    expect(EXT_SRC).toMatch(
      /createTreeView\(['"]codev\.devServer['"], \{ treeDataProvider: devServerProvider \}\)/,
    );
  });

  it('drives the chip + devServerRunning context key + tab badge off the dev-terminal event', () => {
    expect(EXT_SRC).toMatch(/onDidChangeDevTerminals\(refreshDevSurface\)/);
    expect(EXT_SRC).toMatch(/setContext['"],\s*['"]codev\.devServerRunning['"]/);
    expect(EXT_SRC).toMatch(/devServerView\.badge\s*=/);
  });
});
