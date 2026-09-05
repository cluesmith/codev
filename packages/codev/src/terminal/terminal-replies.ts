/**
 * Terminal REPLY stripping for the delivery gate's input signal (Issue #1473).
 *
 * The render gate needs to know when a HUMAN has put something on a session's line, so a
 * gated delivery never lands on a composer somebody has started typing into. The only
 * server-side observation point is {@link PtySession.write}'s external branch — every live
 * client (the web terminal, the VS Code webview, mobile, the raw
 * `POST /api/terminals/:id/write` route) funnels through it.
 *
 * But that stream is not keystrokes. xterm forwards terminal REPLIES — DA, DSR, CPR,
 * XTWINOPS, DECRPM, DECRQSS, OSC colour queries, focus reports — through the very same
 * `onData` event as typed characters, because from the client's point of view they are all
 * "bytes to send upstream". The web client strips a few of them, but ONLY while
 * `rc.initialPhase` is true (`Terminal.tsx`) — for a session's entire steady-state life that
 * filter is off, and `afx attach`, the VS Code webview and mobile clients never had one at
 * all. Counting a reply as human input would produce a hold with nobody at the keyboard, and
 * worse, a SELF-TRIP: our own delivery write repaints the TUI, the TUI queries geometry, the
 * browser answers, and the answer reads as a keystroke that blocks the next delivery. So the
 * filter is a precondition of the whole design, and it lives here — server-side, where every
 * client is covered, rather than in one cooperative client.
 *
 * SIGNAL-ONLY. Nothing here changes what reaches the PTY: the caller still writes the full
 * chunk verbatim, because the application ASKED for the reply and blocks waiting on it.
 * Swallowing a DA reply would hang every attached terminal.
 *
 * ## Failure directions
 *
 * - **Over-strip** (a real keystroke eaten from the signal) → that keystroke goes uncounted,
 *   which is exactly today's behaviour, so never a regression — but it silently re-opens the
 *   race this issue exists to close, which is why the survival tests below are the strict half.
 * - **Under-strip** (a reply counted as input) → a spurious `busy:recent-input` hold that
 *   clears on the next settle. Fail-safe, and now visible rather than silent.
 *
 * ## The table is derived from a PINNED dependency
 *
 * Every pattern below was read out of `@xterm/xterm@{@link XTERM_REPLY_TABLE_VERSION}`'s
 * bundle — each `triggerDataEvent` call site that emits a reply rather than a keystroke. A
 * version bump is therefore a REVIEW TRIGGER for this file: a newly-answered query (kitty
 * keyboard, XTVERSION) becomes an uncounted-reply hold until its shape is added here. Two
 * patterns below are pre-emptive for that reason and match nothing stock xterm 5.5 emits.
 *
 * ## Case sensitivity is load-bearing
 *
 * `ESC[C` is Right-arrow and `ESC[1;5C` is Ctrl-Right. The CSI family pattern keys on a
 * LOWERCASE final byte set (`c`/`n`/`t`/`y`); an `i` flag on it would strip every arrow key,
 * Home/End and shift-Tab out of the signal. No pattern here carries `i`, and
 * `terminal-replies.test.ts` pins the survival of those exact sequences.
 */

/**
 * The `@xterm/xterm` version whose emission sites this table was enumerated from. Bumping the
 * dependency past it means re-reading its `triggerDataEvent` call sites; a test asserts this
 * constant against the installed package's version so the bump cannot pass silently.
 */
export const XTERM_REPLY_TABLE_VERSION = '5.5.0';

/**
 * Sequences a terminal emulator sends UPSTREAM in answer to the application, never as a
 * human action. Anchored one shape at a time — never a blanket "starts with ESC[" — so a
 * keystroke can only be eaten by a pattern that names its exact form.
 *
 * What each covers, in xterm 5.5.0's own emission order:
 *
 *   1. The CSI answer family, keyed on a lowercase final byte:
 *      - DA1  `ESC[?1;2c`, `ESC[?6c`            (`sendDeviceAttributesPrimary`)
 *      - DA2  `ESC[>0;276;0c`, `ESC[>85;95;0c`, `ESC[>83;40003;0c`
 *      - DSR  `ESC[0n`                          (`deviceStatus`, param 5)
 *      - XTWINOPS `ESC[4;h;wt`, `ESC[6;h;wt`, `ESC[8;rows;colst`
 *      - DECRPM `ESC[?2004$y`, `ESC[1;2$y`      (`_reportMode`)
 *      No key sequence xterm can produce ends in `c`, `n`, `t` or `y` — its key finals are
 *      `~ A B C D F H I O Z R M m`, all outside this class.
 *   2. CPR `ESC[12;40R` and DECXCPR `ESC[?12;40R` — TWO params, not three. (An earlier
 *      three-param pattern would have missed both.)
 *   3. The kitty-keyboard query answer, for a fork that grows one. Its literal `?` is what
 *      keeps it off real kitty-ENCODED keystrokes, which carry no `?`.
 *   4. Focus in/out `ESC[I` / `ESC[O`. Stripped deliberately: a focus report cannot change
 *      composer CONTENT, whereas a click that could carries its own mouse report — which is
 *      preserved (see below). So this costs no coverage and stops an alt-tab holding mail.
 *   5. DECRQSS `ESC P 1 $ r … ESC \` (`requestStatusString`).
 *   6. XTVERSION `ESC P > | … ESC \` — pre-emptive; stock 5.5.0 never answers it.
 *   7. OSC colour reports `ESC ] 10;rgb:…` / `ESC ] 4;12;rgb:…`, terminated by ST or BEL.
 *
 * NOT stripped, on purpose:
 *
 *   - **Mouse reports** (`ESC[<0;10;5M`, `ESC[<0;10;5m`, and the X10 `ESC[M` + 3 bytes). These
 *     are built from a DOM event by the mouse ENCODERS and pushed through the generic data
 *     path — they are a human ACTION that can change the composer (a click moves the cursor,
 *     a middle-click pastes, a drag selects), not a parser answer. Stripping them would
 *     re-open the race for every mouse-driven TUI. Motion tracking can be chatty, but that
 *     only holds delivery while the mouse is actually moving, and it clears one settle after
 *     it stops — the fail-safe direction.
 *   - **Bracketed paste markers** (`ESC[200~` / `ESC[201~`). A paste is human input.
 *
 * Content-blind by construction: a reply-SHAPED byte run inside a bracketed paste is stripped
 * from the signal while the surrounding pasted text still counts. Intended (over-strip is the
 * safe direction) and pinned by a test.
 */
const TERMINAL_REPLY_PATTERNS: readonly RegExp[] = [
  /\x1b\[[?>=]?[0-9;]*\$?[cnty]/g,
  /\x1b\[\??[0-9]+;[0-9]+R/g,
  /\x1b\[\?[0-9;]*u/g,
  /\x1b\[[IO]/g,
  /\x1bP[0-9]\$r[^\x1b]*\x1b\\/g,
  /\x1bP>\|[^\x1b]*\x1b\\/g,
  /\x1b\][0-9;]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g,
];

/**
 * The human-input residue of one upstream chunk: `data` with every recognized terminal reply
 * removed. Returns `''` when the chunk was nothing but replies — the caller reads that as "no
 * human input here" and leaves the gate's input signal untouched.
 *
 * Pure and allocation-cheap; called on every keystroke, so the common case (plain text with
 * no ESC at all) short-circuits before touching a regex.
 */
export function stripTerminalReplies(data: string): string {
  if (!data.includes('\x1b')) return data;
  let out = data;
  for (const pattern of TERMINAL_REPLY_PATTERNS) {
    out = out.replace(pattern, '');
    if (out === '') return '';
  }
  return out;
}
