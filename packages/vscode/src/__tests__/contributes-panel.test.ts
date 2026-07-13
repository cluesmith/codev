/**
 * Invariants for the Codev panel container scaffolding (#812):
 * - a `panel` viewsContainer `codevPanel` is declared with the Codev icon;
 * - the activitybar container is untouched;
 * - the panel hosts the placeholder view, gated by the
 *   `codev.panelContainerEmpty` context key and collapsed by default;
 * - the existing sidebar views are unchanged (regression guard);
 * - extension.ts wires the placeholder provider and the context key.
 *
 * Note: once #921 added the real `codev.dev` view, the panel is no longer
 * empty — the context key is seeded `false` and a second view is present. Those
 * invariants are covered in contributes-dev.test.ts; this file keeps the
 * #812 scaffolding guards (placeholder shape, sidebar regression).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const EXT_SRC = readFileSync(resolve(ROOT, 'src/extension.ts'), 'utf8');

interface ViewContainer { id: string; title: string; icon: string }
interface View { id: string; name: string; when?: string; visibility?: string }

const containers = PKG.contributes.viewsContainers as Record<string, ViewContainer[]>;
const views = PKG.contributes.views as Record<string, View[]>;

describe('codevPanel viewsContainer (#812)', () => {
  it('declares a panel container reusing the Codev icon', () => {
    const panel = containers.panel ?? [];
    const codevPanel = panel.find((c) => c.id === 'codevPanel');
    expect(codevPanel).toBeDefined();
    expect(codevPanel!.title).toBe('Codev');
    expect(codevPanel!.icon).toBe('icons/codev.svg');
  });

  it('leaves the activitybar container untouched', () => {
    const activitybar = containers.activitybar ?? [];
    expect(activitybar).toHaveLength(1);
    expect(activitybar[0]).toMatchObject({ id: 'codev', title: 'Codev', icon: 'icons/codev.svg' });
  });
});

describe('codevPanel placeholder view (#812)', () => {
  it('registers the placeholder view, gated and collapsed', () => {
    const panelViews = views.codevPanel ?? [];
    const placeholder = panelViews.find((v) => v.id === 'codev.placeholder');
    expect(placeholder).toMatchObject({
      id: 'codev.placeholder',
      name: 'Codev',
      when: 'codev.panelContainerEmpty',
      visibility: 'collapsed',
    });
  });

  it('leaves the seven sidebar views unchanged', () => {
    const sidebar = (views.codev ?? []).map((v) => v.id);
    expect(sidebar).toEqual([
      'codev.workspace',
      'codev.agents',
      'codev.backlog',
      'codev.pullRequests',
      'codev.recentlyClosed',
      'codev.team',
      'codev.status',
    ]);
  });
});

describe('extension.ts wiring (#812)', () => {
  it('registers the placeholder provider', () => {
    expect(EXT_SRC).toMatch(
      /registerTreeDataProvider\(['"]codev\.placeholder['"], new PanelPlaceholderProvider\(\)\)/,
    );
  });

  it('seeds the panelContainerEmpty context key false (a real panel view is registered, #921)', () => {
    expect(EXT_SRC).toMatch(
      /setContext['"],\s*['"]codev\.panelContainerEmpty['"],\s*false/,
    );
  });

  it('reveals the panel once on first run, guarded by globalState', () => {
    // The reveal must be gated on a globalState flag so it fires once per
    // profile, not on every launch.
    expect(EXT_SRC).toMatch(/globalState\.get\(\s*PANEL_REVEALED_KEY\s*\)/);
    expect(EXT_SRC).toMatch(/executeCommand\(['"]workbench\.view\.extension\.codevPanel['"]\)/);
    expect(EXT_SRC).toMatch(/globalState\.update\(\s*PANEL_REVEALED_KEY\s*,\s*true\s*\)/);
  });
});
