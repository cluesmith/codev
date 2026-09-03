/**
 * Invariants for the Codev panel container (#812 scaffolding, repurposed by #1049):
 * - a `panel` viewsContainer `codevPanel` is declared with the Codev icon;
 * - the activitybar container is untouched;
 * - the panel hosts the contextual `Codev` webview view (`codev.contextualPanel`), which
 *   replaced the vestigial `codev.placeholder` signpost + its `codev.panelContainerEmpty` gate;
 * - the existing sidebar views are unchanged (regression guard);
 * - extension.ts wires the webview view provider and reveals the panel once.
 *
 * #1049 retired the placeholder (it could never render — `codev.dev` unconditionally seeded the
 * gate key false) and the dead context-key flip; those guards are replaced by the contextual-view
 * and no-placeholder assertions below. `codev.dev` invariants live in contributes-dev.test.ts.
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

describe('codevPanel contextual view (#1049)', () => {
  it('hosts the contextual Codev webview view', () => {
    const panelViews = views.codevPanel ?? [];
    const contextual = panelViews.find((v) => v.id === 'codev.contextualPanel');
    expect(contextual).toMatchObject({ id: 'codev.contextualPanel', name: 'Codev', type: 'webview' });
  });

  it('retired the placeholder view and its panelContainerEmpty gate', () => {
    const panelIds = (views.codevPanel ?? []).map((v) => v.id);
    expect(panelIds).not.toContain('codev.placeholder');
    const anyGate = Object.values(views)
      .flat()
      .some((v) => v.when?.includes('codev.panelContainerEmpty'));
    expect(anyGate).toBe(false);
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

describe('extension.ts wiring (#1049)', () => {
  it('registers the contextual panel webview view provider', () => {
    expect(EXT_SRC).toMatch(
      /registerWebviewViewProvider\(\s*ContextualPanelProvider\.viewType/,
    );
  });

  it('no longer registers the placeholder provider or flips panelContainerEmpty', () => {
    expect(EXT_SRC).not.toMatch(/PanelPlaceholderProvider/);
    expect(EXT_SRC).not.toMatch(/codev\.panelContainerEmpty/);
  });

  it('reveals the panel once on first run, guarded by globalState', () => {
    // The reveal must be gated on a globalState flag so it fires once per
    // profile, not on every launch.
    expect(EXT_SRC).toMatch(/globalState\.get\(\s*PANEL_REVEALED_KEY\s*\)/);
    expect(EXT_SRC).toMatch(/executeCommand\(['"]workbench\.view\.extension\.codevPanel['"]\)/);
    expect(EXT_SRC).toMatch(/globalState\.update\(\s*PANEL_REVEALED_KEY\s*,\s*true\s*\)/);
  });
});
