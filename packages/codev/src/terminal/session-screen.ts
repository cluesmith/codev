/**
 * Persistent bounded headless screen (Spec 1313 render-gate round 2).
 *
 * The render gate answers "is this session's composer a clean, empty prompt?" by
 * inspecting a rendered terminal screen. It originally rebuilt that screen on every
 * check by replaying the WHOLE output ring (`ringBuffer.getAll().join('\n')`) through
 * a throwaway `@xterm/headless` Terminal. That worked only while the ring held the
 * whole cumulative stream — but #1205 capped the ring's incomplete-line `partial` at
 * 2 MiB (`trimPartial` halves it to ~1 MiB), and a claude/codex alt-screen frame is
 * exactly one giant newline-free partial. So once a busy long-lived agent's frame
 * crossed the cap, the gate received a TORN front (missing the alt-screen-enter and the
 * composer marker/rule) and classified `no-region-end`/`no-composer-marker` → held the
 * mail PERMANENTLY. That is the over-ceiling delivery outage, resurrected one layer down.
 *
 * The fix is to stop reconstructing the screen from the (now-capped) ring and instead
 * mirror the session's output into ONE long-lived headless Terminal, fed the same bytes
 * the PTY emits, incrementally, from session birth. A terminal emulator is already a
 * BOUNDED screen model (rows × cols + a little scrollback), so:
 *   - the ring's partial cap is irrelevant — the screen never needs the whole stream,
 *     only the live byte sequence, which it folds into a fixed-size grid;
 *   - the LIVE-path tear is gone — a session mirrored from its first byte always shows the
 *     real current screen (the adopt/reconnect *seed* is a separate bounded case — see below);
 *   - the #1047 unbounded-`partial` OOM risk the old whole-ring render carried is closed
 *     (no multi-hundred-MB string is ever allocated to classify);
 *   - each classify is O(viewport), not O(ring size) — no per-check whole-render cost,
 *     so the cost-aware backstop backoff the whole-render era needed is retired.
 *
 * This wrapper is deliberately gate-agnostic: it only feeds/resizes/reads a screen. The
 * classifier (marker + region + cell scan) lives in `render-gate.ts` and reads the live
 * buffer this hands back via {@link read}. `PtySession` owns one of these and feeds it at
 * its single output chokepoint (`onPtyData`), so on the LIVE path the mirror captures every byte
 * from its first frame. On adopt/reconnect after a Tower restart it is instead seeded from the
 * bounded replay tail (`capRingSeed`, 1 MiB, in `tower-terminals.ts`), so a long-lived alt-screen
 * frame whose coherent start predates that tail can be **born torn** — that classifies not-clean, so
 * the gate HOLDS (fail-safe: mail is delayed, never fused onto a non-empty screen) and self-heals on
 * the agent's next full repaint or a viewer's post-connect resize nudge. This is pre-existing (before
 * round 2 the whole-ring gate classified that same 1 MiB seed) and tracked as a fast-follow, #1361.
 */

// `@xterm/headless` resolves to its CommonJS entry (no `exports` map / `type: module`),
// and its named exports are not statically analyzable, so a native-node ESM
// `import { Terminal }` throws "Named export 'Terminal' not found" under the compiled
// dist (see the identical note in render-gate.ts). Default-import the module object.
// `@xterm/addon-serialize` ships the same way (same repo and release train).
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal, ITerminalAddon } from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

/**
 * Scrollback retained by the mirror, now serving two consumers (PIR #1354):
 *
 * - The render gate reads ONLY the current viewport (`viewportY … viewportY + rows`),
 *   never scrollback, and its verdict is identical for any scrollback ≥ rows (asserted
 *   by the production-path tests) — so for the gate this value is a free variable.
 * - {@link SessionScreen.serialize} is the viewer-attach replay payload, and its
 *   scrollback IS the history a reconnecting viewer gets back. 1000 matches the ring
 *   buffer's default line capacity (`ringBufferLines`), so snapshot replay does not
 *   regress history depth versus the raw-ring replay it replaces.
 *
 * Memory: measured ~509 KB per fully-scrolled 200x50 terminal at 1000 lines (~215 KB
 * at the previous 200) — the bounded per-session budget the plan commits to.
 */
const SCREEN_SCROLLBACK = 1000;

/** The live-buffer read handle the gate classifies (see {@link SessionScreen.read}). */
export interface ScreenView {
  term: HeadlessTerminal;
  cols: number;
  rows: number;
}

export class SessionScreen {
  private readonly term: HeadlessTerminal;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private _cols: number;
  private _rows: number;
  // Promise of the most recently issued write's parse completion. `@xterm/headless`
  // parses asynchronously and processes writes FIFO, so awaiting the LATEST write's
  // callback guarantees every earlier write is parsed too — the flush {@link read} needs.
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(cols: number, rows: number) {
    this._cols = cols;
    this._rows = rows;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: SCREEN_SCROLLBACK });
    this.serializer = new SerializeAddon();
    // The addon's typings bind to the full `@xterm/xterm` Terminal; its runtime touches
    // only the buffer/parser surface the headless build shares (proven by the round-trip
    // suite), so the declared-type gap is bridged explicitly here.
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  /**
   * Fold one chunk of PTY output into the screen. Called at the session's single output
   * chokepoint for EVERY byte (live output and the reconnect-replay seed alike), so the
   * mirror stays a faithful copy of what the real terminal shows. Cheap: a terminal
   * emulator parse of the delta, not a whole-history re-render. A no-op after
   * {@link dispose} — a late PTY frame arriving during teardown must not touch a freed term.
   */
  feed(data: string): void {
    if (this.disposed) return;
    this.pending = new Promise<void>((resolve) => this.term.write(data, () => resolve()));
  }

  /**
   * Resize the mirror to match the live session (Spec 1313: the gate renders at the
   * session's geometry so wrapping reconstructs identically). Kept in lockstep with
   * `PtySession.resize`. A no-op after {@link dispose}.
   */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this._cols = cols;
    this._rows = rows;
    this.term.resize(cols, rows);
  }

  /**
   * Flush the parser and hand back the live buffer for the gate to read SYNCHRONOUSLY.
   *
   * `await this.pending` drains every byte fed up to this call into the grid, so the returned
   * buffer reflects AT LEAST the output counted by `ringBuffer.bytesWritten` at the moment the
   * caller sampled its change-token (xterm parses writes FIFO but may run ahead into later queued
   * writes, so the buffer can reflect *more* — never less). That lower bound is the property the
   * delivery path's token-before/after TOCTOU relies on: the caller MUST read the returned buffer
   * with no intervening `await` (the classifier is synchronous), so no `feed` can interleave the
   * read; any output that landed during THIS flush already advanced `bytesWritten`, so the caller's
   * post-classify token re-check trips (→ hold) and nothing is delivered onto it.
   *
   * After {@link dispose} the term is freed and its parse callback may never fire, so this returns
   * the current view WITHOUT awaiting `pending` — a disposed screen has no coherent frame, the
   * classifier finds no marker → fail-safe hold, and `PtySession.cleanup` nulls `gateScreen` so the
   * wiring already holds before a read() can reach a disposed mirror in practice.
   */
  async read(): Promise<ScreenView> {
    if (this.disposed) return { term: this.term, cols: this._cols, rows: this._rows };
    await this.pending;
    return { term: this.term, cols: this._cols, rows: this._rows };
  }

  /**
   * Serialize the current screen state (both buffers, colors/attrs, cursor, alt-screen
   * mode, plus up to {@link SCREEN_SCROLLBACK} lines of history) back into a terminal
   * byte stream a client can replay — the O(screen) viewer-attach payload (PIR #1354).
   *
   * SYNCHRONOUS by design: it reads whatever is parsed into the grid right now.
   * Callers wanting a coherent frame must flush first ({@link read}) and must call this
   * with no intervening `await` afterward — the same no-interleave discipline the render
   * gate's classifier relies on. `PtySession.replaySnapshot` owns that protocol.
   *
   * Throws whatever the addon throws; the caller maps failures to the raw-replay
   * fallback. After {@link dispose} the term is freed — return '' rather than touching it
   * (callers treat an empty snapshot for a non-empty session as a fallback signal).
   */
  serialize(): string {
    if (this.disposed) return '';
    return this.serializer.serialize({ scrollback: SCREEN_SCROLLBACK });
  }

  /**
   * Which buffer the emulated app is currently in. 'alternate' identifies the
   * full-screen-TUI case whose delta resume is unservable from the line-based ring
   * (`RingBuffer.getSince` returns [] for a caught-up client), so the attach path
   * routes it to {@link serialize} instead. Read without flushing: worst case the
   * routing decision lags the last few unparsed bytes, and both routes remain correct
   * (the raw path keeps its client-nudge recovery).
   */
  get bufferType(): 'normal' | 'alternate' {
    return this.term.buffer.active.type;
  }

  /** Current mirror geometry (matches the live session). */
  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  /** Release the headless Terminal. Idempotent; feeds/resizes/reads after it are no-ops. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
    // Settle `pending` so a read() that samples it after dispose resolves immediately rather than
    // awaiting a parse callback the freed term may never fire — otherwise an in-flight classify (and,
    // via the drainer's `ticking` flag, the backstop) could wedge (Claude round-2 CMAP). Belt-and-
    // suspenders with read()'s disposed early-return; not reachable on the pinned @xterm/headless.
    this.pending = Promise.resolve();
  }
}
