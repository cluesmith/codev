/**
 * Contribution + wiring parity for the Codev Tower hub (#1566): the manifest declares the view,
 * the switch command, and the row/title menus, and every declared command is actually registered
 * in code. Structural assertions over package.json + source text (the established parity pattern);
 * behavior is covered by tower-*.test.ts and switch-workspace.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const EXT_SRC = readFileSync(resolve(ROOT, 'src/extension.ts'), 'utf8');
const CMD_SRC = readFileSync(resolve(ROOT, 'src/commands/switch-workspace.ts'), 'utf8');

interface View { id: string; name: string }
interface Command { command: string; title: string }
interface Menu { command: string; when?: string; group?: string }

describe('Codev Tower contributions (#1566)', () => {
  it('declares the codev.tower view in the codev-tower container', () => {
    const views = PKG.contributes.views as Record<string, View[]>;
    const towerViews = views['codev-tower'] ?? [];
    expect(towerViews.find((v) => v.id === 'codev.tower')).toMatchObject({ id: 'codev.tower', name: 'Tower' });
    // The view lives ONLY in its own container, never merged into the workspace sidebar.
    expect((views.codev ?? []).some((v) => v.id === 'codev.tower')).toBe(false);
  });

  it('declares the switch-workspace command', () => {
    const commands = PKG.contributes.commands as Command[];
    expect(commands.find((c) => c.command === 'codev.switchWorkspace')).toBeDefined();
  });

  it('wires the deactivate row action to active Tower rows only', () => {
    const menus = (PKG.contributes.menus?.['view/item/context'] ?? []) as Menu[];
    const deactivate = menus.find((m) => m.command === 'codev.tower.deactivateWorkspace');
    expect(deactivate?.when).toContain('view == codev.tower');
    expect(deactivate?.when).toContain('tower-workspace-active');
  });

  it('wires a refresh button to the Tower view title', () => {
    const menus = (PKG.contributes.menus?.['view/title'] ?? []) as Menu[];
    const refresh = menus.find((m) => m.command === 'codev.tower.refresh');
    expect(refresh?.when).toBe('view == codev.tower');
  });

  it('registers the Tower tree view and its title command in extension.ts', () => {
    expect(EXT_SRC).toMatch(/createTreeView\(\s*['"]codev\.tower['"]/);
    expect(EXT_SRC).toMatch(/registerCommand\(\s*['"]codev\.tower\.refresh['"]/);
    expect(EXT_SRC).toMatch(/registerTowerCommands\(/);
  });

  it('registers every manifest Tower command somewhere in code', () => {
    const src = EXT_SRC + CMD_SRC;
    for (const command of ['codev.switchWorkspace', 'codev.tower.deactivateWorkspace', 'codev.tower.refresh']) {
      expect(src).toContain(`'${command}'`);
    }
  });
});
