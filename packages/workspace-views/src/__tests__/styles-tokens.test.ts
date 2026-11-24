import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec 1963: every colour and font in the views' stylesheet is a `--codev-wv-*` token (its default
 * the dashboard's value), so each host can map all of them to its own theme. A literal colour would
 * stay the dashboard's in a VS Code light or high-contrast theme.
 */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

/** A token with its default, which may hold one level of parentheses (`rgba(...)`). */
const TOKEN = /var\(--codev-wv-[a-z-]+(?:,(?:[^()]|\([^()]*\))*)?\)/g;
/** Values that carry no colour of their own. */
const NEUTRAL = new Set(['inherit', 'transparent', 'currentcolor', 'none', 'initial', 'unset']);
const NAMED = /\b(white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|pink|cyan|magenta|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

/** Each declaration `prop: value` outside comments, with its line. */
function declarations(): Array<{ line: number; prop: string; value: string }> {
  const out: Array<{ line: number; prop: string; value: string }> = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  text.split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*([a-z-]+)\s*:\s*(.+?);?\s*$/);
    if (m && !raw.trim().endsWith('{')) out.push({ line: i + 1, prop: m[1], value: m[2] });
  });
  return out;
}

describe('styles.css tokens', () => {
  const decls = declarations();

  it('finds the declarations', () => {
    expect(decls.length).toBeGreaterThan(200);
  });

  it('uses no colour outside a --codev-wv-* token', () => {
    const literals = decls
      .filter(({ prop }) => !prop.startsWith('--'))
      .map((d) => ({ ...d, rest: d.value.replace(TOKEN, 'TOKEN') }))
      .filter(({ prop, rest }) => LITERAL.test(rest) || (prop !== 'white-space' && NAMED.test(rest)))
      .map(({ line, prop, value }) => `${line}: ${prop}: ${value}`);
    expect(literals).toEqual([]);
  });

  it('sets every font-family through a token', () => {
    const fonts = decls
      .filter(({ prop }) => prop === 'font-family')
      .filter(({ value }) => !NEUTRAL.has(value.replace(TOKEN, '').trim().toLowerCase()) && value.replace(TOKEN, '').trim() !== '')
      .map(({ line, value }) => `${line}: ${value}`);
    expect(fonts).toEqual([]);
  });

  it('defines no token of its own (each host maps them; the defaults are inline)', () => {
    expect(decls.filter(({ prop }) => prop.startsWith('--codev-wv-'))).toEqual([]);
  });
});
