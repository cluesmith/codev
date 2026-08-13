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
import type {
  OverviewBuilder,
  CanvasCommand,
  CanvasCommandClientErrorCode,
} from '@cluesmith/codev-sdk/controller';
import type { CodevStore } from './store.js';
import { approveFaceSvg, builderFaceSvg, faceForBuilder, labelFaceSvg, sendFbFaceSvg, svgToDataUri } from './face.js';

/**
 * The Stream Deck actions — thin adapters over CodevStore. Each maps a physical
 * input to a canonical verb (POSTed via the command relay) or a cursor move /
 * URL open. UUIDs are set via the `manifestId` field (no decorators — keeps the
 * esbuild→node bundle free of decorator transpilation). Most keys render title-based;
 * the Builder Action and Gates keys compose a full SVG face via `setImage` (see `face.ts`),
 * and the encoders render `setFeedback` touchscreen layouts.
 */

/** Optional per-instance verb override from the Property Inspector. */
type VerbSettings = { verb?: string };

function settingsVerb(ev: KeyDownEvent): string | undefined {
  const s = ev.payload.settings as VerbSettings | undefined;
  return typeof s?.verb === 'string' ? s.verb : undefined;
}

async function ack(action: KeyAction, ok: boolean): Promise<void> {
  // Success is silent — the green "OK" checkmark was redundant press feedback. Failures still
  // surface a red alert so a rejected command is never silent.
  if (!ok) await action.showAlert();
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

/** Run dev for the cursor-selected builder's worktree (no PI). */
export class DevServerAction extends VerbKey {
  override readonly manifestId = 'com.cluesmith.codev.dev-server';
  protected readonly defaultVerb = 'run-dev';
  protected override args(): unknown[] {
    const b = this.store.selectedBuilder();
    return b ? [b.id] : [];
  }
  // Render the composite face (play icon + "Dev" label) so this key matches the other keys instead
  // of showing a bare icon. Static — the label doesn't track running state.
  override onWillAppear(ev: WillAppearEvent<VerbSettings>): void {
    if (!ev.action.isKey()) return;
    void ev.action.setImage(svgToDataUri(labelFaceSvg('play', 'Dev', '#73c991')));
    void ev.action.setTitle('');
  }
}


// ── Slot keys (pinned builder board) ────────────────────────────────────────

/** PI settings shared by the slot-based keys: a 1-based builder slot + a verb. */
type SlotSettings = { slot?: string; verb?: string };

/**
 * Resolve the builder a slot points at. Slot N is a POSITION in Row 1's 4-wide
 * window onto the fleet (#1410), not an absolute index: the window is the page
 * containing the selection, so the Select dial scrolls builders 5-8, 9-N into the
 * same four keys. A slot past the end of the fleet resolves to `undefined` (an
 * empty slot on the last page).
 */
function slotBuilder(store: CodevStore, settings: SlotSettings): OverviewBuilder | undefined {
  const slot = Number.parseInt(settings.slot ?? '1', 10);
  const slotIndex = (Number.isFinite(slot) && slot > 0 ? slot : 1) - 1;
  return store.windowedBuilder(slotIndex);
}

/**
 * A keypad pinned to a builder slot (the Nth builder) that fires a verb for that
 * builder. The Property Inspector picks the slot and the verb; the press is
 * resilient to builder ids changing because it indexes by position, not id.
 * Subclasses override the default verb, the render, and (optionally) the verb
 * resolution (BuilderAction resolves its `automatic` default to a phase artifact).
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
    // Pressing a builder key focuses it: the shared cursor follows, so the diff
    // dials and other selection-scoped keys now act on the builder you pressed.
    this.store.syncToBuilder(b.id);
    const verb = this.resolveVerb(settings, b);
    const res = await this.store.client.sendCommand(verb, [b.id], this.store.selectedWorkspacePath());
    await ack(ev.action, res.ok);
  }
  /** The verb a press fires. Base: the per-key setting, else the default. */
  protected resolveVerb(settings: SlotSettings, _b: OverviewBuilder): string {
    return settings.verb ?? this.defaultVerb;
  }
  private renderAll(): void {
    for (const { action, settings } of this.keys.values()) this.renderTo(action, settings);
  }
  protected abstract renderTo(action: KeyAction, settings: SlotSettings): void;
}

/**
 * Builder Action: a live board key for the slot's builder. It renders that
 * builder's issue + phase/blocked, and on press selects the builder (the cursor
 * follows) and fires a verb. The default verb is `automatic`: it opens the
 * artifact that matters for the builder's current phase (spec / plan / diff), and
 * re-opens it on every press. An explicit verb chosen in the PI is fired verbatim.
 */
export class BuilderAction extends SlotKey {
  override readonly manifestId = 'com.cluesmith.codev.builder-action';
  protected readonly defaultVerb = 'automatic';
  protected override resolveVerb(settings: SlotSettings, b: OverviewBuilder): string {
    const verb = settings.verb;
    if (verb && verb !== 'automatic') return verb;
    // Automatic: the current phase's artifact, else a terminal when there's none.
    // When that artifact is the diff, open the builder's FIRST file in per-file mode
    // (`open-diff-first`, #1414) — dial-ready — instead of the aggregate editor. The
    // explicit "View Diff" PI verb above still relays `view-diff` (aggregate) verbatim.
    const auto = phaseArtifactVerb(b) ?? 'open-terminal';
    return auto === 'view-diff' ? 'open-diff-first' : auto;
  }
  protected renderTo(action: KeyAction, settings: SlotSettings): void {
    const b = slotBuilder(this.store, settings);
    // Compose the WHOLE face as one SVG (icon zone + reserved text band) instead of stacking a
    // title over the manifest bolt PNG — see face.ts for the layout and the sidebar-mirrored
    // colour/icon vocabulary. setTitle('') suppresses the SDK title layer so nothing overlays it.
    let svg: string;
    if (b) {
      // Accent the slot holding the shared selection so the live builder among
      // the four is unmistakable (#1410).
      const selected = b.id === this.store.selectedBuilder()?.id;
      svg = builderFaceSvg(faceForBuilder(b, selected));
    } else {
      svg = builderFaceSvg({ kind: 'empty', slot: settings.slot ?? '1' });
    }
    void action.setImage(svgToDataUri(svg));
    void action.setTitle('');
  }
}

/**
 * Row-2 Approve key (#1410): the SINGLE approve affordance on the deck. It acts on
 * the SELECTED builder — press relays `approve-gate [selectedId]`, which the
 * provider surfaces as a confirmation modal (it does NOT silently approve). The
 * face shows the selected builder's pending gate (e.g. `Plan · Approve`) when it is
 * blocked, and is inert otherwise. The former standalone top-gate singleton is
 * retired: the fleet-wide pending-gate count + jump-to-next now live on
 * `NextAttentionAction`, so there are never two approve keys with different targets.
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
    const b = this.store.selectedBuilder();
    // Only a builder blocked at a gate is approvable; otherwise the key is inert
    // (no pointless relay that the provider would just reject).
    if (!b || !b.blockedGate) {
      await ev.action.showAlert();
      return;
    }
    const res = await this.store.client.sendCommand('approve-gate', [b.id], this.store.selectedWorkspacePath());
    await ack(ev.action, res.ok);
  }
  private renderAll(): void {
    for (const action of this.keys.values()) this.renderTo(action);
  }
  private renderTo(action: KeyAction): void {
    void action.setImage(svgToDataUri(approveFaceSvg(this.store.selectedBuilder())));
    void action.setTitle('');
  }
}

/**
 * Row-2 Send Fb key (#1410): flushes the SELECTED builder's queued review
 * feedback. The badge `N` mirrors the per-builder queued count from the overview
 * (`store.queuedFeedback`). Press relays `send-queue [selectedId]` (VSCode's
 * batched Submit Review) when `N > 0`; inert at 0 — in immediate mode nothing ever
 * queues so `N` stays 0 and the key never sends (no deck-side mode inference).
 */
export class SendQueueAction extends SingletonAction {
  override readonly manifestId = 'com.cluesmith.codev.send-queue';
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
    const b = this.store.selectedBuilder();
    if (!b || this.store.queuedFeedback(b.id) <= 0) {
      await ev.action.showAlert();
      return;
    }
    const res = await this.store.client.sendCommand('send-queue', [b.id], this.store.selectedWorkspacePath());
    await ack(ev.action, res.ok);
  }
  private renderAll(): void {
    for (const action of this.keys.values()) this.renderTo(action);
  }
  private renderTo(action: KeyAction): void {
    void action.setImage(svgToDataUri(sendFbFaceSvg(this.store.queuedFeedback(this.store.selectedBuilder()?.id))));
    void action.setTitle('');
  }
}

/**
 * Row-2 Open Terminal key (#1410): opens the SELECTED builder's terminal — the
 * per-builder complement to the Builder Action (which opens the phase artifact).
 * Same shape as the Dev Server key: a `VerbKey` firing `open-terminal [selectedId]`
 * with a static label face (terminal glyph + `Terminal`). Which builder is selected
 * is shown by Row 1's accent, not repeated here.
 */
export class OpenTerminalAction extends VerbKey {
  override readonly manifestId = 'com.cluesmith.codev.open-terminal';
  protected readonly defaultVerb = 'open-terminal';
  protected override args(): unknown[] {
    const b = this.store.selectedBuilder();
    return b ? [b.id] : [];
  }
  override onWillAppear(ev: WillAppearEvent<VerbSettings>): void {
    if (!ev.action.isKey()) return;
    void ev.action.setImage(svgToDataUri(labelFaceSvg('terminal', 'Terminal', '#a9a9b2')));
    void ev.action.setTitle('');
  }
}

// ── Encoders (Stream Deck + dials) ──────────────────────────────────────────

/** Direction of a dial rotation, normalized to ±1 (0 when no movement). */
function dir(ev: DialRotateEvent): number {
  return Math.sign(ev.payload.ticks);
}

/**
 * The artifact verb for a builder's current protocol state, or `undefined` when
 * the state is unknown / has no artifact yet. The gate a builder is blocked on is
 * the strongest signal (mirrors Codev's gate side-actions: plan-approval → View
 * Plan); otherwise the protocol phase decides. A builder still writing its
 * spec/plan has no meaningful diff, so its document opens instead. State strings
 * are read from the overview wire values (`blockedGate` / `protocolPhase`), never
 * guessed. Callers choose the fallback: the dial zoom-in opens the diff, the
 * Builder Action key opens a terminal.
 */
export function phaseArtifactVerb(b: OverviewBuilder): string | undefined {
  const gate = b.blockedGate ?? '';
  if (gate === 'spec-approval') return 'open-spec';
  if (gate === 'plan-approval') return 'open-plan';
  if (gate === 'dev-approval' || gate === 'pr') return 'view-diff';
  const phase = b.protocolPhase ?? '';
  if (phase === 'specify') return 'open-spec';
  if (phase === 'plan') return 'open-plan';
  if (phase === 'implement' || phase === 'review' || phase === 'verify') return 'view-diff';
  return undefined; // unknown gate / no live status → the caller's fallback
}

/**
 * Pick the artifact to open when zooming into a builder. Reuses the shared
 * phase→artifact resolver; an unknown/no-status builder falls back to the diff
 * (a dial always has an editor to hand off to).
 */
export function zoomInVerb(b: OverviewBuilder): string {
  return phaseArtifactVerb(b) ?? 'view-diff';
}

/** Which artifact form the selected builder's phase implies for the review dials. */
export type ReviewMode = 'diff' | 'canvas' | 'none';

/**
 * The review mode for a builder: a builder still writing its spec/plan reviews as a
 * canvas (`open-spec` / `open-plan`), one with a diff reviews as a diff (`view-diff`),
 * and an unknown/no-status builder has neither. Derived from the shared phase/gate
 * resolver so the wire source stays single (`blockedGate` beats `protocolPhase`; never
 * guessed) — this is the same resolver family #1404's press keys off.
 */
export function reviewMode(b: OverviewBuilder | undefined): ReviewMode {
  if (!b) return 'none';
  const verb = phaseArtifactVerb(b);
  if (verb === 'open-spec' || verb === 'open-plan') return 'canvas';
  if (verb === 'view-diff') return 'diff';
  return 'none';
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

/** Diff-mode gesture spec: canonical verbs fired over the generic command relay. */
interface DiffSpec {
  /** Line-1 label in diff mode (Files / Changes). */
  label: string;
  next: string;
  prev: string;
  /** Tap: jump to the first file / hunk. */
  first: string;
  /** Press: forward this axis (file / hunk) to the builder. */
  forward: string;
}

/**
 * Canvas-mode gesture spec: canvas commands driven over `sendCanvasCommand` (#1401).
 * Press differs per dial (#1425): the fine dial submits (`composer-open-or-submit`), the
 * coarse dial cancels (`composer-cancel`), so each dial carries its own press verb and a
 * short touchstrip hint naming it.
 */
interface CanvasSpec {
  /** Line-1 label in canvas mode (Headings / Blocks). */
  label: string;
  next: CanvasCommand;
  prev: CanvasCommand;
  /** Tap. */
  jump: CanvasCommand;
  /** Press: the composer command sent on dial down. */
  press: CanvasCommand;
  /** Short line-1 hint naming the press (e.g. Open/Submit, Cancel) so a reviewer can tell
   *  the two dials' presses apart at a glance. */
  pressLabel: string;
}

/** Touchstrip line for a failed canvas command, per client error code (plan §4). */
function canvasErrorLine(code: CanvasCommandClientErrorCode): string {
  if (code === 'no-canvas') return 'Open artifact';
  if (code === 'unreachable') return 'Tower offline';
  return 'Error'; // invalid-request: defensive — we only ever send valid commands
}

/**
 * A phase-aware review dial. The selected builder's phase picks the MODE:
 *
 *   - diff mode (implement / review, or blocked at dev-approval / pr): rotate walks
 *     the diff axis (files / hunks), press forwards that axis to the builder, tap
 *     jumps to the first — over the generic command relay.
 *   - canvas mode (specify / plan, or blocked at spec-approval / plan-approval): rotate
 *     steps the artifact-canvas (headings / blocks), press drives the composer per dial
 *     (fine: open-or-submit; coarse: cancel — #1425), tap resets (doc start) or walks
 *     comments — over `sendCanvasCommand`.
 *
 * The dials drive the workspace's most-recently-active canvas (MRU targeting): the
 * phase picks the mode, the dials drive what you are looking at, and #1404's press
 * converges the MRU onto the selected builder's own artifact.
 *
 * Legibility is a hard requirement: the touchstrip always names the live semantic
 * (Files/Changes vs Headings/Blocks), recomputed on every overview tick, so a gesture
 * is never a surprise. A failed canvas command renders its reason on the strip until
 * the next tick. VSCode owns the actual position, so the screen shows what the dial
 * does (line 1) and which builder is under review (line 2 + progress bar) — not a counter.
 */
abstract class ReviewNav extends SingletonAction {
  protected abstract readonly diff: DiffSpec;
  protected abstract readonly canvas: CanvasSpec;
  private current?: DialAction;
  /** Transient canvas-error line; shown until the next overview tick clears it. */
  private status?: string;

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

  private mode(): ReviewMode {
    return reviewMode(this.store.selectedBuilder());
  }

  /** onChange re-render: a fresh overview clears the transient canvas-error line. */
  private render(): void {
    this.status = undefined;
    if (this.current) this.renderTo(this.current);
  }

  /** Line 1 = the live semantic (mode-dependent); line 2 = builder under review
   *  (id + title); bar = its progress. A pending canvas error takes line 2 for one cycle. */
  private renderTo(action: DialAction): void {
    // Canvas line 1 pairs the rotate axis with the press meaning (`Blocks · Open/Submit`,
    // `Headings · Cancel`); diff mode pairs its axis with the feedback delivery mode
    // (`Files · queue` vs `Files · send`, #1410) so a press is never a surprise.
    const label =
      this.mode() === 'canvas'
        ? `${this.canvas.label} · ${this.canvas.pressLabel}`
        : `${this.diff.label} · ${this.store.feedbackMode() === 'queue' ? 'queue' : 'send'}`;
    const b = this.store.selectedBuilder();
    const id = b ? (b.issueId ? `#${b.issueId}` : b.id) : '';
    const details = b ? (b.issueTitle ? `${id} ${b.issueTitle}` : id) : 'No builder';
    void action.setFeedback({ title: label, value: this.status ?? details, bar: Math.round(b?.progress ?? 0) });
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    const mode = this.mode();
    const forward = dir(ev) >= 0;
    if (mode === 'canvas') {
      // One call per rotate event: count = |ticks|, never a burst of single-tick sends.
      const command = forward ? this.canvas.next : this.canvas.prev;
      await this.runCanvas(command, Math.abs(ev.payload.ticks) || 1);
      return;
    }
    if (mode === 'diff') {
      const verb = forward ? this.diff.next : this.diff.prev;
      await this.store.client.sendCommand(verb, [], this.store.selectedWorkspacePath());
    }
    // none (no builder / unknown phase): no-op — the dial has no artifact to act on.
  }

  override async onDialDown(): Promise<void> {
    const mode = this.mode();
    if (mode === 'canvas') {
      await this.runCanvas(this.canvas.press);
      return;
    }
    if (mode === 'diff') {
      await this.store.client.sendCommand(this.diff.forward, [], this.store.selectedWorkspacePath());
    }
    // none: no-op.
  }

  override async onTouchTap(): Promise<void> {
    const mode = this.mode();
    if (mode === 'canvas') {
      await this.runCanvas(this.canvas.jump);
      return;
    }
    if (mode === 'diff') {
      await this.store.client.sendCommand(this.diff.first, [], this.store.selectedWorkspacePath());
    }
    // none: no-op.
  }

  /** Send one canvas command to the workspace's MRU view and render its verdict. `count`
   *  is passed only for rotate (a traversal command); press / tap omit it. */
  private async runCanvas(command: CanvasCommand, count?: number): Promise<void> {
    const workspace = this.store.selectedWorkspacePath();
    if (!workspace) return; // no active workspace to target
    const res = await this.store.client.sendCanvasCommand(
      command,
      { workspace },
      count !== undefined ? { count } : undefined,
    );
    this.status = res.ok ? undefined : canvasErrorLine(res.code);
    if (this.current) this.renderTo(this.current);
  }
}

export class DiffFileNav extends ReviewNav {
  override readonly manifestId = 'com.cluesmith.codev.diff-file-nav';
  protected readonly diff: DiffSpec = {
    label: 'Files',
    next: 'diff-next-file',
    prev: 'diff-prev-file',
    first: 'diff-first-file',
    // Dials collect, key commits (#1410): press submits the file as feedback via a
    // mode-neutral verb; VSCode routes it forward-now or enqueue per the setting.
    forward: 'feedback-file',
  };
  // Coarse dial in canvas mode: step headings; tap resets to the document start
  // (role-consistent with diff-mode jump-to-first-file); press cancels an open composer.
  protected readonly canvas: CanvasSpec = {
    label: 'Headings',
    next: 'heading-next',
    prev: 'heading-prev',
    jump: 'doc-start',
    press: 'composer-cancel',
    pressLabel: 'Cancel',
  };
}

export class DiffHunkNav extends ReviewNav {
  override readonly manifestId = 'com.cluesmith.codev.diff-hunk-nav';
  protected readonly diff: DiffSpec = {
    label: 'Changes',
    next: 'diff-next-hunk',
    prev: 'diff-prev-hunk',
    first: 'diff-first-hunk',
    // Mode-neutral feedback (#1410): forward-now or enqueue per the workspace setting.
    forward: 'feedback-hunk',
  };
  // Fine dial in canvas mode: step blocks; tap walks forward through commented blocks
  // (the "next place needing attention" capability). Keyboard parity means no wrap, so
  // it stops at the last comment. Press is context-aware: opens the composer at the
  // focused block, or submits an already-open draft (#1420).
  protected readonly canvas: CanvasSpec = {
    label: 'Blocks',
    next: 'block-next',
    prev: 'block-prev',
    jump: 'comment-next',
    press: 'composer-open-or-submit',
    pressLabel: 'Open/Submit',
  };
}

/** Lines scrolled per dial tick (viewport only — the caret stays put). */
const SCROLL_LINES_PER_TICK = 3;

/**
 * Scroll dial: rotate scrolls the focused editor's viewport up/down (so you can
 * read a diff without the keyboard); a dial press submits the current selection as
 * feedback (forwarded now or queued per the workspace setting, #1410). Scroll is a
 * viewport move (`revealCursor: false`), so select your text first, then scroll/submit.
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
    // Mode-neutral feedback (#1410): submit the selection, routed forward-now or
    // enqueue by VSCode per the workspace setting.
    await this.store.client.sendCommand('feedback-selection', [], this.store.selectedWorkspacePath());
  }
}
