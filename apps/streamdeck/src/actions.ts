import {
  SingletonAction,
  type KeyAction,
  type DialAction,
  type KeyDownEvent,
  type DialRotateEvent,
  type DialDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import type { OverviewBuilder } from '@cluesmith/codev-client';
import type { CodevStore } from './store.js';

/**
 * The Stream Deck actions — thin adapters over CodevStore. Each maps a physical
 * input to a canonical verb (POSTed via the command relay) or a cursor move /
 * URL open. UUIDs are set via the `manifestId` field (no decorators — keeps the
 * esbuild→node bundle free of decorator transpilation). Rendering is title-based
 * for v1 (richer SVG/feedback is a later polish).
 */

/** Optional per-instance verb override from the Property Inspector. */
type VerbSettings = { verb?: string };

function settingsVerb(ev: KeyDownEvent): string | undefined {
  const s = ev.payload.settings as VerbSettings | undefined;
  return typeof s?.verb === 'string' ? s.verb : undefined;
}

async function ack(action: KeyAction, ok: boolean): Promise<void> {
  await (ok ? action.showOk() : action.showAlert());
}

// ── Verb keypads ──────────────────────────────────────────────────────────

/** A keypad that fires one canonical verb (overridable via settings). */
abstract class VerbKey extends SingletonAction<VerbSettings> {
  protected abstract readonly defaultVerb: string;
  constructor(protected readonly store: CodevStore) {
    super();
  }
  /** Verb operands; default none. Builder-scoped keys override with the builder id. */
  protected args(): unknown[] {
    return [];
  }
  override async onKeyDown(ev: KeyDownEvent<VerbSettings>): Promise<void> {
    const verb = settingsVerb(ev) ?? this.defaultVerb;
    const res = await this.store.client.sendCommand(verb, this.args(), this.store.selectedWorkspacePath());
    await ack(ev.action, res.ok);
  }
}

/** Workspace-scoped configurable verb (default: refresh the overview). */
export class CodevAction extends VerbKey {
  override readonly manifestId = 'com.cluesmith.codev.action';
  protected readonly defaultVerb = 'refresh-overview';
}

/** Run the dev server for the cursor-selected builder's worktree (no PI). */
export class DevServerAction extends VerbKey {
  override readonly manifestId = 'com.cluesmith.codev.dev-server';
  protected readonly defaultVerb = 'run-dev';
  protected override args(): unknown[] {
    const b = this.store.selectedBuilder();
    return b ? [b.id] : [];
  }
}

// ── Slot keys (pinned builder board) ────────────────────────────────────────

/** PI settings shared by the slot-based keys: a 1-based builder slot + a verb. */
type SlotSettings = { slot?: string; verb?: string };

/** Resolve the builder a slot points at: slot N → the Nth builder (overview order). */
function slotBuilder(store: CodevStore, settings: SlotSettings): OverviewBuilder | undefined {
  const slot = Number.parseInt(settings.slot ?? '1', 10);
  const index = (Number.isFinite(slot) && slot > 0 ? slot : 1) - 1;
  return store.builders()[index];
}

/**
 * A keypad pinned to a builder slot (the Nth builder) that fires a verb for that
 * builder. The Property Inspector picks the slot and the verb; the press is
 * resilient to builder ids changing because it indexes by position, not id.
 * FleetSlot and BuilderAction differ only in their default verb + title.
 */
abstract class SlotKey extends SingletonAction<SlotSettings> {
  protected abstract readonly defaultVerb: string;
  // One SingletonAction instance serves EVERY key of this type, so per-key state
  // (its settings + render handle) is tracked per instance, keyed by the action
  // context id — never in shared fields, which would collide across keys.
  private readonly keys = new Map<string, { action: KeyAction; settings: SlotSettings }>();

  constructor(protected readonly store: CodevStore) {
    super();
    this.store.onChange(() => this.renderAll());
  }

  override onWillAppear(ev: WillAppearEvent<SlotSettings>): void {
    if (!ev.action.isKey()) return;
    const settings = ev.payload.settings ?? {};
    this.keys.set(ev.action.id, { action: ev.action, settings });
    this.renderTo(ev.action, settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void {
    this.keys.delete(ev.action.id);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): void {
    const entry = this.keys.get(ev.action.id);
    if (!entry) return;
    entry.settings = ev.payload.settings ?? {};
    this.renderTo(entry.action, entry.settings);
  }
  override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
    const settings = ev.payload.settings ?? {};
    const b = slotBuilder(this.store, settings);
    if (!b) {
      await ev.action.showAlert();
      return;
    }
    const verb = settings.verb ?? this.defaultVerb;
    const res = await this.store.client.sendCommand(verb, [b.id], this.store.selectedWorkspacePath());
    await ack(ev.action, res.ok);
  }
  private renderAll(): void {
    for (const { action, settings } of this.keys.values()) this.renderTo(action, settings);
  }
  protected abstract renderTo(action: KeyAction, settings: SlotSettings): void;
}

/** Builder Action: pick a builder slot + a verb; press fires it (default: view diff). */
export class BuilderAction extends SlotKey {
  override readonly manifestId = 'com.cluesmith.codev.builder-action';
  protected readonly defaultVerb = 'view-diff';
  protected renderTo(action: KeyAction, settings: SlotSettings): void {
    const b = slotBuilder(this.store, settings);
    void action.setTitle(b ? (b.issueId ? `#${b.issueId}` : b.id) : `Slot ${settings.slot ?? '1'}`);
  }
}

/** Fleet Slot: a live board key — shows the slot's builder + state; press opens its terminal. */
export class FleetSlot extends SlotKey {
  override readonly manifestId = 'com.cluesmith.codev.fleet-slot';
  protected readonly defaultVerb = 'open-terminal';
  protected renderTo(action: KeyAction, settings: SlotSettings): void {
    const b = slotBuilder(this.store, settings);
    void action.setTitle(
      b ? `${b.issueId ? `#${b.issueId}` : b.id}\n${b.blocked ?? b.protocolPhase}` : `Slot ${settings.slot ?? '1'}`,
    );
  }
}

/**
 * Approve-gate key: a read-only badge of the pending-gate count, and on press a
 * jump-to-review — it fires `approve-gate` for the top pending gate, which the
 * provider surfaces as a confirmation modal (it does NOT silently approve).
 */
export class ApproveGate extends SingletonAction {
  override readonly manifestId = 'com.cluesmith.codev.approve-gate';
  private readonly keys = new Map<string, KeyAction>();

  constructor(private readonly store: CodevStore) {
    super();
    this.store.onChange(() => this.renderAll());
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    this.keys.set(ev.action.id, ev.action);
    this.renderTo(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    this.keys.delete(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const id = this.store.topGateBuilderId();
    if (!id) {
      await ev.action.showAlert();
      return;
    }
    const res = await this.store.client.sendCommand('approve-gate', [id], this.store.selectedWorkspacePath());
    await ack(ev.action, res.ok);
  }
  private renderAll(): void {
    for (const action of this.keys.values()) this.renderTo(action);
  }
  private renderTo(action: KeyAction): void {
    const n = this.store.pendingGates().length;
    void action.setTitle(n > 0 ? `Gates\n${n}` : 'Gates');
  }
}

// ── Encoders (Stream Deck + dials) ──────────────────────────────────────────

/** Direction of a dial rotation, normalized to ±1 (0 when no movement). */
function dir(ev: DialRotateEvent): number {
  return Math.sign(ev.payload.ticks);
}

/**
 * Pick the artifact to open when zooming into a builder, by its phase: a builder
 * still writing its spec/plan has no meaningful diff, so open the document instead.
 * The gate it's blocked on is the strongest signal (mirrors Codev's gate side-actions:
 * plan-approval → View Plan); otherwise fall back to the protocol phase. Everything
 * past plan (implement / review / verify / unknown) opens the diff, as before.
 */
export function zoomInVerb(b: OverviewBuilder): string {
  const gate = b.blockedGate ?? '';
  if (gate === 'spec-approval') return 'open-spec';
  if (gate === 'plan-approval') return 'open-plan';
  if (gate) return 'view-diff'; // dev-approval / pr / other → review the implementation
  const phase = b.protocolPhase ?? '';
  if (phase === 'specify') return 'open-spec';
  if (phase === 'plan') return 'open-plan';
  return 'view-diff';
}

/**
 * Zoom Navigator: one Stream Deck + dial that walks the zoom altitudes
 * workspaces → builders → editor.
 *
 *   - rotate           : move within the current altitude (next/prev workspace or builder)
 *   - touch (tap strip): zoom IN — workspaces→builders, or builders→open the diff
 *                        (hand off to the editor, where the Diff dials take over)
 *   - press (dial down): zoom OUT / reset — builders→workspaces (only when >1 workspace)
 *
 * Touch-strip = in / dial-press = out are two distinct, reliable hardware
 * gestures (no press-duration heuristic). Pressing the dial reads as a "reset /
 * back out" click. The workspaces altitude is skipped on single-workspace setups.
 */
export class ZoomNav extends SingletonAction {
  override readonly manifestId = 'com.cluesmith.codev.zoom-nav';
  private current?: DialAction;

  constructor(private readonly store: CodevStore) {
    super();
    this.store.onChange(() => this.render());
  }

  /** Collapse the trivial workspaces altitude when there is only one workspace. */
  private normalizeLevel(): void {
    if (this.store.workspaces.length <= 1 && this.store.cursor.level === 'workspaces') {
      this.store.setLevel('builders');
    }
  }

  override onWillAppear(ev: WillAppearEvent): void {
    this.normalizeLevel();
    if (ev.action.isDial()) {
      this.current = ev.action;
      this.renderTo(ev.action);
    }
  }
  override onWillDisappear(): void {
    this.current = undefined;
  }

  override onDialRotate(ev: DialRotateEvent): void {
    this.normalizeLevel();
    this.store.rotateCursor(dir(ev));
  }

  /** Tap the touchscreen strip = zoom in. */
  override async onTouchTap(): Promise<void> {
    await this.zoomIn();
  }

  /** Press the dial = zoom out / reset. */
  override onDialDown(): void {
    this.zoomOut();
  }

  /** Zoom in: descend a level, or (at the builders altitude) open the selected diff. */
  private async zoomIn(): Promise<void> {
    if (this.store.cursor.level === 'workspaces') {
      // Entering a workspace also brings its editor window to the foreground.
      // Sent UNSTAMPED: it targets a different workspace than the focused one, so
      // it must skip the workspace-scope filter and run on whoever is focused
      // (whose extension focuses the target window via vscode.openFolder).
      const ws = this.store.selectedWorkspacePath();
      this.store.descendCursor(); // → builders
      if (ws) await this.store.client.sendCommand('focus-workspace', [ws]);
      return;
    }
    const b = this.store.selectedBuilder();
    if (b) {
      await this.store.client.sendCommand(zoomInVerb(b), [b.id], this.store.selectedWorkspacePath());
    }
  }

  /** Zoom out / reset: climb back to the workspaces altitude (only with >1 workspace). */
  private zoomOut(): void {
    if (this.store.cursor.level === 'builders' && this.store.workspaces.length > 1) {
      this.store.ascendCursor(); // → workspaces
    }
  }

  private render(): void {
    if (this.current) this.renderTo(this.current);
  }
  private renderTo(action: DialAction): void {
    // Touch strip rows: title (top) + value (middle) + bar (progress).
    if (this.store.cursor.level === 'workspaces') {
      const ws = this.store.workspaces[this.store.cursor.workspace];
      if (!ws) {
        void action.setFeedback({ title: 'No workspaces', value: '', bar: 0 });
        return;
      }
      // Workspace name is known immediately; its builders may still be loading
      // after a switch — show that rather than the previous workspace's counts.
      if (this.store.loadingOverview) {
        void action.setFeedback({ title: `⌂ ${ws.name}`, value: 'loading…', bar: 0 });
        return;
      }
      const all = this.store.builders();
      const gates = this.store.pendingGates().length;
      const value = gates > 0 ? `${all.length} blds · ${gates}⚠` : `${all.length} builders`;
      const bar = all.length ? Math.round(all.reduce((s, b) => s + (b.progress ?? 0), 0) / all.length) : 0;
      void action.setFeedback({ title: `⌂ ${ws.name}`, value, bar });
      return;
    }
    if (this.store.loadingOverview && !this.store.overview) {
      void action.setFeedback({ title: 'loading…', value: '', bar: 0 });
      return;
    }
    const ws = this.store.workspaces[this.store.cursor.workspace];
    const home = ws ? `⌂ ${ws.name}` : '—';
    const all = this.store.builders();
    const b = this.store.selectedBuilder();
    if (!b) {
      void action.setFeedback({ title: home, value: 'No builders', bar: 0 });
      return;
    }
    const pos = `${this.store.cursor.builder + 1}/${all.length}`;
    const phase = b.blocked ?? b.protocolPhase ?? '';
    const id = b.issueId ? `#${b.issueId}` : b.id;
    // Row 1: the workspace you're in. Row 2: the selected builder (position · id · phase).
    void action.setFeedback({
      title: home,
      value: phase ? `${pos} ${id} · ${phase}` : `${pos} ${id}`,
      bar: Math.round(b.progress ?? 0),
    });
  }
}

/** PR navigator: rotate cycles pending PRs; press opens the selected PR in the browser. */
export class PrNav extends SingletonAction {
  override readonly manifestId = 'com.cluesmith.codev.pr-nav';
  constructor(private readonly store: CodevStore) {
    super();
    this.store.onChange(() => this.render());
  }
  private index = 0;
  private current?: DialAction;

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isDial()) {
      this.current = ev.action;
      this.renderTo(ev.action);
    }
  }
  override onWillDisappear(): void {
    this.current = undefined;
  }
  override onDialRotate(ev: DialRotateEvent): void {
    const prs = this.store.pendingPRs();
    if (prs.length === 0) return;
    this.index = Math.max(0, Math.min(this.index + dir(ev), prs.length - 1));
    this.renderTo(ev.action);
  }
  override async onDialDown(): Promise<void> {
    const pr = this.store.pendingPRs()[this.index];
    if (pr) await this.store.openUrl(pr.url);
  }
  private render(): void {
    if (this.current) this.renderTo(this.current);
  }
  private renderTo(action: DialAction): void {
    const prs = this.store.pendingPRs();
    if (this.index >= prs.length) this.index = Math.max(0, prs.length - 1);
    const pr = prs[this.index];
    if (!pr) {
      void action.setFeedback({ title: 'No PRs', value: '', bar: 0 });
      return;
    }
    void action.setFeedback({
      title: `PR #${pr.id}`,
      value: `${this.index + 1}/${prs.length}`,
      bar: Math.round(((this.index + 1) / prs.length) * 100),
    });
  }
}

/** Spawn navigator: rotate cycles backlog issues; press spawns a builder for the selected one. */
export class SpawnNav extends SingletonAction {
  override readonly manifestId = 'com.cluesmith.codev.spawn-nav';
  constructor(private readonly store: CodevStore) {
    super();
    this.store.onChange(() => this.render());
  }
  private index = 0;
  private current?: DialAction;

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isDial()) {
      this.current = ev.action;
      this.renderTo(ev.action);
    }
  }
  override onWillDisappear(): void {
    this.current = undefined;
  }
  override onDialRotate(ev: DialRotateEvent): void {
    const items = this.store.backlog();
    if (items.length === 0) return;
    this.index = Math.max(0, Math.min(this.index + dir(ev), items.length - 1));
    this.renderTo(ev.action);
  }
  override async onDialDown(ev: DialDownEvent): Promise<void> {
    const item = this.store.backlog()[this.index];
    if (!item) {
      if (ev.action.isKey()) await ev.action.showAlert();
      return;
    }
    await this.store.client.sendCommand('spawn-builder', [item.id], this.store.selectedWorkspacePath());
  }
  private render(): void {
    if (this.current) this.renderTo(this.current);
  }
  private renderTo(action: DialAction): void {
    const items = this.store.backlog();
    if (this.index >= items.length) this.index = Math.max(0, items.length - 1);
    const item = items[this.index];
    if (!item) {
      void action.setFeedback({ title: 'No backlog', value: '', bar: 0 });
      return;
    }
    void action.setFeedback({
      title: `#${item.id}`,
      value: `${this.index + 1}/${items.length}`,
      bar: Math.round(((this.index + 1) / items.length) * 100),
    });
  }
}

/**
 * A dial for a diff-review axis (files or hunks): rotate navigates, the dial press
 * forwards that axis to the builder, and a touch-strip tap jumps to the first.
 * VSCode owns the actual file/hunk position, so the screen shows what the dial does
 * (line 1) and which builder is under review (line 2 + progress bar) — not a counter.
 */
abstract class DiffNav extends SingletonAction {
  protected abstract readonly verbs: { next: string; prev: string; first: string };
  /** Line-1 label: what this dial does (Files / Changes). */
  protected abstract readonly label: string;
  /** Verb fired by a dial press: forward this axis (file / hunk) to the builder. */
  protected abstract readonly forwardVerb: string;
  private current?: DialAction;

  constructor(protected readonly store: CodevStore) {
    super();
    this.store.onChange(() => this.render());
  }
  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isDial()) {
      this.current = ev.action;
      this.renderTo(ev.action);
    }
  }
  override onWillDisappear(): void {
    this.current = undefined;
  }
  private render(): void {
    if (this.current) this.renderTo(this.current);
  }
  /** Line 1 = what the dial does; line 2 = builder under review (id + title); bar = its progress. */
  private renderTo(action: DialAction): void {
    const b = this.store.selectedBuilder();
    const id = b ? (b.issueId ? `#${b.issueId}` : b.id) : '';
    const details = b ? (b.issueTitle ? `${id} ${b.issueTitle}` : id) : 'No builder';
    void action.setFeedback({ title: this.label, value: details, bar: Math.round(b?.progress ?? 0) });
  }
  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    const verb = dir(ev) >= 0 ? this.verbs.next : this.verbs.prev;
    await this.store.client.sendCommand(verb, [], this.store.selectedWorkspacePath());
  }
  override async onDialDown(): Promise<void> {
    // Press forwards this axis to the builder (was the touch strip).
    await this.store.client.sendCommand(this.forwardVerb, [], this.store.selectedWorkspacePath());
  }
  override async onTouchTap(): Promise<void> {
    // Touch jumps to the first file/change (was the dial press).
    await this.store.client.sendCommand(this.verbs.first, [], this.store.selectedWorkspacePath());
  }
}

export class DiffFileNav extends DiffNav {
  override readonly manifestId = 'com.cluesmith.codev.diff-file-nav';
  protected readonly label = 'Files';
  protected readonly forwardVerb = 'forward-file';
  protected readonly verbs = { next: 'diff-next-file', prev: 'diff-prev-file', first: 'diff-first-file' };
}

export class DiffHunkNav extends DiffNav {
  override readonly manifestId = 'com.cluesmith.codev.diff-hunk-nav';
  protected readonly label = 'Changes';
  protected readonly forwardVerb = 'forward-hunk';
  protected readonly verbs = { next: 'diff-next-hunk', prev: 'diff-prev-hunk', first: 'diff-first-hunk' };
}

/** Lines scrolled per dial tick (viewport only — the caret stays put). */
const SCROLL_LINES_PER_TICK = 3;

/**
 * Scroll dial: rotate scrolls the focused editor's viewport up/down (so you can
 * read a diff without the keyboard); a dial press forwards the current selection to
 * the builder. Scroll is a viewport move (`revealCursor: false`), so select your
 * text first, then scroll/forward.
 */
export class ScrollNav extends SingletonAction {
  override readonly manifestId = 'com.cluesmith.codev.scroll-nav';
  constructor(private readonly store: CodevStore) {
    super();
  }
  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isDial()) void ev.action.setTitle('Scroll');
  }
  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    const to = dir(ev) >= 0 ? 'down' : 'up';
    await this.store.client.sendCommand(
      'scroll',
      [{ to, by: 'line', value: SCROLL_LINES_PER_TICK, revealCursor: false }],
      this.store.selectedWorkspacePath(),
    );
  }
  override async onDialDown(): Promise<void> {
    await this.store.client.sendCommand('forward-selection', [], this.store.selectedWorkspacePath());
  }
}
