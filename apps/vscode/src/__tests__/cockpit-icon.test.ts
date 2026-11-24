/**
 * Spec 1963: the Codev Cockpit's activity-bar icon is the Codev icon rotated 90° clockwise — the
 * same path, wrapped in `rotate(90 400 400)`, not a redrawn shape.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ICONS = resolve(__dirname, '../../icons');
const codev = readFileSync(resolve(ICONS, 'codev.svg'), 'utf8');
const cockpit = readFileSync(resolve(ICONS, 'codev-cockpit.svg'), 'utf8');

/** The `<svg …>` open tag. */
function svgTag(svg: string): string {
  const match = svg.match(/^<svg\b[^>]*>/);
  if (!match) { throw new Error('no <svg> open tag'); }
  return match[0];
}

/** Every `d` attribute in the file. */
function paths(svg: string): string[] {
  return [...svg.matchAll(/\bd="([^"]*)"/g)].map(m => m[1]);
}

describe('icons/codev-cockpit.svg', () => {
  it('has the same canvas as codev.svg', () => {
    expect(svgTag(cockpit)).toBe(svgTag(codev));
  });

  it('carries exactly codev.svg path, unchanged', () => {
    expect(paths(codev)).toHaveLength(1);
    expect(paths(cockpit)).toEqual(paths(codev));
  });

  it('wraps that path, and only it, in a clockwise quarter turn about the centre', () => {
    const pathElement = codev.match(/<path\b[^>]*\/>/)?.[0];
    expect(pathElement).toBeDefined();
    expect(cockpit).toBe(`${svgTag(codev)}<g transform="rotate(90 400 400)">${pathElement}</g></svg>\n`);
  });
});
