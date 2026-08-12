import type { CanvasCommand } from '@cluesmith/codev-types';
import type { Disposable } from '../types.js';

/**
 * One remote command, as delivered to the canvas.
 *
 * `count` repeats a traversal command (next/previous block, commented block, heading, or column)
 * N times, with the same edge behavior as N single steps. It is ignored on every other command
 * and on values that are not positive integers: validation belongs to the sender (spec 1401 —
 * Tower answers `invalid-request`), and a command that reached the canvas has already passed it.
 */
export interface CanvasCommandInvocation {
  command: CanvasCommand;
  count?: number;
}

/**
 * Delivers remote review-navigation commands into the canvas (spec 1401).
 *
 * The fourth adapter alongside File/Marker/Theme, and the same contract: an interface only, with
 * implementations living in the host. The canvas never opens a connection of its own — the host
 * owns the transport (a webview `postMessage` bridge, an SSE-fed relay, a test double) and calls
 * back through `onCommand`.
 *
 * Commands drive the SAME per-action implementations as the keyboard, so the remote and in-page
 * paths cannot diverge. What a command cannot do is type: comment bodies are entered on the
 * keyboard, so `composer-open` and `composer-submit` are in the vocabulary but text entry is not.
 *
 * Optional by design: a host that omits `commandAdapter` gets exactly today's behavior.
 */
export interface CommandAdapter {
  /**
   * Subscribe to inbound commands. Returns a `Disposable` synchronously (spec D2's async/sync
   * split); commands arrive asynchronously via `onCommand`.
   */
  subscribe(onCommand: (invocation: CanvasCommandInvocation) => void): Disposable;
}
