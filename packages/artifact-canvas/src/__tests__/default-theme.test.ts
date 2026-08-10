import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the public `--codev-canvas-*` token vocabulary shipped by `default-theme.css` (spec 945
 * D4 colors + the #1053 typography tier). The vocabulary is a public contract (spec 945 D4 — "do
 * not change shapes without a spec amendment"), so the snapshot makes any add/remove a reviewed
 * diff rather than a silent contract change.
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../styles/default-theme.css');
const css = readFileSync(cssPath, 'utf8');

/** Extract `--codev-canvas-*` custom-property *declarations* (name: value;), not `var()` refs. */
function declaredTokens(source: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const re = /(--codev-canvas-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    tokens.set(match[1], match[2].trim().replace(/\s+/g, ' '));
  }
  return tokens;
}

describe('default-theme.css token vocabulary', () => {
  const tokens = declaredTokens(css);

  it('declares exactly the locked token list (snapshot)', () => {
    expect([...tokens.keys()].sort()).toMatchInlineSnapshot(`
      [
        "--codev-canvas-accent",
        "--codev-canvas-background",
        "--codev-canvas-border",
        "--codev-canvas-code-background",
        "--codev-canvas-code-font-family",
        "--codev-canvas-code-font-size",
        "--codev-canvas-code-foreground",
        "--codev-canvas-comment-marker",
        "--codev-canvas-font-family",
        "--codev-canvas-font-size",
        "--codev-canvas-foreground",
        "--codev-canvas-gutter",
        "--codev-canvas-h1-size",
        "--codev-canvas-h2-size",
        "--codev-canvas-h3-size",
        "--codev-canvas-h4-size",
        "--codev-canvas-h5-size",
        "--codev-canvas-h6-size",
        "--codev-canvas-line-height",
        "--codev-canvas-link",
        "--codev-canvas-muted",
        "--codev-canvas-paragraph-spacing",
        "--codev-canvas-prose-max-width",
      ]
    `);
  });

  it('ships a non-empty fallback for every token', () => {
    for (const [name, value] of tokens) {
      expect(value, `${name} should have a fallback value`).not.toBe('');
    }
  });

  it('includes each typography token with its github-baseline default', () => {
    expect(tokens.get('--codev-canvas-font-size')).toBe('16px');
    expect(tokens.get('--codev-canvas-line-height')).toBe('1.5');
    expect(tokens.get('--codev-canvas-paragraph-spacing')).toBe('16px');
    expect(tokens.get('--codev-canvas-prose-max-width')).toBe('none');
    expect(tokens.get('--codev-canvas-h1-size')).toBe('2em');
    expect(tokens.get('--codev-canvas-h6-size')).toBe('0.85em');
    expect(tokens.get('--codev-canvas-code-font-size')).toBe('0.85em');
  });

  it('gives inline code its own foreground token (dark-mode contrast, #1053)', () => {
    expect(tokens.has('--codev-canvas-code-foreground')).toBe(true);
    expect(tokens.get('--codev-canvas-code-foreground')).not.toBe('');
  });

  it('covers the standalone MarkdownView root, not just the composed canvas (#1053)', () => {
    // MarkdownView renders `.codev-artifact-canvas-rendered` with no `.codev-artifact-canvas`
    // ancestor, so the typography must name that root explicitly or the exported standalone
    // surface gets no prose styling (consult REQUEST_CHANGES, #1053). Guard both halves:
    // (1) the token + base-font block names the standalone root, and
    // (2) the prose element rules name it too (via the `:is(...)` container group).
    expect(css).toMatch(/\.codev-artifact-canvas,\s*\.codev-artifact-canvas-rendered\s*\{/);
    // Every prose element rule shares the `:is(body, rendered)` container group. Assert the
    // standalone root appears in a representative prose selector (headings) and the code chip.
    expect(css).toMatch(
      /:is\(\.codev-artifact-canvas-body,\s*\.codev-artifact-canvas-rendered\)\s+h1\b/,
    );
    expect(css).toMatch(
      /:is\(\.codev-artifact-canvas-body,\s*\.codev-artifact-canvas-rendered\)\s+code\b/,
    );
    // The gutter is block-local (#1343): the body itself carries NO left padding — each
    // top-level row does, composed surface only (the standalone root gets no row rules).
    expect(css).not.toMatch(/^\.codev-artifact-canvas-body\s*\{[^}]*padding-left/m);
    expect(css).toMatch(
      /\.codev-artifact-canvas-body\s*>\s*\[data-line\]\s*\{[^}]*padding-left:\s*var\(--codev-canvas-gutter\)/,
    );
    expect(css).not.toMatch(/\.codev-artifact-canvas-rendered[^{]*>\s*\[data-line\]/);
  });

  it('reserves block-local leading space on rows (#1343)', () => {
    expect(tokens.get('--codev-canvas-gutter')).toBe('1.9rem');
    // Rows are the positioning context for the in-row "+" and the marker bar.
    expect(css).toMatch(/\.codev-artifact-canvas-body\s*>\s*\[data-line\]\s*\{[^}]*position:\s*relative/);
    // Chrome rows absorb the gutter into their own padding (text x-position preserved).
    expect(css).toMatch(/pre\[data-line\]\s*\{[^}]*calc\(var\(--codev-canvas-gutter\)\s*\+\s*16px\)/);
    expect(css).toMatch(/blockquote\[data-line\]\s*\{[^}]*calc\(var\(--codev-canvas-gutter\)\s*\+\s*1em\)/);
    expect(css).toMatch(/:is\(ul,\s*ol\)\[data-line\]\s*\{[^}]*calc\(var\(--codev-canvas-gutter\)\s*\+\s*2em\)/);
    // The pre row must not scroll (it hosts the "+"); the inner code element scrolls instead.
    expect(css).not.toMatch(/\)\s+pre\s*\{[^}]*overflow/);
    expect(css).toMatch(/pre\s+code\s*\{[^}]*overflow-x:\s*auto/);
    // Injected siblings carry the gutter ONLY at the top level (iter-1 Codex): a nested stack /
    // composer host sits inside a row that already has the gutter — an unscoped margin
    // double-indents it. The child combinator is the load-bearing part of these selectors.
    expect(css).toMatch(
      /\.codev-artifact-canvas-body\s*>\s*\.codev-canvas-marker-cards\s*\{[^}]*margin-left:\s*var\(--codev-canvas-gutter\)/,
    );
    expect(css).toMatch(
      /\.codev-artifact-canvas-body\s*>\s*\.codev-canvas-comment-composer-host\s*\{[^}]*margin-left:\s*var\(--codev-canvas-gutter\)/,
    );
    expect(css).not.toMatch(/^\.codev-canvas-marker-cards\s*\{[^}]*margin-left:\s*var/m);
  });

  it('shows the arrow cursor (not the I-beam) over the composed content body (#1232)', () => {
    // Read-only content with button-driven comments: the I-beam's editing connotation misleads.
    // Composed body only — the standalone MarkdownView surface is deliberately untouched.
    expect(css).toMatch(/^\.codev-artifact-canvas-body\s*\{[^}]*cursor:\s*default/m);
    expect(css).not.toMatch(/\.codev-artifact-canvas-rendered[^{]*\{[^}]*cursor:\s*default/);
  });

  it('sizes the "+" affordance against the prose, with a 24px hit-target floor (#1236/#1343)', () => {
    // The in-row wrapper pins the canvas typography so the "+" renders identically whatever row
    // hosts it (a pre's monospace/85% must not leak in); the button inherits it explicitly —
    // buttons don't inherit fonts by default.
    expect(css).toMatch(
      /\.codev-canvas-row-affordance\s*\{[^}]*font-size:\s*var\(--codev-canvas-font-size\)/,
    );
    expect(css).toMatch(/\.codev-canvas-add-comment\s*\{[^}]*font:\s*inherit/);
    expect(css).toMatch(/\.codev-canvas-add-comment\s*\{[^}]*min-width:\s*24px/);
    expect(css).toMatch(/\.codev-canvas-add-comment\s*\{[^}]*min-height:\s*24px/);
    // The canvas-anchored overlay is gone (#1343); nothing may quietly reintroduce it.
    expect(css).not.toMatch(/\.codev-canvas-overlay\b/);
  });
});
