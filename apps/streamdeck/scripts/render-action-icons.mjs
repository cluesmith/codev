// Render the dedicated manifest action icons for `send-queue` and `open-terminal` (#1440).
//
// SINGLE SOURCE: the glyph vectors are NOT re-drawn here — they are parsed out of
// `src/face.ts`'s GLYPHS map, the same vectors the runtime key face draws via
// `labelFaceSvg('comment'|'terminal', …)`. So the action-picker icon and the live hardware key
// agree by construction; changing a glyph in face.ts and re-running this script keeps them aligned.
//
// RASTERIZER: system `rsvg-convert` (librsvg). This is a one-time asset build; per the #1440
// scope we prefer repo-available tooling over adding an npm dependency just to turn SVG into PNG.
// Re-run manually when a glyph changes:  node scripts/render-action-icons.mjs
//
// Frame matches the existing icon convention (measured from the live approve-gate / action
// assets): the full key Image is a rounded rect (rx=12) filled #1C2128 with a white glyph; the
// list/picker Icon is the same glyph, white, on a transparent ground.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'com.cluesmith.codev.sdPlugin');
const FACE_TS = join(HERE, '..', 'src', 'face.ts');

// name → the GLYPHS key in face.ts it renders from.
export const ICONS = [
  { name: 'send-queue', glyph: 'comment' },
  { name: 'open-terminal', glyph: 'terminal' },
];

const GLYPH_COLOR = '#ffffff';
const BG = '#1C2128'; // rounded-key ground, matching icons/action.png & siblings
const CORNER_RADIUS = 12; // measured from the existing 72px key images
const GLYPH_BOX = 24; // GLYPHS are authored in a 24×24 box (see face.ts)
const GLYPH_SIZE = 40; // rendered glyph size inside the 72px canvas (centered, padded)

/**
 * Reproduce face.ts's `stroked()` wrapper — line glyphs (comment/terminal) are stored as their
 * inner paths and wrapped at draw time. Kept identical to `stroked` in src/face.ts.
 */
function stroked(color, paths) {
  return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
}

/**
 * Pull a glyph's inner SVG out of face.ts's GLYPHS map without importing it (GLYPHS is
 * module-private, and face.ts is off-limits to edit while bugfix-1431 is in flight). Supports the
 * two forms GLYPHS uses: `stroked(c, '<…>')` (line glyphs) and a raw `'<… fill="${c}" …>'` string
 * (filled glyphs). Throws loudly if the shape drifts, so a silent stale-icon build can't happen.
 */
export function extractGlyph(faceSrc, key, color) {
  const line = faceSrc.match(new RegExp(`\\n\\s*${key}:\\s*\\(c\\)\\s*=>\\s*([^\\n]*?),?\\s*\\n`));
  if (!line) throw new Error(`glyph '${key}' not found in face.ts GLYPHS`);
  const rhs = line[1].trim();
  const strokedArg = rhs.match(/^stroked\(c,\s*'(.*)'\)$/);
  if (strokedArg) return stroked(color, strokedArg[1]);
  const rawArg = rhs.match(/^`(.*)`$/);
  if (rawArg) return rawArg[1].replace(/\$\{c\}/g, color);
  throw new Error(`glyph '${key}' has an unrecognized form: ${rhs}`);
}

/** Center the 24×24 glyph, scaled to GLYPH_SIZE, inside the 72×72 canvas. */
function centeredGlyph(inner) {
  const scale = GLYPH_SIZE / GLYPH_BOX;
  const offset = (72 - GLYPH_SIZE) / 2;
  return `<g transform="translate(${offset},${offset}) scale(${scale})">${inner}</g>`;
}

function keySvg(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect width="72" height="72" rx="${CORNER_RADIUS}" fill="${BG}"/>${centeredGlyph(inner)}</svg>`;
}

function listSvg(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">${centeredGlyph(inner)}</svg>`;
}

function rasterize(svg, outPath, size) {
  const tmp = join(tmpdir(), `sd-icon-${size}-${Math.abs(hash(outPath))}.svg`);
  writeFileSync(tmp, svg);
  try {
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), tmp, '-o', outPath]);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Stable per-path suffix for the temp filename (Math.random is unavailable in some sandboxes).
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function main() {
  const faceSrc = readFileSync(FACE_TS, 'utf8');
  mkdirSync(join(PLUGIN, 'icons', 'list'), { recursive: true });

  for (const { name, glyph } of ICONS) {
    const inner = extractGlyph(faceSrc, glyph, GLYPH_COLOR);
    const key = keySvg(inner);
    const list = listSvg(inner);
    rasterize(key, join(PLUGIN, 'icons', `${name}.png`), 72);
    rasterize(key, join(PLUGIN, 'icons', `${name}@2x.png`), 144);
    rasterize(list, join(PLUGIN, 'icons', 'list', `${name}.png`), 20);
    rasterize(list, join(PLUGIN, 'icons', 'list', `${name}@2x.png`), 40);
    console.log(`rendered ${name} (from GLYPHS.${glyph}) → 72/144/20/40`);
  }
}

// Run only when invoked directly (`node scripts/render-action-icons.mjs`); importing the module
// for tests exercises the pure helpers above without rasterizing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
