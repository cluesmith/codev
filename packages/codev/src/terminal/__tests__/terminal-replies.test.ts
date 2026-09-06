/**
 * Terminal reply filter (Issue #1473).
 *
 * The highest-value tests in this change, because a mistake here is SILENT in both directions:
 * an under-strip holds mail with nobody at the keyboard, and an over-strip quietly stops
 * counting a real keystroke, re-opening the race the issue exists to close while every test
 * about the gate keeps passing.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  stripTerminalReplies,
  terminalReplyMatches,
  escapeBytes,
  XTERM_REPLY_TABLE_VERSION,
} from '../terminal-replies.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = '\x1b\\';

describe('stripTerminalReplies — replies the pinned xterm bundle can emit', () => {
  // Every literal below was read out of @xterm/xterm 5.5.0's own emission sites.
  const REPLIES: ReadonlyArray<readonly [string, string]> = [
    ['DA1 (xterm/rxvt/screen)', `${ESC}[?1;2c`],
    ['DA1 (linux)', `${ESC}[?6c`],
    ['DA2 (xterm)', `${ESC}[>0;276;0c`],
    ['DA2 (screen)', `${ESC}[>83;40003;0c`],
    ['DA2 (rxvt-unicode)', `${ESC}[>85;95;0c`],
    ['DSR status report', `${ESC}[0n`],
    ['XTWINOPS window size (px)', `${ESC}[4;600;800t`],
    ['XTWINOPS cell size (px)', `${ESC}[6;16;8t`],
    ['XTWINOPS text area size', `${ESC}[8;24;80t`],
    ['CPR', `${ESC}[12;40R`],
    ['DECXCPR (two params, not three)', `${ESC}[?12;40R`],
    ['DECRPM private', `${ESC}[?2004$y`],
    ['DECRPM ANSI', `${ESC}[2004$y`],
    ['DECRQSS', `${ESC}P1$r0"q${ST}`],
    ['OSC colour, ST-terminated', `${ESC}]10;rgb:1c1c/1c1c/1c1c${ST}`],
    ['OSC colour, BEL-terminated', `${ESC}]11;rgb:0000/0000/0000${BEL}`],
    ['OSC indexed ansi colour', `${ESC}]4;12;rgb:5f5f/8787/ffff${ST}`],
    ['focus in', `${ESC}[I`],
    ['focus out', `${ESC}[O`],
  ];

  for (const [name, seq] of REPLIES) {
    it(`strips ${name}`, () => {
      expect(stripTerminalReplies(seq)).toBe('');
    });

    it(`strips ${name} from around real text`, () => {
      expect(stripTerminalReplies(`a${seq}b`)).toBe('ab');
    });
  }

  it('strips a burst of several replies in one chunk', () => {
    const burst = `${ESC}[?1;2c${ESC}[0n${ESC}[12;40R${ESC}[I`;
    expect(stripTerminalReplies(burst)).toBe('');
  });
});

describe('stripTerminalReplies — keystrokes must SURVIVE', () => {
  // The case-sensitivity hazard, pinned. `ESC[C` is Right-arrow and `ESC[1;5C` is Ctrl-Right;
  // an `i` flag on the CSI family's lowercase final-byte class would eat every one of these,
  // silently re-opening the race for ordinary keyboard navigation.
  const KEYS: ReadonlyArray<readonly [string, string]> = [
    ['Up', `${ESC}[A`],
    ['Down', `${ESC}[B`],
    ['Right', `${ESC}[C`],
    ['Left', `${ESC}[D`],
    ['Ctrl-Right', `${ESC}[1;5C`],
    ['Alt-Up', `${ESC}[1;3A`],
    ['End', `${ESC}[F`],
    ['Home', `${ESC}[H`],
    ['Shift-Tab', `${ESC}[Z`],
    ['F5', `${ESC}[15~`],
    ['Delete', `${ESC}[3~`],
    ['PageUp', `${ESC}[5~`],
    ['application-cursor Up', `${ESC}OA`],
    ['bare ESC', ESC],
  ];

  for (const [name, seq] of KEYS) {
    it(`preserves ${name}`, () => {
      expect(stripTerminalReplies(seq)).toBe(seq);
    });
  }

  it('preserves plain text, control characters and UTF-8 untouched', () => {
    expect(stripTerminalReplies('hello world')).toBe('hello world');
    expect(stripTerminalReplies('\r')).toBe('\r');
    expect(stripTerminalReplies('\x03')).toBe('\x03'); // ^C
    expect(stripTerminalReplies('\x15')).toBe('\x15'); // ^U
    expect(stripTerminalReplies('héllo 🎉 日本語')).toBe('héllo 🎉 日本語');
  });

  it('preserves bracketed-paste markers — a paste is human input', () => {
    const paste = `${ESC}[200~pasted text${ESC}[201~`;
    expect(stripTerminalReplies(paste)).toBe(paste);
  });
});

describe('stripTerminalReplies — mouse reports COUNT as input', () => {
  // A mouse report is a human ACTION that can change the composer: a click moves the cursor, a
  // middle-click pastes, a drag selects. The encoders build it from a DOM event and push it
  // through the generic data path — it is not a parser answer. Stripping it would re-open the
  // race for every mouse-driven TUI.
  it('preserves an SGR press', () => {
    expect(stripTerminalReplies(`${ESC}[<0;10;5M`)).toBe(`${ESC}[<0;10;5M`);
  });

  it('preserves an SGR release', () => {
    expect(stripTerminalReplies(`${ESC}[<0;10;5m`)).toBe(`${ESC}[<0;10;5m`);
  });

  it('preserves an SGR drag/motion report', () => {
    expect(stripTerminalReplies(`${ESC}[<32;11;5M`)).toBe(`${ESC}[<32;11;5M`);
  });

  it('preserves an X10 report (ESC[M + 3 bytes)', () => {
    const x10 = `${ESC}[M${String.fromCharCode(32, 42, 38)}`;
    expect(stripTerminalReplies(x10)).toBe(x10);
  });
});

describe('stripTerminalReplies — mixed chunks and documented edge behaviour', () => {
  it('keeps the human residue of a chunk that mixes text with a reply', () => {
    expect(stripTerminalReplies(`a${ESC}[12;40Rb`)).toBe('ab');
  });

  it('returns the chunk unchanged when it contains no ESC at all (the common path)', () => {
    expect(stripTerminalReplies('just typing')).toBe('just typing');
  });

  it('returns empty for a chunk that is nothing but replies', () => {
    expect(stripTerminalReplies(`${ESC}[?1;2c${ESC}[0n`)).toBe('');
  });

  it('is content-blind inside a bracketed paste: a reply-SHAPED run is stripped, the paste is not', () => {
    // Documented and deliberate. It is the OVER-strip (safe) direction — the surrounding pasted
    // text still counts as input, so the gate still holds.
    const pasted = `${ESC}[200~before${ESC}[0nafter${ESC}[201~`;
    expect(stripTerminalReplies(pasted)).toBe(`${ESC}[200~beforeafter${ESC}[201~`);
  });

  it('has no cross-call state (the module-level regexes carry `g`)', () => {
    const seq = `${ESC}[?1;2c`;
    expect(stripTerminalReplies(seq)).toBe('');
    expect(stripTerminalReplies(seq)).toBe('');
    expect(stripTerminalReplies(seq)).toBe('');
  });
});

describe('the reply table is pinned to a specific xterm version', () => {
  // The table above is derived from ONE bundle's emission sites. A version bump can add a
  // newly-answered query (kitty keyboard, XTVERSION), and an unrecognised reply becomes an
  // uncounted-reply hold — so the bump must not pass silently.
  it('matches the installed @xterm/xterm version', () => {
    const require = createRequire(import.meta.url);
    const pkg = require('@xterm/xterm/package.json') as { version: string };
    expect(pkg.version).toBe(XTERM_REPLY_TABLE_VERSION);
  });
});

describe('terminalReplyMatches / escapeBytes — the AF_LOG_INPUT_SIGNAL trace', () => {
  // Manual step 1 is "sit with hands off the keyboard and read the log". These two functions
  // ARE that reading. If they lie, the human's PASS is a false pass, and the filter's whole
  // correctness argument rests on it.
  it('names each recognized reply in a chunk, so the human sees WHAT was stripped', () => {
    expect(terminalReplyMatches(`${ESC}[?1;2c${ESC}[0n`)).toEqual([`${ESC}[?1;2c`, `${ESC}[0n`]);
  });

  it('reports no matches for a chunk that is purely typed text', () => {
    expect(terminalReplyMatches('hello')).toEqual([]);
  });

  it('agrees with stripTerminalReplies about a mixed chunk', () => {
    const chunk = `a${ESC}[12;40Rb`;
    expect(terminalReplyMatches(chunk)).toEqual([`${ESC}[12;40R`]);
    expect(stripTerminalReplies(chunk)).toBe('ab');
  });

  it('has no cross-call state either (same `g` regexes)', () => {
    const seq = `${ESC}[0n`;
    expect(terminalReplyMatches(seq)).toEqual([seq]);
    expect(terminalReplyMatches(seq)).toEqual([seq]);
  });

  it('renders ESC as \\e so a logged reply cannot repaint the terminal reading the log', () => {
    expect(escapeBytes(`${ESC}[?1;2c`)).toBe('\\e[?1;2c');
    expect(escapeBytes(escapeBytes(`${ESC}[0n`))).not.toContain(ESC);
  });

  it('renders other C0 controls and DEL as \\xNN, and leaves printable bytes alone', () => {
    expect(escapeBytes(`${BEL}\r\n\x7f`)).toBe('\\x07\\x0d\\x0a\\x7f');
    expect(escapeBytes('plain text 123')).toBe('plain text 123');
  });

  it('emits no raw control byte for any reply the filter recognizes', () => {
    // The trace prints these verbatim into a live terminal. One unescaped ESC and the operator
    // is reading a log that has moved their cursor.
    for (const reply of terminalReplyMatches(`${ESC}[?1;2c${ESC}[0n${ESC}]11;rgb:0000/0000/0000${BEL}`)) {
      // eslint-disable-next-line no-control-regex
      expect(escapeBytes(reply)).not.toMatch(/[\x00-\x1f\x7f]/);
    }
  });
});
