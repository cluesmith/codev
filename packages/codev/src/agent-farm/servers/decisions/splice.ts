// Ruling splice for the decisions file (Spec 1819).
//
// A pure function that writes the owner's ruling into the file's text, or refuses
// with a specific reason and returns no text. The write route is a thin wrapper
// around it: read the file, splice, write back only on success.
//
// The ruling goes directly after the item's `**Your word:**` line: the word on the
// very next line; then the comment, after a blank line when a word was written; then
// a blank line when the line that follows is not already blank. Inserted lines use
// the file's own line ending, a missing final newline on the Your-word line is
// supplied, and every other character is preserved in order. The result is
// re-parsed and must keep the file's structure — anything the explicit checks miss
// (an option word that is itself a heading or fence, say) is `structure-changed`.

import type { DecisionsRefusalCode } from '@cluesmith/codev-types';
import { isFenceLine, isHeadingLine, isYourWordLine } from './grammar.js';
import { parseDecisions, type ParsedDecisions, type ParsedItem } from './parse.js';

/** Longest comment accepted, in characters, after trimming. */
export const MAX_COMMENT_LENGTH = 10_000;

export interface RulingRequest {
  id: string;
  /** The chosen option word; absent or '' when none was chosen. */
  word?: string;
  /** Free text; trimmed, internal line breaks kept. */
  comment?: string;
  /** The item's fingerprint as the card last rendered it. */
  fingerprint: string;
}

/** The refusals a splice can return; the rest belong to the route (file and config). */
export type SpliceRefusalCode = Exclude<DecisionsRefusalCode, 'not-utf8' | 'write-failed' | 'not-found' | 'outside-workspace' | 'config-error'>;

export interface SpliceRefusal {
  ok: false;
  code: SpliceRefusalCode;
  message: string;
}

export type SpliceResult = { ok: true; text: string } | SpliceRefusal;

function refuse(code: SpliceRefusalCode, message: string): SpliceRefusal {
  return { ok: false, code, message };
}

/** Refuse a comment line that would add structure: a heading, fence or Your-word line. */
function checkCommentLines(commentLines: string[]): SpliceRefusal | null {
  for (const [n, line] of commentLines.entries()) {
    const where = `Line ${n + 1} of the comment`;
    if (isHeadingLine(line)) return refuse('comment-heading', `${where} is a markdown heading ("${line.trim()}"); headings end the item.`);
    if (isFenceLine(line)) return refuse('comment-fence', `${where} is a code fence ("${line.trim()}"), which would change how the file parses.`);
    if (isYourWordLine(line)) return refuse('comment-your-word', `${where} starts with **Your word:**, which would give the item a second Your-word line.`);
  }
  return null;
}

/** Find the request's item in `## Open` and check it can take a ruling now. */
function checkItem(parsed: ParsedDecisions, request: RulingRequest, word: string): ParsedItem | SpliceRefusal {
  const { id } = request;
  if (parsed.problems.includes('open-multiple')) {
    return refuse('open-multiple', 'The file has more than one ## Open section; the tab cannot tell where items belong, so it writes nothing.');
  }
  const matches = parsed.items.filter(item => item.id === id);
  if (matches.length === 0) return refuse('heading-missing', `Item ${id} is not in ## Open (it may have been ruled or removed).`);
  if (matches.length > 1) return refuse('heading-duplicate', `Item ${id} appears ${matches.length} times in ## Open; rulings for it go through main.`);
  const item = matches[0];
  if (item.yourWordLines.length === 0) return refuse('your-word-missing', `Item ${id} has no **Your word:** line to rule under.`);
  if (item.yourWordLines.length > 1) return refuse('your-word-multiple', `Item ${id} has ${item.yourWordLines.length} **Your word:** lines; the tab cannot tell which one to rule under.`);
  if (item.currentRuling !== '') return refuse('already-ruled', `Item ${id} already has text under its **Your word:** line; a change goes through main or a hand edit.`);
  if (word && !item.options.some(option => option.word === word)) {
    return refuse('unknown-word', `"${word}" is not an option on item ${id}'s current **Your word:** line.`);
  }
  if (item.fingerprint !== request.fingerprint) return refuse('item-changed', `Item ${id} changed since it was shown; review it and submit again.`);
  return item;
}

/**
 * Check the spliced text kept the file's structure: the same sections, the same items
 * in the same order, the same options on this item, this item's current ruling equal
 * to the inserted ruling, and every inserted line plain unfenced content.
 */
function verify(
  before: ParsedDecisions,
  after: ParsedDecisions,
  item: ParsedItem,
  ruling: string,
  insertedLines: { from: number; count: number },
): SpliceRefusal | null {
  const sections = (p: ParsedDecisions) =>
    p.lines.filter(l => l.headingLevel === 1 || l.headingLevel === 2).map(l => `${l.headingLevel} ${l.headingText}`).join('\n');
  const changed = (what: string) =>
    refuse('structure-changed', `Writing this ruling into item ${item.id} would change ${what}, so nothing was written.`);

  if (sections(after) !== sections(before) || after.problems.join() !== before.problems.join()) return changed("the file's sections");
  if (after.items.map(i => i.id).join('\n') !== before.items.map(i => i.id).join('\n')) return changed('the list of open items');

  const afterItem = after.items.find(i => i.headingLine === item.headingLine);
  if (!afterItem || afterItem.id !== item.id) return changed('the list of open items');
  if (JSON.stringify(afterItem.options) !== JSON.stringify(item.options)) return changed("the item's options");
  if (afterItem.currentRuling !== ruling) return changed("the item's text after its **Your word:** line");

  const inserted = after.lines.slice(insertedLines.from, insertedLines.from + insertedLines.count);
  if (inserted.some(l => l.fenced || l.headingLevel > 0 || l.yourWord)) return changed("the file's structure (the ruling would add a heading or fence)");
  return null;
}

/** Apply the owner's ruling to the decisions file's text, or refuse with the reason. */
export function spliceRuling(text: string, request: RulingRequest): SpliceResult {
  if (!request.id) return refuse('invalid-request', 'The request names no item.');
  if (!request.fingerprint) return refuse('invalid-request', 'The request carries no item fingerprint.');

  const word = request.word ?? '';
  const comment = (request.comment ?? '').trim();
  if (!word && !comment) return refuse('empty-ruling', 'Choose an option or write a comment.');
  if (comment.length > MAX_COMMENT_LENGTH) {
    return refuse('comment-too-long', `The comment is ${comment.length} characters; the limit is ${MAX_COMMENT_LENGTH}.`);
  }
  const commentLines = comment ? comment.split(/\r\n|\r|\n/) : [];
  const commentRefusal = checkCommentLines(commentLines);
  if (commentRefusal) return commentRefusal;

  const before = parseDecisions(text);
  const item = checkItem(before, request, word);
  if ('ok' in item) return item;

  const rulingLines = [...(word ? [word] : []), ...(word && comment ? [''] : []), ...commentLines];
  const yourWord = before.lines[item.yourWordLines[0]];
  const following = before.lines[yourWord.index + 1];
  const newLines = following && following.text.trim() !== '' ? [...rulingLines, ''] : rulingLines;

  const at = yourWord.end + yourWord.eol.length;
  const inserted = (yourWord.eol === '' ? before.eol : '') + newLines.map(line => line + before.eol).join('');
  const result = text.slice(0, at) + inserted + text.slice(at);

  // The parser's current ruling is LF-joined whatever the file's line ending.
  const refusal = verify(before, parseDecisions(result), item, rulingLines.join('\n'), {
    from: yourWord.index + 1,
    count: newLines.length,
  });
  if (refusal) return refusal;
  return { ok: true, text: result };
}
