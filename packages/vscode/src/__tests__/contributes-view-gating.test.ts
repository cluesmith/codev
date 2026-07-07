/**
 * package.json invariants for the #1144 layer model: dual-mode activation
 * events, workspace-gated views, and the per-quadrant viewsWelcome content.
 *
 * Why test this here: `when` clauses and activation events are strings VS
 * Code evaluates at runtime — no compile error catches a dropped
 * `codev.hasWorkspace` gate (dead actions return) or a lost
 * `workspaceContains` entry (activation regresses for pre-onStartupFinished
 * flows). This pins the contract.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);

interface ViewContribution {
  id: string;
  when?: string;
}
interface ViewsWelcomeContribution {
  view: string;
  contents: string;
  when?: string;
}

const sidebarViews: ViewContribution[] = PKG.contributes.views.codev;
const viewsWelcome: ViewsWelcomeContribution[] = PKG.contributes.viewsWelcome ?? [];

function viewById(id: string): ViewContribution {
  const view = sidebarViews.find(v => v.id === id);
  if (!view) {
    throw new Error(`View ${id} not contributed`);
  }
  return view;
}

describe('activationEvents (dual-mode activation)', () => {
  const events: string[] = PKG.activationEvents;

  it('adds onStartupFinished for the IDE / inert-marketplace split', () => {
    expect(events).toContain('onStartupFinished');
  });

  it('keeps both workspaceContains entries', () => {
    expect(events).toContain('workspaceContains:.codev');
    expect(events).toContain('workspaceContains:codev');
  });
});

describe('workspace-bound views are gated on codev.hasWorkspace', () => {
  it.each(['codev.workspace', 'codev.backlog', 'codev.pullRequests', 'codev.recentlyClosed'])(
    '%s',
    (id) => {
      expect(viewById(id).when).toBe('codev.hasWorkspace');
    },
  );

  it('codev.team keeps its teamEnabled gate AND gains the workspace gate', () => {
    expect(viewById('codev.team').when).toBe('codev.teamEnabled && codev.hasWorkspace');
  });

  it('codev.status is Tower-level: visible with a workspace or in the IDE', () => {
    expect(viewById('codev.status').when).toBe('codev.hasWorkspace || codev.ideMode');
  });

  it('codev.agents stays ungated: it anchors the container and carries the welcome content', () => {
    expect(viewById('codev.agents').when).toBeUndefined();
  });
});

describe('viewsWelcome (empty-window surfaces)', () => {
  const guestWelcome = viewsWelcome.find(
    w => w.when === 'codev.stateKnown && !codev.hasWorkspace && !codev.ideMode',
  );
  const ideWelcome = viewsWelcome.find(
    w => w.when === 'codev.stateKnown && !codev.hasWorkspace && codev.ideMode',
  );

  it('contributes exactly the two no-workspace quadrants, both on codev.agents', () => {
    expect(guestWelcome).toBeDefined();
    expect(ideWelcome).toBeDefined();
    for (const w of viewsWelcome) {
      expect(w.view).toBe('codev.agents');
      // Every welcome entry belongs to a no-workspace quadrant; a workspace
      // window must never show onboarding over its real trees.
      expect(w.when).toContain('!codev.hasWorkspace');
      // And every entry waits for activation to have computed the keys:
      // unset context keys evaluate false, so without this gate the guest
      // welcome flashes "Open a folder" inside a codev workspace during the
      // workbench-restore → activation gap.
      expect(w.when).toContain('codev.stateKnown && ');
    }
  });

  it('guest quadrant offers Open Folder only', () => {
    expect(guestWelcome!.contents).toContain('command:workbench.action.files.openFolder');
    expect(guestWelcome!.contents).not.toContain('command:codev.');
  });

  it('IDE quadrant offers Open Folder, Open Recent, and Get Started', () => {
    expect(ideWelcome!.contents).toContain('command:workbench.action.files.openFolder');
    expect(ideWelcome!.contents).toContain('command:workbench.action.openRecent');
    expect(ideWelcome!.contents).toContain('command:codev.openGettingStarted');
  });

  it('welcome command links reference only workbench built-ins or known codev commands', () => {
    // codev.openGettingStarted is registered in extension.ts but (like
    // codev.forwardToBuilder) deliberately not declared in
    // contributes.commands, so palette noise stays zero. This allowlist is
    // the static stand-in for "the command exists at runtime".
    const knownUndeclared = ['codev.openGettingStarted'];
    const declared: string[] = PKG.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    for (const w of viewsWelcome) {
      const links = [...w.contents.matchAll(/command:([\w.]+)/g)].map(m => m[1]);
      expect(links.length).toBeGreaterThan(0);
      for (const cmd of links) {
        const ok = cmd.startsWith('workbench.')
          || declared.includes(cmd)
          || knownUndeclared.includes(cmd);
        expect(ok, `unknown command link ${cmd}`).toBe(true);
      }
    }
  });
});
