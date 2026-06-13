import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

/**
 * Markdown renderer for Codev artifacts (spec D5 + D7, D7 amended by #1042).
 *
 * - `markdown-it` with `html: true` — raw HTML in the source IS parsed, and **DOMPurify is the
 *   sole guard** (#1042 amends spir-945 D7, which was `html: false`). Safe static HTML renders
 *   (`<img>`, `<details>`, `<kbd>`, `<sub>`, tables…), while `<script>`, event-handler attributes
 *   (`onerror=`…), and `javascript:` / `data:` URLs are stripped. Document-supplied JavaScript
 *   never executes — that boundary is intentional and preserved.
 * - Full-line HTML comments are **removed before block parsing** (fence-aware) and a
 *   cleaned→original line map is threaded through `env`. This keeps annotation / REVIEW markers
 *   out of the rendered body (the #1036 fix) AND stops a comment that sits between two lines of a
 *   paragraph from splitting it, while `data-line` still reports the **original** source line.
 *   Comments inside fenced code blocks are left intact (they are literal code).
 * - A `data-line` core rule stamps the 0-based original source line onto block-level tokens
 *   (paragraphs, headings, list items, code, blockquotes, tables), plus `tabindex="0"` so every
 *   mapped block is keyboard-focusable at render time (D5 + accessibility AC).
 * - Output is sanitized with DOMPurify; `data-*` and `tabindex` survive (DOMPurify default).
 *
 * No host I/O here — the source string is supplied by the caller (a host `FileAdapter` in real
 * use). This module has zero filesystem / fetch / VSCode imports.
 */

const md: MarkdownIt = new MarkdownIt({ html: true, linkify: true });

/** Block tokens that carry a source map and should receive a `data-line` attribute. */
function isMappedBlock(tokenType: string): boolean {
  return tokenType.endsWith('_open') || tokenType === 'fence' || tokenType === 'code_block';
}

/** A line that is entirely a single complete HTML comment (optionally indented). */
function isCommentLine(line: string): boolean {
  return /^\s*<!--.*?-->\s*$/.test(line);
}

/** Opening / closing line of a fenced code block (``` or ~~~). */
const FENCE_RE = /^\s*(```+|~~~+)/;

/**
 * Remove full-line HTML comments that are OUTSIDE fenced code blocks, returning the cleaned
 * source plus a map from cleaned-line index → original-line index. The map lets the `data-line`
 * rule report original source lines even though the parser sees the comment-free text. Comments
 * inside a fence are kept verbatim (they are literal code content, not annotations).
 */
function stripCommentLines(source: string): { text: string; lineMap: number[] } {
  const lines = source.split('\n');
  const kept: string[] = [];
  const lineMap: number[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
      } else if (marker === fence) {
        fence = null;
      }
    } else if (fence === null && isCommentLine(line)) {
      continue; // drop the annotation/comment line so it neither renders nor splits a block
    }
    kept.push(line);
    lineMap.push(i);
  }
  return { text: kept.join('\n'), lineMap };
}

// Core rule: stamp data-line (original source line via env.lineMap) + tabindex on mapped blocks.
// tabindex is stamped at render time (not via a post-render effect) so focusability is present the
// instant the block mounts — closing the effect-timing window the comment overlay's keyboard path
// depends on.
md.core.ruler.push('codev_data_line', (state) => {
  const lineMap = (state.env && state.env.lineMap) as number[] | undefined;
  for (const token of state.tokens) {
    if (token.map && isMappedBlock(token.type)) {
      const cleanedLine = token.map[0];
      const originalLine = lineMap ? lineMap[cleanedLine] ?? cleanedLine : cleanedLine;
      token.attrSet('data-line', String(originalLine));
      token.attrSet('tabindex', '0');
    }
  }
  return true;
});

/** Render markdown to sanitized HTML carrying original-source `data-line` attributes on blocks. */
export function renderMarkdown(source: string): string {
  const { text, lineMap } = stripCommentLines(source);
  // Thread the line map through `env` so the core rule can map cleaned lines back to originals.
  const rawHtml = md.render(text, { lineMap });
  // DOMPurify is the sole raw-HTML guard now (html: true): it strips scripts, event handlers, and
  // dangerous URLs while keeping safe static HTML and `data-*` attributes.
  return DOMPurify.sanitize(rawHtml);
}
