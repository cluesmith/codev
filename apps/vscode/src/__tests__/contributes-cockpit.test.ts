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
