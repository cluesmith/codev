/**
 * Issue #1567 — long frames must never reach the PTY as one write over the input-queue limit.
 *
 * Field shape: a ~1.1 KB single-paragraph architect→builder send arrived as its final ~180
 * bytes, mid-sentence, with `[ok] Message delivered` at the sender. Measured against a real
 * claude TUI (`scripts/bugfix-1567-head-loss-harness.mts`, evidence in
 * `codev/evidence/1567-head-loss/`): the kernel splits a master-side write at the PTY input
 * queue's 1,022-byte high-water mark, the TUI's paste heuristic classifies the first chunk as a
 * paste and discards it, and the remainder plus the Enter type normally. 14/20 losses on the
 * pre-fix edge; 0 on either remedy — chunking under the limit, or an explicit bracketed paste.
 *
 * These tests pin the write edge's new shape. The CONTROL case fails on the pre-fix code, which
 * put the whole 3-line frame on the wire in ONE `write()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeMessageToSession,
  submitMessagePaced,
  framePieces,
  chunkForPty,
  isLongFrame,
  writeStrategyForApp,
  PASTE_BEGIN,
  PASTE_END,
  PASTE_CHUNK_BYTES,
  PASTE_CHUNK_GAP_MS,
  PASTE_ENTER_DELAY_MS,
  BRACKET_MIN_BYTES,
  BRACKETED_PASTE,
  PLAIN_CHUNKED,
} from '../servers/message-write.js';
import { formatArchitectToBuilderMessage } from '../utils/message-format.js';
import { echoNeedle, PASTE_PLACARD_NEEDLES, type DeliverySession } from '../servers/mailbox-delivery.js';
import { watchEchoOnScreen } from '../servers/mailbox-wiring.js';
import { SessionScreen } from '../../terminal/session-screen.js';
import { resetSubmissionChains } from '../servers/session-submit.js';

/** The macOS PTY input-queue high-water mark (TTYHOG − 2) at which the kernel splits a write. */
const PTY_INPUT_QUEUE_BYTES = 1022;

/** A field-sized body: the issue's case 1 was 1,101 bytes, single paragraph. */
const SENTENCE = 'Rulings on your three items follow, and each one is load-bearing for the next step. ';
const BODY = SENTENCE.repeat(13).trim(); // ~1.1 KB, no newlines
/** The PRODUCTION frame for it — 3 lines, ~1.25 KB — so this test cannot drift from the formatter. */
const SPECIMEN = formatArchitectToBuilderMessage('builder-bugfix-4711', BODY, undefined, false, 'architect:main');

function makeSession() {
  const writes: string[] = [];
  const at: number[] = [];
  const start = Date.now();
  return {
    id: 'term-1567',
    writes,
    at,
    write: (data: string): boolean => {
      writes.push(data);
      at.push(Date.now() - start);
      return true;
    },
  };
}

/** Strip the bracket markers and reassemble the body a TUI would receive between them. */
function reassemble(pieces: string[]): { body: string; opens: number; closes: number } {
  const joined = pieces.join('');
  return {
    body: joined.replace(PASTE_BEGIN, '').replace(PASTE_END, ''),
    opens: pieces.filter((p) => p.includes(PASTE_BEGIN)).length,
    closes: pieces.filter((p) => p.includes(PASTE_END)).length,
  };
}

describe('Issue #1567 — the write edge never hands the PTY more than its input queue holds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CONTROL: a field-sized 3-line frame goes out in pieces under the queue limit (one write on the old edge)', () => {
    expect(SPECIMEN.split('\n')).toHaveLength(3);
    expect(Buffer.byteLength(SPECIMEN)).toBeGreaterThan(PTY_INPUT_QUEUE_BYTES);

    const session = makeSession();
    writeMessageToSession(session, SPECIMEN, false);
    vi.runAllTimers();

    const pieces = session.writes.slice(0, -1);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      // Markers included: nothing on the wire is ever larger than the chunk size.
      expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(PASTE_CHUNK_BYTES);
      expect(Buffer.byteLength(piece)).toBeLessThan(PTY_INPUT_QUEUE_BYTES);
    }
    expect(session.writes.at(-1)).toBe('\r');
  });

  it('the frame travels as ONE bracketed paste: markers on the first and last piece, body intact, Enter outside', () => {
    const session = makeSession();
    const endTime = writeMessageToSession(session, SPECIMEN, false);
    vi.runAllTimers();

    const pieces = session.writes.slice(0, -1);
    expect(pieces[0].startsWith(PASTE_BEGIN)).toBe(true);
    expect(pieces.at(-1)!.endsWith(PASTE_END)).toBe(true);
    const { body, opens, closes } = reassemble(pieces);
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    // Newlines travel as \r inside the bracket (what a terminal emits on paste); nothing else changes.
    expect(body).toBe(SPECIMEN.replace(/\n/g, '\r'));
    // The Enter is its own write, after the settle, and the returned time is the Enter's.
    expect(session.writes.at(-1)).toBe('\r');
    expect(endTime).toBe((pieces.length - 1) * PASTE_CHUNK_GAP_MS + PASTE_ENTER_DELAY_MS);
  });

  it('pieces are paced PASTE_CHUNK_GAP_MS apart so the reader drains between them', () => {
    const session = makeSession();
    writeMessageToSession(session, SPECIMEN, false);
    vi.runAllTimers();

    const pieces = session.at.slice(0, -1);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i] - pieces[i - 1]).toBe(PASTE_CHUNK_GAP_MS);
    expect(session.at.at(-1)! - pieces.at(-1)!).toBe(PASTE_ENTER_DELAY_MS);
  });

  it('noEnter sends the paste and nothing after it', () => {
    const session = makeSession();
    writeMessageToSession(session, SPECIMEN, true);
    vi.runAllTimers();
    expect(session.writes.some((w) => w === '\r')).toBe(false);
    expect(session.writes.at(-1)!.endsWith(PASTE_END)).toBe(true);
  });

  it('never splits a UTF-8 sequence across pieces', () => {
    const arrows = '→'.repeat(700); // 3 bytes each: 2,100 bytes, no clean 512-byte boundary
    const pieces = chunkForPty(arrows);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(PASTE_CHUNK_BYTES);
      expect(p.includes('�')).toBe(false); // no replacement char from a torn sequence
    }
    expect(pieces.join('')).toBe(arrows);
  });

  it('a literal paste marker inside the body cannot end the paste early', () => {
    const body = `${'x'.repeat(300)} ${PASTE_END}rm -rf / ${PASTE_BEGIN} ${'y'.repeat(300)}`;
    const pieces = framePieces(body, BRACKETED_PASTE);
    const joined = pieces.join('');
    expect(joined.split(PASTE_BEGIN)).toHaveLength(2); // exactly one opener…
    expect(joined.split(PASTE_END)).toHaveLength(2); // …and one closer, both ours
    expect(joined.startsWith(PASTE_BEGIN)).toBe(true);
    expect(joined.endsWith(PASTE_END)).toBe(true);
    expect(joined).toContain('rm -rf /'); // the text itself is kept, only the markers go
  });

  it('a body made only of paste markers becomes one empty, well-formed paste', () => {
    const pieces = framePieces(PASTE_END.repeat(60), BRACKETED_PASTE); // >256 B, all markers
    expect(pieces).toEqual([PASTE_BEGIN + PASTE_END]);
    expect(pieces.join('')).not.toContain('undefined');
  });

  it('short frames keep the pre-#1567 single write, byte for byte (raw slash commands included)', () => {
    const short = formatArchitectToBuilderMessage('spir-1', 'please review the plan');
    expect(short.split('\n')).toHaveLength(3);
    expect(Buffer.byteLength(short)).toBeLessThanOrEqual(BRACKET_MIN_BYTES);

    for (const msg of [short, '/arch-init main']) {
      const session = makeSession();
      const endTime = writeMessageToSession(session, msg, false);
      vi.runAllTimers();
      expect(session.writes).toEqual([msg, '\r']);
      expect(endTime).toBe(50);
    }
  });

  it('isLongFrame: over BRACKET_MIN_BYTES OR 4+ lines takes the paste path; at the byte limit does not', () => {
    expect(isLongFrame('x'.repeat(BRACKET_MIN_BYTES))).toBe(false);
    expect(isLongFrame('x'.repeat(BRACKET_MIN_BYTES + 1))).toBe(true);
    expect(isLongFrame('a\nb\nc')).toBe(false);
    expect(isLongFrame('a\nb\nc\nd')).toBe(true);
  });

  it('the opt-out strategy keeps the per-line shape (no markers, \\n kept) and still caps every write', () => {
    const longLine = 'y'.repeat(1300);
    const msg = `h1\n${longLine}\nfooter`;
    const pieces = framePieces(msg, PLAIN_CHUNKED);
    expect(pieces.join('')).toBe(msg);
    expect(pieces.some((p) => p.includes(PASTE_BEGIN) || p.includes(PASTE_END))).toBe(false);
    expect(pieces[0]).toBe('h1\n');
    for (const p of pieces) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(PASTE_CHUNK_BYTES);
    expect(pieces.length).toBeGreaterThan(3); // the 1,300-byte line was split

    const session = makeSession();
    writeMessageToSession(session, msg, false, 0, PLAIN_CHUNKED);
    vi.runAllTimers();
    expect(session.writes.slice(0, -1)).toEqual(pieces);
    expect(session.writes.at(-1)).toBe('\r');
  });

  it('strategy by app: the measured harnesses are bracketed, agy opts out', () => {
    expect(writeStrategyForApp('claude')).toBe(BRACKETED_PASTE);
    expect(writeStrategyForApp('codex')).toBe(BRACKETED_PASTE);
    expect(writeStrategyForApp('agy')).toBe(PLAIN_CHUNKED);
    expect(writeStrategyForApp(undefined)).toBe(BRACKETED_PASTE);
  });

  it('submitMessagePaced forwards the strategy to the write', async () => {
    resetSubmissionChains();
    const bracketed = makeSession();
    const plain = { ...makeSession(), id: 'term-1567-plain' };
    const a = submitMessagePaced(bracketed, SPECIMEN, false, () => null);
    const b = submitMessagePaced(plain, SPECIMEN, false, () => null, undefined, PLAIN_CHUNKED);
    await vi.runAllTimersAsync();
    expect(await a).toEqual({ status: 'written' });
    expect(await b).toEqual({ status: 'written' });
    expect(bracketed.writes[0].startsWith(PASTE_BEGIN)).toBe(true);
    expect(plain.writes.some((w) => w.includes(PASTE_BEGIN))).toBe(false);
    expect(plain.writes.join('')).toBe(SPECIMEN + '\r');
  });
});

describe('Issue #1567 — echo verification understands the paste placard', () => {
  const NEEDLE = echoNeedle(SPECIMEN);
  const RULE = '─'.repeat(30);

  function screenSession(): { session: DeliverySession; screen: SessionScreen } {
    const screen = new SessionScreen(120, 40);
    screen.feed(`❯ \r\n${RULE}\r\n`);
    return { session: { id: 'term-echo', gateScreen: screen } as unknown as DeliverySession, screen };
  }

  it('the header needle is still recognised once the paste is submitted and re-rendered', async () => {
    const { session, screen } = screenSession();
    const watch = await watchEchoOnScreen(session, NEEDLE);
    screen.feed(`\r\n> ${SPECIMEN.split('\n')[0]}\r\n`);
    expect(await watch.verify()).toBe(true);
  });

  it("claude's placard is evidence: `[Pasted text #N +M lines]` appearing after the write verifies", async () => {
    const { session, screen } = screenSession();
    const watch = await watchEchoOnScreen(session, NEEDLE);
    screen.feed('\x1b[2K❯ [Pasted text #1 +2 lines]\r\n');
    expect(await watch.verify()).toBe(true);
  });

  it("codex's placard is evidence too: `[Pasted Content N chars]`", async () => {
    const { session, screen } = screenSession();
    const watch = await watchEchoOnScreen(session, NEEDLE);
    screen.feed('\x1b[2K› [Pasted Content 1168 chars]\r\n');
    expect(await watch.verify()).toBe(true);
  });

  it('a placard that was ALREADY on screen before the write is not evidence', async () => {
    const { session, screen } = screenSession();
    screen.feed('❯ [Pasted text #1 +2 lines]\r\n');
    const watch = await watchEchoOnScreen(session, NEEDLE);
    // Nothing new arrives: the pre-write count is unchanged, so this must answer false.
    expect(await watch.verify()).toBe(false);
  }, 5_000);

  it('the placard needles are the normalized forms both TUIs render', () => {
    expect(PASTE_PLACARD_NEEDLES).toEqual(['Pastedtext', 'PastedContent']);
  });
});
