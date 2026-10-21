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
  visibility?: string;
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

  // #1809 (owner ruling): the Agents view must not render in a builder-worktree
  // window at all. It stays visible in every OTHER window, including empty and
  // non-codev ones where it anchors the container and carries the welcome
  // content; in a worktree window `codev.workspace` (hasWorkspace) still anchors it.
  it('codev.agents is hidden only in a builder-worktree window', () => {
    expect(viewById('codev.agents').when).toBe('!codev.isBuilderWorktree');
  });
});

describe('default view visibility (#1169: reclaim sidebar vertical space)', () => {
  // `visibility` is a first-render-only default string VS Code reads from the
  // manifest — no compile error catches a dropped "collapsed", and it only
  // affects fresh installs, so a regression would silently ship. Pin it.
  it.each(['codev.pullRequests', 'codev.recentlyClosed', 'codev.team', 'codev.status'])(
    'lower-priority view %s defaults to collapsed',
    (id) => {
      expect(viewById(id).visibility).toBe('collapsed');
    },
  );

  it.each(['codev.workspace', 'codev.agents', 'codev.backlog'])(
    'primary view %s stays expanded (no visibility override)',
    (id) => {
      expect(viewById(id).visibility).toBeUndefined();
    },
  );
});

describe('viewsWelcome (empty-window surfaces)', () => {
  const loadingWelcome = viewsWelcome.find(w => w.when === '!codev.stateKnown');
  const quadrantWelcomes = viewsWelcome.filter(w => w !== loadingWelcome);
  const guestWelcome = viewsWelcome.find(
    w => w.when === 'codev.stateKnown && !codev.hasWorkspace && !codev.ideMode',
  );
  const ideWelcome = viewsWelcome.find(
    w => w.when === 'codev.stateKnown && !codev.hasWorkspace && codev.ideMode',
  );

  it('covers the pre-activation gap with a loading placeholder', () => {
    // viewsWelcome content also renders while the view has no registered
    // provider yet, so this entry replaces VS Code's raw "There is no data
    // provider registered that can provide view data." during the
    // workbench-restore → activation gap. No command links: nothing is
    // actionable while state is unknown.
    expect(loadingWelcome).toBeDefined();
    expect(loadingWelcome!.view).toBe('codev.agents');
    expect(loadingWelcome!.contents).not.toContain('command:');
  });

  it('contributes exactly the two no-workspace quadrants, both on codev.agents', () => {
    expect(guestWelcome).toBeDefined();
    expect(ideWelcome).toBeDefined();
    expect(quadrantWelcomes).toHaveLength(2);
    for (const w of quadrantWelcomes) {
      expect(w.view).toBe('codev.agents');
      // Every quadrant entry belongs to a no-workspace state; a workspace
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
    for (const w of quadrantWelcomes) {
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
