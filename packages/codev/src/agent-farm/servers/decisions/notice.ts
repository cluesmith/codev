// The hub architect's notice of a Decisions-tab ruling (#1828).
//
// Once a ruling is written, Tower tells the workspace's hub architect through the
// mailbox, so the hub need not watch the file for it. The file stays the source of
// truth: the notice is best-effort, and a ruling typed into the file by hand still
// reaches the hub only when it scans the file.

import type { RulingRequest } from './splice.js';

/** Tell the hub architect `message`. May throw; the route logs the failure. */
export type RulingNotifier = (message: string) => Promise<void>;

/**
 * The notice for a ruling the splice accepted: `RULED <id>: <word>`, or
 * `QUESTION <id>:` when no word was chosen, with the trimmed comment on the lines after it.
 * The comment is trimmed and split exactly as `spliceRuling` does, so the notice carries
 * the lines that were written to the file.
 */
export function rulingNotice(ruling: RulingRequest): string {
  const head = ruling.word ? `RULED ${ruling.id}: ${ruling.word}` : `QUESTION ${ruling.id}:`;
  const comment = (ruling.comment ?? '').trim().split(/\r\n|\r|\n/).join('\n');
  return comment ? `${head}\n${comment}` : head;
}
