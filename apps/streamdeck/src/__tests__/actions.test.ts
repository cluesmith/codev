import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodevStore } from '../store.js';
import type { TowerClient } from '@cluesmith/codev-client';
import {
  CodevAction,
  BuilderAction,
  FleetSlot,
  ApproveGate,
  PrNav,
  SpawnNav,
  DiffFileNav,
  DiffHunkNav,
  ScrollNav,
  ZoomNav,
  zoomInVerb,
} from '../actions.js';

type Sent = { verb: string; args: unknown[]; ws?: string };

function makeStore() {
  const sent: Sent[] = [];
  const opened: string[] = [];
  const getOverview = vi.fn(async (_ws?: string) => null);
  const listWorkspaces = vi.fn(async () => []);
  const client = {
    sendCommand: vi.fn((verb: string, args: unknown[] = [], ws?: string) => {
      sent.push({ verb, args, ws });
      return Promise.resolve({ ok: true, status: 200, data: { ok: true } });
    }),
    getOverview,
    listWorkspaces,
  } as unknown as TowerClient;
  const store = new CodevStore({ client, openUrl: (u) => { opened.push(u); } });
  store.workspaces = [{ path: '/work/alpha', name: 'alpha', active: true }];
  store.overview = {
    builders: [
      { id: 'pir-1', roleId: 'builder-pir-1', issueId: '101', issueTitle: 'Add the relay', blocked: 'plan review', blockedGate: 'plan-approval', protocolPhase: 'plan', progress: 45, worktreePath: '/work/alpha/.builders/pir-1' },
      { id: 'pir-2', roleId: 'builder-pir-2', issueId: '102', issueTitle: 'Wire the dial', blocked: null, blockedGate: null, protocolPhase: 'implement', progress: 70, worktreePath: '/work/alpha/.builders/pir-2' },
    ],
    pendingPRs: [{ id: '7', title: 'Fix', url: 'https://gh/pr/7' }],
    backlog: [{ id: '55', title: 'Add X' }],
    recentlyClosed: [],
  } as never;
  return { store, sent, opened, getOverview, listWorkspaces };
}

const keyEvent = (settings: Record<string, unknown> = {}) => ({
  action: { showOk: vi.fn(), showAlert: vi.fn(), setTitle: vi.fn(), isKey: () => true, isDial: () => false },
  payload: { settings },
});
const dial = (ticks: number) => ({
  action: { setTitle: vi.fn(), setFeedback: vi.fn(), showAlert: vi.fn(), isKey: () => false, isDial: () => true },
  payload: { ticks, settings: {} },
});

describe('verb keypads', () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => { ctx = makeStore(); });

  it('CodevAction fires its default verb, stamped with the selected workspace', async () => {
    const ev = keyEvent();
    await new CodevAction(ctx.store).onKeyDown(ev as never);
    expect(ctx.sent).toEqual([{ verb: 'refresh-overview', args: [], ws: '/work/alpha' }]);
    expect(ev.action.showOk).toHaveBeenCalled();
  });

  it('CodevAction honors a settings verb override', async () => {
    await new CodevAction(ctx.store).onKeyDown(keyEvent({ verb: 'new-shell' }) as never);
    expect(ctx.sent[0].verb).toBe('new-shell');
  });

  it('BuilderAction defaults to slot 1 + view-diff', async () => {
    await new BuilderAction(ctx.store).onKeyDown(keyEvent() as never);
    expect(ctx.sent[0]).toEqual({ verb: 'view-diff', args: ['pir-1'], ws: '/work/alpha' });
  });

  it('BuilderAction targets the chosen slot and verb', async () => {
    await new BuilderAction(ctx.store).onKeyDown(keyEvent({ slot: '2', verb: 'open-terminal' }) as never);
    expect(ctx.sent[0]).toEqual({ verb: 'open-terminal', args: ['pir-2'], ws: '/work/alpha' });
  });
});

describe('slot keys', () => {
  it('FleetSlot opens the slot builder’s terminal by default', async () => {
    const ctx = makeStore();
    await new FleetSlot(ctx.store).onKeyDown(keyEvent({ slot: '2' }) as never);
    expect(ctx.sent[0]).toEqual({ verb: 'open-terminal', args: ['pir-2'], ws: '/work/alpha' });
  });

  it('a slot past the end of the builder list alerts and sends nothing', async () => {
    const ctx = makeStore(); // only 2 builders
    const ev = keyEvent({ slot: '8' });
    await new FleetSlot(ctx.store).onKeyDown(ev as never);
    expect(ctx.sent).toHaveLength(0);
    expect(ev.action.showAlert).toHaveBeenCalled();
  });

  // One SingletonAction instance serves every key of its type — these guard the
  // per-instance fix (without it, all keys collided on shared state).
  const slotKey = (id: string) => ({ id, isKey: () => true, setTitle: vi.fn() });

  it('renders each slot key against its own slot (different slots → different builders)', () => {
    const ctx = makeStore(); // pir-1 (#101), pir-2 (#102)
    const fs = new FleetSlot(ctx.store);
    const a = slotKey('A');
    const b = slotKey('B');
    fs.onWillAppear({ action: a, payload: { settings: { slot: '1' } } } as never);
    fs.onWillAppear({ action: b, payload: { settings: { slot: '2' } } } as never);
    expect(a.setTitle).toHaveBeenLastCalledWith(expect.stringContaining('#101'));
    expect(b.setTitle).toHaveBeenLastCalledWith(expect.stringContaining('#102'));
  });

  it('re-renders every slot key on a store change (fixes stale-on-workspace-switch)', () => {
    const ctx = makeStore();
    const fs = new FleetSlot(ctx.store);
    const a = slotKey('A');
    const b = slotKey('B');
    fs.onWillAppear({ action: a, payload: { settings: { slot: '1' } } } as never);
    fs.onWillAppear({ action: b, payload: { settings: { slot: '2' } } } as never);
    a.setTitle.mockClear();
    b.setTitle.mockClear();
    ctx.store.setLevel('builders'); // any store change → onChange → render all keys
    expect(a.setTitle).toHaveBeenCalled();
    expect(b.setTitle).toHaveBeenCalled();
  });
});

describe('ApproveGate', () => {
  it('fires approve-gate for the top blocked builder', async () => {
    const ctx = makeStore();
    await new ApproveGate(ctx.store).onKeyDown(keyEvent() as never);
    expect(ctx.sent[0]).toEqual({ verb: 'approve-gate', args: ['pir-1'], ws: '/work/alpha' });
  });

  it('alerts and sends nothing when no gate is pending', async () => {
    const ctx = makeStore();
    ctx.store.overview!.builders = ctx.store.overview!.builders.map((b) => ({ ...b, blocked: null }));
    const ev = keyEvent();
    await new ApproveGate(ctx.store).onKeyDown(ev as never);
    expect(ctx.sent).toHaveLength(0);
    expect(ev.action.showAlert).toHaveBeenCalled();
  });
});

describe('encoders', () => {
  it('DiffFileNav: rotate navigates, press forwards the file, touch jumps to first', async () => {
    const ctx = makeStore();
    const nav = new DiffFileNav(ctx.store);
    await nav.onDialRotate(dial(1) as never);   // next
    await nav.onDialRotate(dial(-2) as never);  // prev
    await nav.onDialDown();                      // forward
    await nav.onTouchTap();                       // first
    expect(ctx.sent.map((s) => s.verb)).toEqual(['diff-next-file', 'diff-prev-file', 'forward-file', 'diff-first-file']);
    expect(ctx.sent.every((s) => s.ws === '/work/alpha')).toBe(true);
  });

  it('Diff dials forward their axis on a dial press', async () => {
    const ctx = makeStore();
    await new DiffFileNav(ctx.store).onDialDown();
    await new DiffHunkNav(ctx.store).onDialDown();
    expect(ctx.sent.map((s) => s.verb)).toEqual(['forward-file', 'forward-hunk']);
  });

  it('ScrollNav scrolls the editor on rotate and forwards the selection on press', async () => {
    const ctx = makeStore();
    const nav = new ScrollNav(ctx.store);
    await nav.onDialRotate(dial(1) as never);  // down
    await nav.onDialRotate(dial(-1) as never); // up
    await nav.onDialDown();
    expect(ctx.sent[0]).toEqual({ verb: 'scroll', args: [{ to: 'down', by: 'line', value: 3, revealCursor: false }], ws: '/work/alpha' });
    expect((ctx.sent[1].args[0] as { to: string }).to).toBe('up');
    expect(ctx.sent[2]).toEqual({ verb: 'forward-selection', args: [], ws: '/work/alpha' });
  });

  it('PrNav opens the selected PR url on press', async () => {
    const ctx = makeStore();
    await new PrNav(ctx.store).onDialDown();
    expect(ctx.opened).toEqual(['https://gh/pr/7']);
  });

  it('SpawnNav spawns a builder for the selected backlog issue', async () => {
    const ctx = makeStore();
    await new SpawnNav(ctx.store).onDialDown(dial(0) as never);
    expect(ctx.sent[0]).toEqual({ verb: 'spawn-builder', args: ['55'], ws: '/work/alpha' });
  });

});

describe('CodevStore.syncToWorkspace (focus following)', () => {
  const twoWorkspaces = () => [
    { path: '/work/a', name: 'a', active: true },
    { path: '/work/b', name: 'b', active: false },
  ];

  it('re-points the cursor + reloads overview for the focused workspace, resetting the builder', async () => {
    const ctx = makeStore();
    ctx.store.workspaces = twoWorkspaces();
    ctx.store.cursor.builder = 3; // pretend we were deep in A's builders
    await ctx.store.syncToWorkspace('/work/b');
    expect(ctx.store.cursor.workspace).toBe(1);
    expect(ctx.store.cursor.builder).toBe(0);
    expect(ctx.getOverview).toHaveBeenCalledWith('/work/b');
  });

  it('preserves the zoom level (works zoomed in or out)', async () => {
    const ctx = makeStore();
    ctx.store.workspaces = twoWorkspaces();
    ctx.store.setLevel('builders');
    await ctx.store.syncToWorkspace('/work/b');
    expect(ctx.store.cursor.level).toBe('builders');
  });

  it('is a no-op for an unregistered workspace (e.g. a builder worktree window)', async () => {
    const ctx = makeStore();
    ctx.store.workspaces = twoWorkspaces();
    ctx.listWorkspaces.mockResolvedValue(twoWorkspaces() as never);
    await ctx.store.syncToWorkspace('/some/worktree/not/registered');
    expect(ctx.store.cursor.workspace).toBe(0); // unchanged
    expect(ctx.getOverview).not.toHaveBeenCalled();
  });

  it('is a no-op when already on that workspace (no churn switching same-workspace windows)', async () => {
    const ctx = makeStore();
    ctx.store.workspaces = twoWorkspaces();
    await ctx.store.syncToWorkspace('/work/a'); // already workspace 0
    expect(ctx.getOverview).not.toHaveBeenCalled();
  });
});

describe('zoomInVerb (phase-aware zoom-in)', () => {
  const b = (over: Record<string, unknown>) => ({ id: 'x', blockedGate: null, protocolPhase: '', ...over }) as never;
  it('opens the spec when blocked on spec-approval or in the specify phase', () => {
    expect(zoomInVerb(b({ blockedGate: 'spec-approval' }))).toBe('open-spec');
    expect(zoomInVerb(b({ protocolPhase: 'specify' }))).toBe('open-spec');
  });
  it('opens the plan when blocked on plan-approval or in the plan phase', () => {
    expect(zoomInVerb(b({ blockedGate: 'plan-approval' }))).toBe('open-plan');
    expect(zoomInVerb(b({ protocolPhase: 'plan' }))).toBe('open-plan');
  });
  it('opens the diff for implementation phases/gates and unknowns', () => {
    expect(zoomInVerb(b({ protocolPhase: 'implement' }))).toBe('view-diff');
    expect(zoomInVerb(b({ protocolPhase: 'review' }))).toBe('view-diff');
    expect(zoomInVerb(b({ blockedGate: 'dev-approval' }))).toBe('view-diff'); // gate past plan → diff
    expect(zoomInVerb(b({}))).toBe('view-diff'); // no status → diff
  });
});

describe('CodevStore.syncToBuilder (builder follow)', () => {
  it('matches OverviewBuilder.id (diff/sidebar signal) and descends to builders', () => {
    const ctx = makeStore(); // cursor.builder 0 → pir-1; level defaults to workspaces
    ctx.store.syncToBuilder('pir-2');
    expect(ctx.store.cursor.builder).toBe(1);
    expect(ctx.store.cursor.level).toBe('builders');
    expect(ctx.store.selectedBuilder()?.id).toBe('pir-2');
  });

  it('also matches the roleId form (terminal signal)', () => {
    const ctx = makeStore();
    ctx.store.syncToBuilder('builder-pir-2');
    expect(ctx.store.cursor.builder).toBe(1);
    expect(ctx.store.selectedBuilder()?.id).toBe('pir-2');
  });

  it('is a no-op for an unknown id (silent no-match, no throw)', () => {
    const ctx = makeStore();
    const before = { ...ctx.store.cursor };
    ctx.store.syncToBuilder('does-not-exist');
    expect(ctx.store.cursor).toEqual(before);
  });
});

describe('ZoomNav zoom gesture', () => {
  const multiWorkspace = (ctx: ReturnType<typeof makeStore>) => {
    ctx.store.workspaces = [
      { path: '/work/a', name: 'a', active: true },
      { path: '/work/b', name: 'b', active: false },
    ];
  };

  it('single workspace: collapses to builders, rotate selects, touch opens the diff', async () => {
    const ctx = makeStore(); // 1 workspace, 2 builders
    const nav = new ZoomNav(ctx.store);
    nav.onDialRotate(dial(1) as never); // normalizes to builders level + selects pir-2
    expect(ctx.store.cursor.level).toBe('builders');
    await nav.onTouchTap(); // touch = zoom in → open diff
    expect(ctx.sent[0]).toEqual({ verb: 'view-diff', args: ['pir-2'], ws: '/work/alpha' });
  });

  it('phase-aware: zooming into a plan-gated builder opens the plan, not the diff', async () => {
    const ctx = makeStore(); // cursor.builder 0 → pir-1 (blockedGate plan-approval)
    ctx.store.setLevel('builders');
    await new ZoomNav(ctx.store).onTouchTap();
    expect(ctx.sent[0]).toEqual({ verb: 'open-plan', args: ['pir-1'], ws: '/work/alpha' });
  });

  it('multi-workspace: touch zooms in to builders and focuses that workspace window (unstamped)', async () => {
    const ctx = makeStore();
    multiWorkspace(ctx);
    const nav = new ZoomNav(ctx.store);
    expect(ctx.store.cursor.level).toBe('workspaces'); // cursor.workspace 0 → /work/a
    await nav.onTouchTap();
    expect(ctx.store.cursor.level).toBe('builders');
    expect(ctx.sent[0].verb).toBe('focus-workspace');
    expect(ctx.sent[0].args).toEqual(['/work/a']);
    expect(ctx.sent[0].ws).toBeUndefined(); // unstamped → runs on the focused window
  });

  it('multi-workspace: dial press zooms back out from builders to workspaces', () => {
    const ctx = makeStore();
    multiWorkspace(ctx);
    ctx.store.setLevel('builders');
    const nav = new ZoomNav(ctx.store);
    nav.onDialDown(); // press = zoom out / reset
    expect(ctx.store.cursor.level).toBe('workspaces');
  });

  it('dial press at the workspaces altitude is a no-op (already at the top)', () => {
    const ctx = makeStore();
    multiWorkspace(ctx);
    const nav = new ZoomNav(ctx.store);
    expect(ctx.store.cursor.level).toBe('workspaces');
    nav.onDialDown();
    expect(ctx.store.cursor.level).toBe('workspaces');
  });

  it('rotating at the workspaces level re-fetches the new workspace overview', async () => {
    const ctx = makeStore();
    multiWorkspace(ctx);
    const nav = new ZoomNav(ctx.store);
    nav.onDialRotate(dial(1) as never); // workspace 0 → 1 (/work/a → /work/b)
    await Promise.resolve(); // let the fire-and-forget refreshOverview run
    expect(ctx.getOverview).toHaveBeenCalledWith('/work/b');
  });

  it('renders live detail to the touch strip (name + counts + mean-progress bar)', () => {
    const ctx = makeStore(); // 2 builders (progress 45, 70), 1 blocked
    multiWorkspace(ctx);
    const action = { isDial: () => true, isKey: () => false, setFeedback: vi.fn(), setTitle: vi.fn() };
    new ZoomNav(ctx.store).onWillAppear({ action, payload: { settings: {} } } as never);
    const fb = action.setFeedback.mock.calls[0][0] as { title: string; value: string; bar: number };
    expect(fb.title).toContain('a');   // workspace name
    expect(fb.value).toContain('2');   // builder count
    expect(fb.value).toContain('⚠');   // one pending gate
    expect(fb.bar).toBe(58);           // round((45 + 70) / 2)
  });

  it('renders the builder altitude as workspace (line 1) / builder (line 2) / progress', () => {
    const ctx = makeStore();
    ctx.store.setLevel('builders'); // cursor.builder = 0 → pir-1
    const action = { isDial: () => true, isKey: () => false, setFeedback: vi.fn(), setTitle: vi.fn() };
    new ZoomNav(ctx.store).onWillAppear({ action, payload: { settings: {} } } as never);
    const fb = action.setFeedback.mock.calls[0][0] as { title: string; value: string; bar: number };
    expect(fb.title).toBe('⌂ alpha');             // line 1 = workspace name
    expect(fb.value).toBe('1/2 #101 · plan review'); // line 2 = position · id · phase
    expect(fb.bar).toBe(45);                       // builder progress
  });

  it('Diff dials show the function (line 1) + issue details (line 2) + progress', () => {
    const ctx = makeStore(); // selected builder (cursor 0) → pir-1 (#101, "Add the relay", 45%)
    const fileAction = { isDial: () => true, setFeedback: vi.fn() };
    const hunkAction = { isDial: () => true, setFeedback: vi.fn() };
    new DiffFileNav(ctx.store).onWillAppear({ action: fileAction, payload: {} } as never);
    new DiffHunkNav(ctx.store).onWillAppear({ action: hunkAction, payload: {} } as never);
    expect(fileAction.setFeedback).toHaveBeenCalledWith({ title: 'Files', value: '#101 Add the relay', bar: 45 });
    expect(hunkAction.setFeedback).toHaveBeenCalledWith({ title: 'Changes', value: '#101 Add the relay', bar: 45 });
  });

  it('clears the previous workspace overview immediately on switch (no stale flash)', () => {
    const ctx = makeStore();
    multiWorkspace(ctx);
    expect(ctx.store.overview).not.toBeNull();
    ctx.store.rotateCursor(1); // workspace 0 → 1, triggers re-fetch
    expect(ctx.store.overview).toBeNull();      // dropped synchronously, before the fetch
    expect(ctx.store.loadingOverview).toBe(true);
  });
});
