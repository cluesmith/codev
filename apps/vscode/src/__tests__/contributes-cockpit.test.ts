/**
 * Spec 1963 Phase 4: the Codev Cockpit's contributions. The new activity-bar container sits
 * directly after `codev`, its single tree view has no `when` (the button appears in every window
 * the extension activates in), the icon file exists, and the refresh command has its title-bar
 * entry. The existing `codev`, `codev-tower` and `codevPanel` entries are unchanged: their
 * containers, views and menu entries are pinned to their pre-Cockpit text.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const EXT_SRC = readFileSync(resolve(ROOT, 'src/extension.ts'), 'utf8');

interface Container { id: string; title: string; icon: string }
interface View { id: string; name: string; when?: string }
interface Menu { command: string; when?: string; group?: string }

const containers = PKG.contributes.viewsContainers as Record<string, Container[]>;
const views = PKG.contributes.views as Record<string, View[]>;
const menus = PKG.contributes.menus as Record<string, Menu[]>;

describe('Codev Cockpit container and view', () => {
  it('registers the container directly after the Codev container in the activity bar', () => {
    const ids = containers.activitybar.map(c => c.id);
    expect(ids.indexOf('codev-cockpit')).toBe(ids.indexOf('codev') + 1);
    expect(containers.activitybar.find(c => c.id === 'codev-cockpit')).toEqual({
      id: 'codev-cockpit', title: 'Codev Cockpit', icon: 'icons/codev-cockpit.svg',
    });
  });

  it('ships the icon file it names', () => {
    expect(existsSync(resolve(ROOT, 'icons/codev-cockpit.svg'))).toBe(true);
  });

  it('holds one tree view, codev.cockpit, with no when clause', () => {
    expect(views['codev-cockpit']).toEqual([{ id: 'codev.cockpit', name: 'Codev Cockpit' }]);
    // The view lives only in its own container.
    for (const [container, list] of Object.entries(views)) {
      if (container === 'codev-cockpit') { continue; }
      expect(list.some(v => v.id === 'codev.cockpit')).toBe(false);
    }
  });

  it('declares the refresh command, with a title-bar entry scoped to the Cockpit', () => {
    const commands = PKG.contributes.commands as Array<{ command: string; title: string; icon?: string }>;
    expect(commands.find(c => c.command === 'codev.cockpit.refresh')).toEqual({
      command: 'codev.cockpit.refresh', title: 'Codev: Refresh Cockpit', icon: '$(refresh)',
    });
    const entry = menus['view/title'].find(m => m.command === 'codev.cockpit.refresh');
    expect(entry).toEqual({ command: 'codev.cockpit.refresh', when: 'view == codev.cockpit', group: 'navigation@1' });
  });

  it('creates the tree view and registers the refresh command in extension.ts', () => {
    expect(EXT_SRC).toMatch(/createTreeView\(COCKPIT_VIEW_ID, \{ treeDataProvider: cockpitProvider \}\)/);
    expect(EXT_SRC).toMatch(/reg\('codev\.cockpit\.refresh', \(\) => Promise\.all\(\[overviewCache\.refresh\(\), towerCache\.refresh\(\)\]\)\)/);
  });
});

/**
 * The pre-Cockpit text of every contribution the Cockpit must not touch. Recorded from
 * `package.json` at the Phase 3 commit (`git show d1714a740:apps/vscode/package.json`).
 */
describe('existing containers, views and menus are unchanged', () => {
  it('the codev, codev-tower and codevPanel containers', () => {
    expect(containers.activitybar.find(c => c.id === 'codev')).toEqual({ id: 'codev', title: 'Codev', icon: 'icons/codev.svg' });
    expect(containers.secondarySidebar).toEqual([{ id: 'codev-tower', title: 'Codev Tower', icon: 'icons/tower.svg' }]);
    expect(containers.panel).toEqual([{ id: 'codevPanel', title: 'Codev', icon: 'icons/codev.svg' }]);
  });

  it('their views', () => {
    expect(views.codev).toMatchSnapshot();
    expect(views['codev-tower']).toEqual([{ id: 'codev.tower', name: 'Codev Tower' }]);
    expect(views.codevPanel).toEqual([{ id: 'codev.contextualPanel', name: 'Codev', type: 'webview' }]);
  });

  it('every menu entry outside the Cockpit', () => {
    const notCockpit: Record<string, Menu[]> = {};
    for (const [location, entries] of Object.entries(menus)) {
      notCockpit[location] = entries.filter(m => !(m.when ?? '').includes('codev.cockpit') && !m.command.startsWith('codev.cockpit.'));
    }
    expect(notCockpit).toMatchSnapshot();
  });
});

describe('the Decisions panel (Phase 7)', () => {
  const commands = PKG.contributes.commands as Array<{ command: string; title: string; icon?: string }>;

  it('declares Codev: Open Decisions, and keeps it in the command palette', () => {
    expect(commands.find(c => c.command === 'codev.openDecisions')).toEqual({
      command: 'codev.openDecisions', title: 'Codev: Open Decisions', icon: '$(law)',
    });
    expect((menus.commandPalette ?? []).some(m => m.command === 'codev.openDecisions')).toBe(false);
  });

  it('activates to restore the panel after a reload', () => {
    expect(PKG.activationEvents).toContain('onWebviewPanel:codev.decisions');
  });

  it('registers the command and the serializer for the panel in extension.ts', () => {
    expect(EXT_SRC).toMatch(/regCli\('codev\.openDecisions', \(\) => decisionsPanels\.show\(\)\)/);
    expect(EXT_SRC).toMatch(/registerWebviewPanelSerializer\(DECISIONS_VIEW_TYPE, decisionsPanels\)/);
  });

  it("decides availability from the window's folders, so a reload's restore is not closed before Tower connects", () => {
    // The connection manager's workspace is null until its async initialize() runs, and a restored
    // panel reaches the serializer before that (found by the harness's reload check).
    const wiring = EXT_SRC.slice(EXT_SRC.indexOf('new DecisionsPanels({'), EXT_SRC.indexOf('registerWebviewPanelSerializer(DECISIONS_VIEW_TYPE'));
    expect(wiring).toMatch(/workspacePath: detectWorkspacePath\(\),/);
    expect(wiring).not.toMatch(/getWorkspacePath\(\)/);
  });

  it('ships the built webview: dist is packaged, the build script is not', () => {
    const ignored = readFileSync(resolve(ROOT, '.vscodeignore'), 'utf8').split('\n').map(line => line.trim());
    expect(ignored).toContain('esbuild.webview.cjs');
    expect(ignored.some(line => line.startsWith('dist'))).toBe(false);
  });
});

describe('the Work panel (Phase 8)', () => {
  const commands = PKG.contributes.commands as Array<{ command: string; title: string; icon?: string }>;

  it('declares Codev: Open Work, and keeps it in the command palette', () => {
    expect(commands.find(c => c.command === 'codev.openWork')).toEqual({ command: 'codev.openWork', title: 'Codev: Open Work' });
    expect((menus.commandPalette ?? []).some(m => m.command === 'codev.openWork')).toBe(false);
  });

  it('activates to restore the panel after a reload', () => {
    expect(PKG.activationEvents).toContain('onWebviewPanel:codev.work');
  });

  it('registers the command and the serializer for the panel in extension.ts', () => {
    expect(EXT_SRC).toMatch(/regCli\('codev\.openWork', \(\) => workPanels\.show\(\)\)/);
    expect(EXT_SRC).toMatch(/registerWebviewPanelSerializer\(WORK_VIEW_TYPE, workPanels\)/);
  });

  it("decides availability from the window's folders, as Decisions does", () => {
    const wiring = EXT_SRC.slice(EXT_SRC.indexOf('new WorkPanels({'), EXT_SRC.indexOf('registerWebviewPanelSerializer(WORK_VIEW_TYPE'));
    expect(wiring).toMatch(/unavailableReason: \(\) => workspaceViewUnavailableReason\('Work', \{/);
    expect(wiring).toMatch(/workspacePath: detectWorkspacePath\(\),/);
    expect(wiring).not.toMatch(/getWorkspacePath\(\)/);
  });
});
