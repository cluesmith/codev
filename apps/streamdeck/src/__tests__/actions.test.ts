import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodevStore } from '../store.js';
import type { ControllerClient, TowerWorkspace } from '@cluesmith/codev-sdk/controller';
import {
  CodevAction,
  DevServerAction,
  BuilderAction,
  ApproveGate,
  SendQueueAction,
  OpenTerminalAction,
  PrNav,
  SpawnNav,
  DiffFileNav,
  DiffHunkNav,
  ScrollNav,
  ZoomNav,
  zoomInVerb,
  phaseArtifactVerb,
  reviewMode,
} from '../actions.js';

type Sent = { verb: string; args: unknown[]; ws?: string };
type CanvasSent = { command: string; target: { workspace: string; file?: string }; count?: number };

/** A full TowerWorkspace fixture (the sdk type carries proxyUrl + terminals on top of the old WorkspaceSummary). */
function workspace(path: string, name: string, active: boolean): TowerWorkspace {
  return { path, name, active, proxyUrl: `http://localhost:4100/proxy/${name}`, terminals: 0 };
}

function makeStore() {
  const sent: Sent[] = [];
  const canvasSent: CanvasSent[] = [];
  const opened: string[] = [];
  const getOverview = vi.fn(async (_ws?: string) => null);
  const listWorkspaces = vi.fn(async () => []);
  // A canvas verdict the test can override to exercise the per-code feedback lines.
  const canvasResult = { value: { ok: true, target: { viewId: 'v1', file: '/f.md' } } as unknown };
  const client = {
    sendCommand: vi.fn((verb: string, args: unknown[] = [], ws?: string) => {
      sent.push({ verb, args, ws });
      return Promise.resolve({ ok: true, status: 200, data: { ok: true } });
    }),
    sendCanvasCommand: vi.fn((command: string, target: { workspace: string; file?: string }, options?: { count?: number }) => {
      canvasSent.push({ command, target, count: options?.count });
      return Promise.resolve(canvasResult.value);
    }),
    getOverview,
    listWorkspaces,
  } as unknown as ControllerClient;
  const store = new CodevStore({ client, openUrl: (u) => { opened.push(u); } });
  store.workspaces = [workspace('/work/alpha', 'alpha', true)];
  store.overview = {
    builders: [
      { id: 'pir-1', roleId: 'builder-pir-1', issueId: '101', issueTitle: 'Add the relay', blocked: 'plan review', blockedGate: 'plan-approval', protocolPhase: 'plan', progress: 45, worktreePath: '/work/alpha/.builders/pir-1' },
      { id: 'pir-2', roleId: 'builder-pir-2', issueId: '102', issueTitle: 'Wire the dial', blocked: null, blockedGate: null, protocolPhase: 'implement', progress: 70, worktreePath: '/work/alpha/.builders/pir-2' },
    ],
    pendingPRs: [{ id: '7', title: 'Fix', url: 'https://gh/pr/7' }],
    backlog: [{ id: '55', title: 'Add X' }],
    recentlyClosed: [],
  } as never;
  return { store, sent, canvasSent, canvasResult, opened, getOverview, listWorkspaces };
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
    // Success is silent now (no green checkmark); only failures alert.
    expect(ev.action.showOk).not.toHaveBeenCalled();
    expect(ev.action.showAlert).not.toHaveBeenCalled();
  });

  it('DevServerAction renders a composite face (play icon + "Dev" label), not a bare icon', () => {
    const key = { isKey: () => true, setImage: vi.fn(), setTitle: vi.fn() };
    new DevServerAction(ctx.store).onWillAppear({ action: key, payload: { settings: {} } } as never);
    const arg = String(key.setImage.mock.calls.at(-1)?.[0] ?? '');
    expect(arg.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const face = Buffer.from(arg.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    expect(face).toContain('Dev');
    expect(face).toContain('M8 5v14l11-7z'); // play glyph
  });

  it('CodevAction honors a settings verb override', async () => {
    await new CodevAction(ctx.store).onKeyDown(keyEvent({ verb: 'new-shell' }) as never);
    expect(ctx.sent[0].verb).toBe('new-shell');
  });

  it('BuilderAction defaults to Automatic — opens slot 1 builder’s current-phase artifact', async () => {
    // pir-1 is blocked at plan-approval → Automatic resolves to open-plan.
    await new BuilderAction(ctx.store).onKeyDown(keyEvent() as never);
    expect(ctx.sent[0]).toEqual({ verb: 'open-plan', args: ['pir-1'], ws: '/work/alpha' });
  });

  it('BuilderAction Automatic falls back to open-terminal for an unknown-state builder', async () => {
    ctx.store.overview = { builders: [{ id: 'pir-x', roleId: null, issueId: null, issueTitle: null, blocked: null, blockedGate: null, protocolPhase: '', progress: 0, worktreePath: '/w' }], pendingPRs: [], backlog: [], recentlyClosed: [] } as never;
    await new BuilderAction(ctx.store).onKeyDown(keyEvent() as never);
    expect(ctx.sent[0]).toEqual({ verb: 'open-terminal', args: ['pir-x'], ws: '/work/alpha' });
  });

  it('BuilderAction with an explicit verb fires it verbatim, ignoring phase', async () => {
    await new BuilderAction(ctx.store).onKeyDown(keyEvent({ slot: '2', verb: 'open-terminal' }) as never);
    expect(ctx.sent[0]).toEqual({ verb: 'open-terminal', args: ['pir-2'], ws: '/work/alpha' });
  });

  it('BuilderAction Automatic opens the FIRST file diff (dial-ready), not the aggregate, for a diff-phase builder (#1414)', async () => {
    // pir-2 is in `implement` → the phase artifact is the diff; Automatic remaps it to
    // `open-diff-first` so the SD+ dials step from file 1, never `view-diff` (aggregate).
    await new BuilderAction(ctx.store).onKeyDown(keyEvent({ slot: '2' }) as never);
    expect(ctx.sent[0]).toEqual({ verb: 'open-diff-first', args: ['pir-2'], ws: '/work/alpha' });
  });

  it('BuilderAction explicit "View Diff" still fires view-diff (aggregate) verbatim (#1414)', async () => {
    // The PI View Diff option is unchanged: only Automatic remaps to open-diff-first.
    await new BuilderAction(ctx.store).onKeyDown(keyEvent({ slot: '2', verb: 'view-diff' }) as never);
    expect(ctx.sent[0]).toEqual({ verb: 'view-diff', args: ['pir-2'], ws: '/work/alpha' });
  });

  it('BuilderAction press selects the slot builder (cursor follows)', async () => {
    await new BuilderAction(ctx.store).onKeyDown(keyEvent({ slot: '2' }) as never);
    expect(ctx.store.selectedBuilder()?.id).toBe('pir-2');
  });
});

describe('slot keys', () => {
  it('a slot past the end of the builder list alerts and sends nothing', async () => {
    const ctx = makeStore(); // only 2 builders
    const ev = keyEvent({ slot: '8' });
    await new BuilderAction(ctx.store).onKeyDown(ev as never);
    expect(ctx.sent).toHaveLength(0);
    expect(ev.action.showAlert).toHaveBeenCalled();
  });

  // One SingletonAction instance serves every key of its type — these guard the
  // per-instance fix (without it, all keys collided on shared state).
  const slotKey = (id: string) => ({ id, isKey: () => true, setImage: vi.fn(), setTitle: vi.fn() });

  // renderTo hands setImage a base64 data URI (Stream Deck drops raw SVG strings); decode to
  // assert on the underlying face.
  const decodeFace = (action: { setImage: { mock: { calls: unknown[][] } } }): string => {
    const arg = String(action.setImage.mock.calls.at(-1)?.[0] ?? '');
    expect(arg.startsWith('data:image/svg+xml;base64,')).toBe(true);
    return Buffer.from(arg.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
  };

  it('renders each slot key against its own slot (different slots → different builders)', () => {
    const ctx = makeStore(); // pir-1 (#101), pir-2 (#102)
    const ba = new BuilderAction(ctx.store);
    const a = slotKey('A');
    const b = slotKey('B');
    ba.onWillAppear({ action: a, payload: { settings: { slot: '1' } } } as never);
    ba.onWillAppear({ action: b, payload: { settings: { slot: '2' } } } as never);
    // The face is now a composite SVG handed to setImage (not a title).
    expect(decodeFace(a)).toContain('#101');
    expect(decodeFace(b)).toContain('#102');
  });

  it('renders the builder’s state as a colour-coded, mapped face (mirrors the sidebar)', () => {
    const ctx = makeStore(); // pir-1 blocked plan-approval, pir-2 phase "implement"
    const ba = new BuilderAction(ctx.store);
    const a = slotKey('A');
    const b = slotKey('B');
    ba.onWillAppear({ action: a, payload: { settings: { slot: '1' } } } as never);
    ba.onWillAppear({ action: b, payload: { settings: { slot: '2' } } } as never);
    // Blocked at plan-approval → mapped label "Plan" in warning yellow (not the wire "plan review").
    const aSvg = decodeFace(a);
    expect(aSvg).toContain('>Plan<');
    expect(aSvg).toContain('#cca700');
    // Active → phase label "Implement" in green.
    const bSvg = decodeFace(b);
    expect(bSvg).toContain('>Implement<');
    expect(bSvg).toContain('#73c991');
  });

  it('renders the empty-slot face when no builder occupies the slot', () => {
    const ctx = makeStore(); // only 2 builders → slot 5 is empty
    const ba = new BuilderAction(ctx.store);
    const a = slotKey('A');
    ba.onWillAppear({ action: a, payload: { settings: { slot: '5' } } } as never);
    expect(decodeFace(a)).toContain('Slot 5');
  });

  it('re-renders every slot key on a store change (fixes stale-on-workspace-switch)', () => {
    const ctx = makeStore();
    const ba = new BuilderAction(ctx.store);
    const a = slotKey('A');
    const b = slotKey('B');
    ba.onWillAppear({ action: a, payload: { settings: { slot: '1' } } } as never);
    ba.onWillAppear({ action: b, payload: { settings: { slot: '2' } } } as never);
    a.setImage.mockClear();
    b.setImage.mockClear();
    ctx.store.setLevel('builders'); // any store change → onChange → render all keys
    expect(a.setImage).toHaveBeenCalled();
    expect(b.setImage).toHaveBeenCalled();
  });
});

describe('ApproveGate (Row 2 — selected-scoped, #1410)', () => {
  it('fires approve-gate for the SELECTED builder (not the top pending gate)', async () => {
    const ctx = makeStore(); // selection defaults to pir-1 (blocked at plan-approval)
    await new ApproveGate(ctx.store).onKeyDown(keyEvent() as never);
    expect(ctx.sent[0]).toEqual({ verb: 'approve-gate', args: ['pir-1'], ws: '/work/alpha' });
  });

  it('acts on whoever is selected: after selecting pir-2 it would target pir-2', async () => {
    const ctx = makeStore();
    // Block pir-2 too, then select it — the key must follow the selection, not pir-1.
    ctx.store.overview!.builders[1] = { ...ctx.store.overview!.builders[1], blockedGate: 'dev-approval' } as never;
    ctx.store.syncToBuilder('pir-2');
    await new ApproveGate(ctx.store).onKeyDown(keyEvent() as never);
    expect(ctx.sent[0]).toEqual({ verb: 'approve-gate', args: ['pir-2'], ws: '/work/alpha' });
  });

  it('alerts and sends nothing when the selected builder is not blocked at a gate', async () => {
    const ctx = makeStore();
    ctx.store.syncToBuilder('pir-2'); // pir-2 is not blocked (blockedGate: null)
    const ev = keyEvent();
    await new ApproveGate(ctx.store).onKeyDown(ev as never);
    expect(ctx.sent).toHaveLength(0);
    expect(ev.action.showAlert).toHaveBeenCalled();
  });

  it('renders the selected builder’s pending gate on the Approve face', () => {
    const ctx = makeStore(); // pir-1 selected, blocked at plan-approval
    const key = { id: 'G', isKey: () => true, setImage: vi.fn(), setTitle: vi.fn() };
    new ApproveGate(ctx.store).onWillAppear({ action: key, payload: {} } as never);
    const arg = String(key.setImage.mock.calls.at(-1)?.[0] ?? '');
    expect(arg.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const face = Buffer.from(arg.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    expect(face).toContain('Plan');    // the selected builder's gate label
    expect(face).toContain('Approve'); // the action band
    expect(face).toContain('#cca700'); // blocked → warning yellow
    expect(key.setTitle).toHaveBeenCalledWith(''); // title layer suppressed
  });
});

describe('SendQueueAction (Row 2 — flush, #1410)', () => {
  it('badges the selected builder’s queued count and flushes on press', async () => {
    const ctx = makeStore();
    ctx.store.overview = { ...ctx.store.overview!, queuedFeedback: { 'pir-1': 3 } } as never;
    const key = { id: 'S', isKey: () => true, setImage: vi.fn(), setTitle: vi.fn(), showOk: vi.fn(), showAlert: vi.fn() };
    const action = new SendQueueAction(ctx.store);
    action.onWillAppear({ action: key, payload: {} } as never);
    const face = Buffer.from(String(key.setImage.mock.calls.at(-1)?.[0]).split(',')[1], 'base64').toString('utf8');
    expect(face).toContain('Send Fb');
    expect(face).toContain('>3<'); // badge
    await action.onKeyDown({ action: key, payload: { settings: {} } } as never);
    expect(ctx.sent[0]).toEqual({ verb: 'send-queue', args: ['pir-1'], ws: '/work/alpha' });
  });

  it('is inert (alerts, sends nothing) when the selected builder has no queued feedback', async () => {
    const ctx = makeStore(); // no queuedFeedback on the fixture → 0
    const key = { id: 'S', isKey: () => true, setImage: vi.fn(), setTitle: vi.fn(), showOk: vi.fn(), showAlert: vi.fn() };
    await new SendQueueAction(ctx.store).onKeyDown({ action: key, payload: { settings: {} } } as never);
    expect(ctx.sent).toHaveLength(0);
    expect(key.showAlert).toHaveBeenCalled();
  });
});

describe('OpenTerminalAction (Row 2 — per-builder, #1410)', () => {
  it('opens the selected builder’s terminal', async () => {
    const ctx = makeStore();
    ctx.store.syncToBuilder('pir-2');
    await new OpenTerminalAction(ctx.store).onKeyDown(keyEvent() as never);
    expect(ctx.sent[0]).toEqual({ verb: 'open-terminal', args: ['pir-2'], ws: '/work/alpha' });
  });

  it('renders the composite face (terminal glyph + selected number over a Terminal band)', () => {
    const ctx = makeStore();
    ctx.store.syncToBuilder('pir-2'); // issueId 102
    const key = { id: 'T', isKey: () => true, setImage: vi.fn(), setTitle: vi.fn() };
    new OpenTerminalAction(ctx.store).onWillAppear({ action: key, payload: {} } as never);
    const face = Buffer.from(String(key.setImage.mock.calls.at(-1)?.[0]).split(',')[1], 'base64').toString('utf8');
    expect(face).toContain('Terminal');
    expect(face).toContain('#102'); // the selected builder's number
    expect(key.setTitle).toHaveBeenCalledWith(''); // title layer suppressed
  });

  it('is inert (alerts, sends nothing) when no builder is selected', async () => {
    const ctx = makeStore();
    ctx.store.overview = { builders: [], pendingPRs: [], backlog: [], recentlyClosed: [] } as never;
    const key = { id: 'T', isKey: () => true, setImage: vi.fn(), setTitle: vi.fn(), showOk: vi.fn(), showAlert: vi.fn() };
    await new OpenTerminalAction(ctx.store).onKeyDown({ action: key, payload: { settings: {} } } as never);
    expect(ctx.sent).toHaveLength(0);
    expect(key.showAlert).toHaveBeenCalled();
  });
});

describe('Row 1 windowing (#1410)', () => {
  /** A store with `n` builders (ids builder-0..builder-(n-1)), selection at `cursor`. */
  function windowedStore(n: number, cursor: number) {
    const ctx = makeStore();
    ctx.store.overview = {
      builders: Array.from({ length: n }, (_, i) => ({
        id: `b${i}`, roleId: `builder-b${i}`, issueId: String(100 + i), issueTitle: `Task ${i}`,
        blocked: null, blockedGate: null, protocolPhase: 'implement', progress: 0, worktreePath: `/w/b${i}`,
      })),
      pendingPRs: [], backlog: [], recentlyClosed: [],
    } as never;
    ctx.store.cursor = { ...ctx.store.cursor, builder: cursor, level: 'builders' };
    return ctx.store;
  }

  it('slot i shows builder i on page 0 (first four)', () => {
    const store = windowedStore(10, 0);
    expect([0, 1, 2, 3].map((i) => store.windowedBuilder(i)?.id)).toEqual(['b0', 'b1', 'b2', 'b3']);
  });

  it('scrolls a page when the selection moves past the fourth builder', () => {
    const store = windowedStore(10, 4); // selection on b4 → page 1
    expect([0, 1, 2, 3].map((i) => store.windowedBuilder(i)?.id)).toEqual(['b4', 'b5', 'b6', 'b7']);
  });

  it('trailing slots are empty on a partial last page', () => {
    const store = windowedStore(10, 9); // selection on b9 → page 2 (b8, b9, -, -)
    expect([0, 1, 2, 3].map((i) => store.windowedBuilder(i)?.id)).toEqual(['b8', 'b9', undefined, undefined]);
  });

  it('BuilderAction renders the windowed builder and accents the selected slot', () => {
    const store = windowedStore(10, 5); // page 1: slots show b4..b7; b5 is selected (slot 1)
    const render = (slot: string) => {
      const key = { id: `k${slot}`, isKey: () => true, setImage: vi.fn(), setTitle: vi.fn() };
      new BuilderAction(store).onWillAppear({ action: key, payload: { settings: { slot } } } as never);
      return Buffer.from(String(key.setImage.mock.calls.at(-1)?.[0]).split(',')[1], 'base64').toString('utf8');
    };
    expect(render('1')).toContain('#104'); // slot 1 → b4 (issueId 104)
    expect(render('2')).toContain('#105'); // slot 2 → b5 (selected)
    expect(render('2')).toContain('stroke-width="3"'); // selected accent ring
    expect(render('1')).not.toContain('stroke-width="3"'); // unselected slot has no ring
  });
});

describe('store readers (#1410)', () => {
  it('feedbackMode defaults to forward, reads queue from the overview', () => {
    const ctx = makeStore();
    expect(ctx.store.feedbackMode()).toBe('forward');
    ctx.store.overview = { ...ctx.store.overview!, feedbackMode: 'queue' } as never;
    expect(ctx.store.feedbackMode()).toBe('queue');
  });

  it('queuedFeedback reads the per-builder map, 0 when absent', () => {
    const ctx = makeStore();
    expect(ctx.store.queuedFeedback('pir-1')).toBe(0);
    ctx.store.overview = { ...ctx.store.overview!, queuedFeedback: { 'pir-1': 5 } } as never;
    expect(ctx.store.queuedFeedback('pir-1')).toBe(5);
    expect(ctx.store.queuedFeedback('pir-2')).toBe(0);
    expect(ctx.store.queuedFeedback(undefined)).toBe(0);
  });
});

describe('encoders', () => {
  it('DiffFileNav in diff mode: rotate navigates, press submits feedback, touch jumps to first', async () => {
    const ctx = makeStore();
    ctx.store.syncToBuilder('pir-2'); // implement phase → diff mode
    const nav = new DiffFileNav(ctx.store);
    await nav.onDialRotate(dial(1) as never);   // next
    await nav.onDialRotate(dial(-2) as never);  // prev
    await nav.onDialDown();                      // submit feedback (mode-neutral)
    await nav.onTouchTap();                       // first
    expect(ctx.sent.map((s) => s.verb)).toEqual(['diff-next-file', 'diff-prev-file', 'feedback-file', 'diff-first-file']);
    expect(ctx.sent.every((s) => s.ws === '/work/alpha')).toBe(true);
    expect(ctx.canvasSent).toHaveLength(0); // diff mode never touches the canvas channel
  });

  it('Diff dials submit their axis as feedback on a dial press (diff mode, #1410)', async () => {
    const ctx = makeStore();
    ctx.store.syncToBuilder('pir-2'); // implement phase → diff mode
    await new DiffFileNav(ctx.store).onDialDown();
    await new DiffHunkNav(ctx.store).onDialDown();
    expect(ctx.sent.map((s) => s.verb)).toEqual(['feedback-file', 'feedback-hunk']);
  });

  it('canvas mode: coarse dial rotates headings (count = |ticks|), press cancels composer, tap resets to doc start', async () => {
    const ctx = makeStore(); // default selection pir-1 is blocked at plan-approval → canvas mode
    const nav = new DiffFileNav(ctx.store);
    await nav.onDialRotate(dial(3) as never);   // heading-next, count 3
    await nav.onDialRotate(dial(-1) as never);  // heading-prev, count 1
    await nav.onDialDown();                      // composer-cancel (#1425)
    await nav.onTouchTap();                       // doc-start
    expect(ctx.canvasSent).toEqual([
      { command: 'heading-next', target: { workspace: '/work/alpha' }, count: 3 },
      { command: 'heading-prev', target: { workspace: '/work/alpha' }, count: 1 },
      { command: 'composer-cancel', target: { workspace: '/work/alpha' }, count: undefined },
      { command: 'doc-start', target: { workspace: '/work/alpha' }, count: undefined },
    ]);
    expect(ctx.sent).toHaveLength(0); // canvas mode never touches the generic verb relay
  });

  it('canvas mode: fine dial rotates blocks, press submits/opens composer, tap walks forward through comments', async () => {
    const ctx = makeStore(); // pir-1 → canvas mode
    const nav = new DiffHunkNav(ctx.store);
    await nav.onDialRotate(dial(2) as never);   // block-next, count 2
    await nav.onDialDown();                      // composer-open-or-submit (#1425)
    await nav.onTouchTap();                       // comment-next
    expect(ctx.canvasSent).toEqual([
      { command: 'block-next', target: { workspace: '/work/alpha' }, count: 2 },
      { command: 'composer-open-or-submit', target: { workspace: '/work/alpha' }, count: undefined },
      { command: 'comment-next', target: { workspace: '/work/alpha' }, count: undefined },
    ]);
  });

  it('canvas targeting omits file (MRU): the target carries only the workspace', async () => {
    const ctx = makeStore();
    await new DiffFileNav(ctx.store).onDialRotate(dial(1) as never);
    expect(ctx.canvasSent[0].target).toEqual({ workspace: '/work/alpha' });
    expect('file' in ctx.canvasSent[0].target).toBe(false);
  });

  it('a failed canvas command renders its per-code reason on the touchstrip', async () => {
    const ctx = makeStore();
    ctx.canvasResult.value = { ok: false, code: 'no-canvas', error: 'no canvas open' };
    const action = dial(1).action;
    const nav = new DiffFileNav(ctx.store);
    nav.onWillAppear({ action, payload: {} } as never);
    await nav.onDialRotate({ action, payload: { ticks: 1, settings: {} } } as never);
    const last = action.setFeedback.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ title: 'Headings · Cancel', value: 'Open artifact' });

    ctx.canvasResult.value = { ok: false, code: 'unreachable', error: 'Tower down' };
    await nav.onDialDown();
    expect(action.setFeedback.mock.calls.at(-1)?.[0]).toMatchObject({ value: 'Tower offline' });
  });

  it('a canvas gesture with no active workspace is a no-op', async () => {
    const ctx = makeStore();
    ctx.store.workspaces = []; // selectedWorkspacePath() → undefined
    await new DiffFileNav(ctx.store).onDialRotate(dial(1) as never);
    expect(ctx.canvasSent).toHaveLength(0);
  });

  it('none mode (unknown-phase builder): rotate/press/tap send nothing on either channel', async () => {
    const ctx = makeStore();
    // A builder with no live status → phaseArtifactVerb undefined → reviewMode 'none'.
    ctx.store.overview = {
      builders: [{ id: 'pir-x', roleId: null, issueId: null, issueTitle: null, blocked: null, blockedGate: null, protocolPhase: '', progress: 0, worktreePath: '/w' }],
      pendingPRs: [], backlog: [], recentlyClosed: [],
    } as never;
    const nav = new DiffFileNav(ctx.store);
    await nav.onDialRotate(dial(1) as never);
    await nav.onDialDown();
    await nav.onTouchTap();
    expect(ctx.sent).toHaveLength(0);        // no diff verbs
    expect(ctx.canvasSent).toHaveLength(0);  // no canvas commands
  });

  it('none mode (no builder): the dials are inert', async () => {
    const ctx = makeStore();
    ctx.store.overview = { builders: [], pendingPRs: [], backlog: [], recentlyClosed: [] } as never;
    const nav = new DiffHunkNav(ctx.store);
    await nav.onDialRotate(dial(1) as never);
    await nav.onDialDown();
    await nav.onTouchTap();
    expect(ctx.sent).toHaveLength(0);
    expect(ctx.canvasSent).toHaveLength(0);
  });

  it('ScrollNav scrolls the editor on rotate and submits the selection as feedback on press', async () => {
    const ctx = makeStore();
    const nav = new ScrollNav(ctx.store);
    await nav.onDialRotate(dial(1) as never);  // down
    await nav.onDialRotate(dial(-1) as never); // up
    await nav.onDialDown();
    expect(ctx.sent[0]).toEqual({ verb: 'scroll', args: [{ to: 'down', by: 'line', value: 3, revealCursor: false }], ws: '/work/alpha' });
    expect((ctx.sent[1].args[0] as { to: string }).to).toBe('up');
    expect(ctx.sent[2]).toEqual({ verb: 'feedback-selection', args: [], ws: '/work/alpha' });
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
    workspace('/work/a', 'a', true),
    workspace('/work/b', 'b', false),
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

describe('CodevStore active-workspace filtering', () => {
  const mixed = () => [
    workspace('/work/a', 'a', true),
    workspace('/work/dormant', 'dormant', false),
    workspace('/work/b', 'b', true),
  ];

  it('refresh() stores only active workspaces, so the zoom dial cycles active ones alone', async () => {
    const ctx = makeStore();
    ctx.listWorkspaces.mockResolvedValue(mixed() as never);
    await ctx.store.refresh();
    expect(ctx.store.workspaces.map((w) => w.path)).toEqual(['/work/a', '/work/b']);

    // The cursor cycles only the two active entries (clamped, never the dormant one).
    expect(ctx.store.selectedWorkspacePath()).toBe('/work/a');
    ctx.store.rotateCursor(1);
    expect(ctx.store.selectedWorkspacePath()).toBe('/work/b');
    ctx.store.rotateCursor(1); // clamped at the end of the 2-entry active list
    expect(ctx.store.selectedWorkspacePath()).toBe('/work/b');
    ctx.store.rotateCursor(-1);
    expect(ctx.store.selectedWorkspacePath()).toBe('/work/a'); // back to the first active, dormant skipped
  });

  it('clamps the cursor to a valid index when the selected workspace deactivates', async () => {
    const ctx = makeStore();
    // Start on the second of two active workspaces.
    ctx.listWorkspaces.mockResolvedValueOnce([
      workspace('/work/a', 'a', true),
      workspace('/work/b', 'b', true),
    ] as never);
    await ctx.store.refresh();
    ctx.store.rotateCursor(1);
    expect(ctx.store.cursor.workspace).toBe(1);

    // /work/b goes dormant; the next refresh drops it and the cursor snaps back.
    ctx.listWorkspaces.mockResolvedValueOnce([
      workspace('/work/a', 'a', true),
    ] as never);
    await ctx.store.refresh();
    expect(ctx.store.workspaces.map((w) => w.path)).toEqual(['/work/a']);
    expect(ctx.store.cursor.workspace).toBe(0);
    expect(ctx.store.selectedWorkspacePath()).toBe('/work/a'); // valid, not past the end
  });

  it('resets the deeper cursor indices when the clamp fires (new workspace has its own builders)', async () => {
    const ctx = makeStore();
    ctx.listWorkspaces.mockResolvedValueOnce([
      workspace('/work/a', 'a', true),
      workspace('/work/b', 'b', true),
    ] as never);
    await ctx.store.refresh();
    ctx.store.rotateCursor(1); // → workspace 1
    ctx.store.cursor.builder = 3; // pretend we were deep in /work/b's builders
    ctx.store.cursor.file = 2;

    ctx.listWorkspaces.mockResolvedValueOnce([workspace('/work/a', 'a', true)] as never);
    await ctx.store.refresh(); // /work/b deactivates → clamp back to /work/a
    expect(ctx.store.cursor.workspace).toBe(0);
    expect(ctx.store.cursor.builder).toBe(0); // not left pointing into /work/b's builder list
    expect(ctx.store.cursor.file).toBe(0);
  });

  it('does not fetch an overview when no workspace is active (avoids Tower dormant fallback)', async () => {
    const ctx = makeStore();
    ctx.listWorkspaces.mockResolvedValue([workspace('/work/dormant', 'dormant', false)] as never);
    await ctx.store.refresh();
    expect(ctx.store.workspaces).toEqual([]);
    expect(ctx.store.overview).toBeNull();
    expect(ctx.store.loadingOverview).toBe(false);
    expect(ctx.getOverview).not.toHaveBeenCalled(); // never asked Tower for an undefined-path overview
  });

  it('syncToWorkspace treats a dormant registration like an unknown path (no-op)', async () => {
    const ctx = makeStore();
    ctx.store.workspaces = [workspace('/work/a', 'a', true)];
    // Tower still lists the dormant one, but the fetch filters it out, so the
    // focus-follow finds no match and leaves the cursor put.
    ctx.listWorkspaces.mockResolvedValue(mixed() as never);
    await ctx.store.syncToWorkspace('/work/dormant');
    expect(ctx.store.cursor.workspace).toBe(0); // unchanged
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

describe('phaseArtifactVerb (shared resolver — recognised verb or undefined)', () => {
  const b = (over: Record<string, unknown>) => ({ id: 'x', blockedGate: null, protocolPhase: '', ...over }) as never;
  it('maps the specify/plan phases and their gates to the document', () => {
    expect(phaseArtifactVerb(b({ blockedGate: 'spec-approval' }))).toBe('open-spec');
    expect(phaseArtifactVerb(b({ protocolPhase: 'specify' }))).toBe('open-spec');
    expect(phaseArtifactVerb(b({ blockedGate: 'plan-approval' }))).toBe('open-plan');
    expect(phaseArtifactVerb(b({ protocolPhase: 'plan' }))).toBe('open-plan');
  });
  it('maps implement/review/verify and the dev-approval/pr gates to the diff', () => {
    expect(phaseArtifactVerb(b({ protocolPhase: 'implement' }))).toBe('view-diff');
    expect(phaseArtifactVerb(b({ protocolPhase: 'review' }))).toBe('view-diff');
    expect(phaseArtifactVerb(b({ protocolPhase: 'verify' }))).toBe('view-diff');
    expect(phaseArtifactVerb(b({ blockedGate: 'dev-approval' }))).toBe('view-diff');
    expect(phaseArtifactVerb(b({ blockedGate: 'pr' }))).toBe('view-diff');
  });
  it('gate beats phase (the stronger signal)', () => {
    expect(phaseArtifactVerb(b({ blockedGate: 'plan-approval', protocolPhase: 'implement' }))).toBe('open-plan');
  });
  it('returns undefined for an unknown gate or no live status — the caller picks the fallback', () => {
    expect(phaseArtifactVerb(b({}))).toBeUndefined();
    expect(phaseArtifactVerb(b({ blockedGate: 'some-future-gate' }))).toBeUndefined();
    expect(phaseArtifactVerb(b({ protocolPhase: 'mystery' }))).toBeUndefined();
    // The two callers diverge exactly here: dial → view-diff, Builder Action → open-terminal.
    expect(zoomInVerb(b({}))).toBe('view-diff');
  });
});

describe('reviewMode (dial mode from the shared resolver)', () => {
  const b = (over: Record<string, unknown>) => ({ id: 'x', blockedGate: null, protocolPhase: '', ...over }) as never;
  it('spec/plan phases and their gates → canvas', () => {
    expect(reviewMode(b({ blockedGate: 'spec-approval' }))).toBe('canvas');
    expect(reviewMode(b({ protocolPhase: 'specify' }))).toBe('canvas');
    expect(reviewMode(b({ blockedGate: 'plan-approval' }))).toBe('canvas');
    expect(reviewMode(b({ protocolPhase: 'plan' }))).toBe('canvas');
  });
  it('implement/review/verify and the dev-approval/pr gates → diff', () => {
    expect(reviewMode(b({ protocolPhase: 'implement' }))).toBe('diff');
    expect(reviewMode(b({ protocolPhase: 'review' }))).toBe('diff');
    expect(reviewMode(b({ blockedGate: 'dev-approval' }))).toBe('diff');
    expect(reviewMode(b({ blockedGate: 'pr' }))).toBe('diff');
  });
  it('an unknown phase, no live status, or no builder → none', () => {
    expect(reviewMode(b({}))).toBe('none');
    expect(reviewMode(b({ protocolPhase: 'mystery' }))).toBe('none');
    expect(reviewMode(undefined)).toBe('none');
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
      workspace('/work/a', 'a', true),
      workspace('/work/b', 'b', false),
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

  it('legibility: canvas-phase dials pair the rotate axis with the press meaning (#1425)', () => {
    const ctx = makeStore(); // selected builder (cursor 0) → pir-1, blocked at plan-approval → canvas
    const fileAction = { isDial: () => true, setFeedback: vi.fn() };
    const hunkAction = { isDial: () => true, setFeedback: vi.fn() };
    new DiffFileNav(ctx.store).onWillAppear({ action: fileAction, payload: {} } as never);
    new DiffHunkNav(ctx.store).onWillAppear({ action: hunkAction, payload: {} } as never);
    // Coarse dial cancels; fine dial opens/submits. Line 2 stays the builder under review.
    expect(fileAction.setFeedback).toHaveBeenCalledWith({ title: 'Headings · Cancel', value: '#101 Add the relay', bar: 45 });
    expect(hunkAction.setFeedback).toHaveBeenCalledWith({ title: 'Blocks · Open/Submit', value: '#101 Add the relay', bar: 45 });
  });

  it('legibility: diff-phase builder titles the dials with axis + delivery mode (Files · send)', () => {
    const ctx = makeStore(); // no feedbackMode on the fixture → defaults to forward → "send"
    ctx.store.syncToBuilder('pir-2'); // implement phase → diff mode (#102, "Wire the dial", 70%)
    const fileAction = { isDial: () => true, setFeedback: vi.fn() };
    const hunkAction = { isDial: () => true, setFeedback: vi.fn() };
    new DiffFileNav(ctx.store).onWillAppear({ action: fileAction, payload: {} } as never);
    new DiffHunkNav(ctx.store).onWillAppear({ action: hunkAction, payload: {} } as never);
    expect(fileAction.setFeedback).toHaveBeenCalledWith({ title: 'Files · send', value: '#102 Wire the dial', bar: 70 });
    expect(hunkAction.setFeedback).toHaveBeenCalledWith({ title: 'Changes · send', value: '#102 Wire the dial', bar: 70 });
  });

  it('legibility: the diff touchstrip names the queue mode when the workspace queues (Files · queue)', () => {
    const ctx = makeStore();
    ctx.store.overview = { ...ctx.store.overview!, feedbackMode: 'queue' } as never;
    ctx.store.syncToBuilder('pir-2'); // diff mode
    const action = { isDial: () => true, setFeedback: vi.fn() };
    new DiffFileNav(ctx.store).onWillAppear({ action, payload: {} } as never);
    expect(action.setFeedback.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'Files · queue' });
  });

  it('legibility: the dial re-titles when the selection moves between modes', () => {
    const ctx = makeStore();
    const action = { isDial: () => true, setFeedback: vi.fn() };
    const nav = new DiffFileNav(ctx.store);
    nav.onWillAppear({ action, payload: {} } as never); // pir-1 → canvas
    expect(action.setFeedback.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'Headings · Cancel' });
    ctx.store.syncToBuilder('pir-2'); // → diff; onChange re-renders
    expect(action.setFeedback.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'Files · send' });
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
