/**
 * Spec 1963 scenario 18: the Work and Decisions panels take their colours and fonts from VS Code's
 * theme. The shared views' stylesheet colours everything through `--codev-wv-*` tokens whose
 * defaults are the dashboard's dark palette, so a token the VS Code stylesheet leaves unmapped would
 * stay dark in a light or high-contrast theme. This holds `vscode-theme.css` to the full token list
 * read from the shared stylesheet, so a token added there fails here until it is mapped.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHARED = readFileSync(resolve(__dirname, '../../../../packages/workspace-views/src/styles.css'), 'utf8');
const THEME = readFileSync(resolve(__dirname, '../workspace-views/webview/vscode-theme.css'), 'utf8');

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every token the shared stylesheet reads. */
const used = [...new Set([...withoutComments(SHARED).matchAll(/var\((--codev-wv-[a-z0-9-]+)/g)].map(m => m[1]))].sort();

/** The VS Code stylesheet's `:root` mappings, token → value. */
function mappings(): Map<string, string> {
  const root = withoutComments(THEME).match(/:root\s*\{([^}]*)\}/);
  expect(root, 'vscode-theme.css has a :root block').not.toBeNull();
  const out = new Map<string, string>();
  for (const m of root![1].matchAll(/(--codev-wv-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    expect(out.has(m[1]), `${m[1]} is mapped once`).toBe(false);
    out.set(m[1], m[2].trim());
  }
  return out;
}

describe('vscode-theme.css', () => {
  it('reads the token list from the shared stylesheet', () => {
    expect(used.length).toBeGreaterThanOrEqual(28);
  });

  it('maps every token the shared stylesheet uses, and no other', () => {
    expect([...mappings().keys()].sort()).toEqual(used);
  });

  it("maps each to VS Code's theme: a --vscode-* variable, directly or through another mapped token", () => {
    const map = mappings();
    // Follows token references down to the --vscode-* variables they end in.
    const reachesVscode = (value: string, seen: Set<string>): boolean => {
      if (/var\(--vscode-[A-Za-z0-9-]+/.test(value)) { return true; }
      return [...value.matchAll(/var\((--codev-wv-[a-z0-9-]+)/g)].some(([, ref]) => {
        expect(map.has(ref), `${ref} is mapped`).toBe(true);
        if (seen.has(ref)) { return false; }
        return reachesVscode(map.get(ref)!, new Set([...seen, ref]));
      });
    };
    for (const [token, value] of map) {
      expect(reachesVscode(value, new Set([token])), token).toBe(true);
    }
  });

  it("takes the accent from the link colour, and draws on it in the page colour (never the button's)", () => {
    // High-contrast themes make the button background black, and the accent is also text on the
    // page (item ids, links): with the button pair it vanished on a black page (found rendered).
    // The link colour reads on the editor background in every theme; contrast is symmetric, so the
    // editor background reads on an accent fill.
    const map = mappings();
    expect(map.get('--codev-wv-accent')).toBe('var(--vscode-textLink-foreground)');
    expect(map.get('--codev-wv-on-accent')).toBe('var(--vscode-editor-background)');
    expect([...map.values()].some(v => v.includes('--vscode-button-background'))).toBe(false);
  });

  it('draws muted text in a colour meant to be read, not the disabled-control colour', () => {
    // Light Modern draws disabledForeground at half alpha: section labels measured 2.1:1 rendered.
    const map = mappings();
    expect(map.get('--codev-wv-fg-muted')).toMatch(/^var\(--vscode-input-placeholderForeground/);
    expect([...map.values()].some(v => v.includes('--vscode-disabledForeground'))).toBe(false);
  });

  it("sizes text from VS Code's UI font size: rows at it, smaller steps a fixed distance below", () => {
    // The dashboard's 16px rows read larger than the 13px workbench around the panels.
    const map = mappings();
    const sizes = [...map.keys()].filter(token => token.startsWith('--codev-wv-font-size-'));
    expect(sizes.sort()).toEqual(['lg', 'md', 'sm', 'xl', 'xs', 'xxl', 'xxs'].map(s => `--codev-wv-font-size-${s}`));
    expect(map.get('--codev-wv-font-size-xl')).toBe('var(--vscode-font-size)');
    for (const token of sizes) {
      expect(map.get(token), token).toMatch(/^(var\(--vscode-font-size\)|calc\(var\(--vscode-font-size\) [+-] \dpx\))$/);
    }
  });

  it('draws the no-file state as plain description text, not a warning', () => {
    const rule = withoutComments(THEME).match(/\.decisions-notice--no-file\s*\{([^}]*)\}/);
    expect(rule, 'a .decisions-notice--no-file rule').not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*var\(--vscode-descriptionForeground\)/);
    expect(rule![1]).toMatch(/background:\s*transparent/);
  });

  it("draws waiting and error text in VS Code's list colours, which are made to be read", () => {
    // Light themes' chart yellow and error foreground measured under 3:1 as text, rendered.
    const map = mappings();
    expect(map.get('--codev-wv-status-waiting')).toMatch(/^var\(--vscode-list-warningForeground,/);
    expect(map.get('--codev-wv-status-error')).toMatch(/^var\(--vscode-list-errorForeground,/);
    // Implementing sits between them, mixed from the two: the chart orange measured 2.9:1 as text
    // on Light Modern's white, rendered.
    expect(map.get('--codev-wv-status-implementing'))
      .toBe('color-mix(in srgb, var(--codev-wv-status-error) 50%, var(--codev-wv-status-waiting))');
  });

  it('uses no literal colour of its own anywhere', () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black)\b/i;
    const declarations = [...withoutComments(THEME).matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)]
      .filter(([, prop]) => prop !== 'white-space')
      .filter(([, , value]) => literal.test(value))
      .map(([declaration]) => declaration);
    expect(declarations).toEqual([]);
  });
});
