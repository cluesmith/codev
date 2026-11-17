// Structural grammar for the decisions file (Spec 1819).
//
// One line classifier shared by the parser and the splice, so that what the tab
// shows and what a write validates can never disagree about structure. It is a
// subset of CommonMark:
//   - fence lines: up to three leading spaces, then 3+ backticks or tildes. A fence
//     opened by a run of N characters closes at the next line of the same character
//     with at least N characters and nothing but whitespace after it. An unclosed
//     fence runs to end of file.
//   - heading lines: unfenced, up to three leading spaces, 1–6 `#`, then a space or
//     end of line (ATX only; setext underlines are not structural).
//   - Your-word lines: unfenced, up to three leading spaces, then `**Your word:**`.
//
// Offsets are string (UTF-16) offsets into the original text, so a splice can
// insert at an exact position and preserve every other character.

export type LineEnding = '' | '\n' | '\r\n';

export interface SourceLine {
  /** 0-based line number. */
  index: number;
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's last content character (before the line ending). */
  end: number;
  /** The line's terminator ('' only for a final line without a newline). */
  eol: LineEnding;
  /** Line content without its terminator. */
  text: string;
  /** True for content inside a fence and for the fence delimiter lines themselves. */
  fenced: boolean;
  /** True for a fence delimiter line (opening or closing). */
  fenceDelimiter: boolean;
  /** ATX heading level (1–6) for an unfenced heading line, else 0. */
  headingLevel: number;
  /** Heading text (closing `#` sequence and surrounding whitespace removed). */
  headingText: string;
  /** True for an unfenced `**Your word:**` line. */
  yourWord: boolean;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const YOUR_WORD_RE = /^ {0,3}\*\*Your word:\*\*/;

/** The `**Your word:**` label, as written in the file. */
export const YOUR_WORD_LABEL = '**Your word:**';

/** Strip an ATX heading's optional closing sequence (` ##`), per CommonMark. */
function stripClosingHashes(text: string): string {
  if (/^#+$/.test(text)) return '';
  return text.replace(/[ \t]+#+$/, '').trim();
}

/** Whether `text`, taken as a standalone line, is a fence delimiter. */
export function isFenceLine(text: string): boolean {
  return FENCE_RE.test(text);
}

/** Whether `text`, taken as an unfenced line, is an ATX heading. */
export function isHeadingLine(text: string): boolean {
  return HEADING_RE.test(text);
}

/** Whether `text`, taken as an unfenced line, is a `**Your word:**` line. */
export function isYourWordLine(text: string): boolean {
  return YOUR_WORD_RE.test(text);
}

/** Split `text` into classified lines with their original offsets and terminators. */
export function classifyLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let openFence: { char: string; length: number } | null = null;
  let pos = 0;
  let index = 0;

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    let end: number;
    let eol: LineEnding;
    let next: number;
    if (nl === -1) {
      end = text.length;
      eol = '';
      next = text.length;
    } else if (nl > pos && text[nl - 1] === '\r') {
      end = nl - 1;
      eol = '\r\n';
      next = nl + 1;
    } else {
      end = nl;
      eol = '\n';
      next = nl + 1;
    }
    const lineText = text.slice(pos, end);

    let fenced = false;
    let fenceDelimiter = false;
    let headingLevel = 0;
    let headingText = '';
    let yourWord = false;

    const fenceMatch = FENCE_RE.exec(lineText);
    if (openFence) {
      fenced = true;
      if (
        fenceMatch &&
        fenceMatch[1][0] === openFence.char &&
        fenceMatch[1].length >= openFence.length &&
        fenceMatch[2].trim() === ''
      ) {
        fenceDelimiter = true;
        openFence = null;
      }
    } else if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      // A backtick fence's info string may not contain a backtick (CommonMark).
      fenced = true;
      fenceDelimiter = true;
      openFence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    } else {
      const headingMatch = HEADING_RE.exec(lineText);
      if (headingMatch) {
        headingLevel = headingMatch[1].length;
        headingText = stripClosingHashes(headingMatch[2] ?? '');
      } else if (YOUR_WORD_RE.test(lineText)) {
        yourWord = true;
      }
    }

    lines.push({ index, start: pos, end, eol, text: lineText, fenced, fenceDelimiter, headingLevel, headingText, yourWord });
    pos = next;
    index++;
  }

  return lines;
}

/** The line ending for inserted text: the file's first terminator (LF when it has none). */
export function detectLineEnding(lines: SourceLine[]): '\n' | '\r\n' {
  const first = lines.find(l => l.eol !== '');
  return first?.eol === '\r\n' ? '\r\n' : '\n';
}
