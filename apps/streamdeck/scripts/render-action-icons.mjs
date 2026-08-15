// Render the dedicated manifest action icons for `send-queue`, `open-terminal` (#1440) and the
// catch-all `action` (#1444).
//
// SINGLE SOURCE: the glyph vectors are NOT re-drawn here — they are parsed out of
// `src/face.ts`'s GLYPHS map, the same vectors the runtime key face draws via
// `labelFaceSvg('comment'|'terminal', …)`. So the action-picker icon and the live hardware key
// agree by construction; changing a glyph in face.ts and re-running this script keeps them aligned.
//
// BRAND-SOURCED: the `action` icon is the exception — it renders from the plugin's own brand mark
// (`icons/plugin.svg`), not a face.ts glyph. `Codev Action` is a configurable catch-all that runs
// any verb, so #1440's terminal glyph both mislabeled it and collided with the new open-terminal
// icon; the Codev mark reads as "a generic Codev action" and needs no new artwork (#1444). The mark
// is already monochrome white on the same viewBox we reuse, so it flows through the identical
// trim → fit → composite pipeline as the glyphs.
//
// FIT: the glyphs don't fill their authored 24×24 box (comment ≈ 18×17, terminal ≈ 20×16), and a
// transparent list icon needs far less padding than a rounded-key image. So we render the glyph,
// trim it to its true drawn bounding box, then scale that bbox to the SAME fill fraction the
// existing icons use (measured: list/* ≈ 95% of frame, key images ≈ 56%). Fitting the bbox — not
// the nominal box — is what keeps the new icons from reading small next to their siblings.
//
// TOOLING: system `rsvg-convert` (librsvg) rasterizes the vector; system `magick` (ImageMagick)
// trims to the glyph bbox, fits, centers, and composites over the rounded-key ground. Both are
// pre-installed dev tools, not npm dependencies — per the #1440 scope, a one-time asset build
// prefers repo-available tooling over adding a dependency just to turn SVG into PNG. Re-run after a
// glyph changes:  node scripts/render-action-icons.mjs   (needs: brew install librsvg imagemagick)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'com.cluesmith.codev.sdPlugin');
const FACE_TS = join(HERE, '..', 'src', 'face.ts');
const BRAND_SVG = join(PLUGIN, 'icons', 'plugin.svg');

// name → the GLYPHS key in face.ts it renders from.
export const ICONS = [
  { name: 'send-queue', glyph: 'comment' },
  { name: 'open-terminal', glyph: 'terminal' },
  { name: 'open-architect', glyph: 'architect' },
];

// name → rendered from the brand mark in icons/plugin.svg instead of a face.ts glyph (#1444).
export const BRAND_ICONS = [{ name: 'action' }];

const GLYPH_COLOR = '#ffffff';
const BG = '#1C2128'; // rounded-key ground, matching icons/action.png & siblings
const CORNER_RADIUS = 12; // measured from the existing 72px key images (scales with size)
const LIST_FILL = 0.94; // glyph bbox / frame for the transparent list icon (siblings ≈ 0.95)
const KEY_FILL = 0.56; //  glyph bbox / frame for the key image (siblings ≈ 0.56)
const RENDER_PX = 512; // high-res glyph raster, downscaled by magick for clean antialiasing

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
 * two forms GLYPHS uses: `stroked(c, '<…>')` (line glyphs) and a raw `` `<… ${c} …>` `` template
 * (filled glyphs), and both bare (`comment:`) and quoted (`'pull-request':`) keys. Throws loudly if
 * the shape drifts, so a silent stale-icon build can't happen.
 */
export function extractGlyph(faceSrc, key, color) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = faceSrc.match(new RegExp(`\\n\\s*['"]?${k}['"]?:\\s*\\(c\\)\\s*=>\\s*([^\\n]*?),?\\s*\\n`));
  if (!line) throw new Error(`glyph '${key}' not found in face.ts GLYPHS`);
  const rhs = line[1].trim();
  const strokedArg = rhs.match(/^stroked\(c,\s*'(.*)'\)$/);
  if (strokedArg) return stroked(color, strokedArg[1]);
  const rawArg = rhs.match(/^`(.*)`$/);
  if (rawArg) return rawArg[1].replace(/\$\{c\}/g, color);
  throw new Error(`glyph '${key}' has an unrecognized form: ${rhs}`);
}

/** The glyph on its own, high-res, transparent — the raster both variants trim and fit from. */
function glyphSvg(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RENDER_PX}" height="${RENDER_PX}" viewBox="0 0 24 24">${inner}</svg>`;
}

/**
 * Pull the brand mark out of icons/plugin.svg: its single `<g>` group (the white handshake path)
 * and the SVG's viewBox. The opaque background `<rect>` is left behind, so the mark renders
 * transparent — the same raster shape renderKey/renderList expect. Throws loudly if the mark's
 * shape drifts, so a silent stale-icon build can't happen. Returns the group already white; unlike
 * the glyphs it carries no `${c}` placeholder, so no recolor step is needed.
 */
export function extractBrandMark(svgSrc) {
  const viewBox = svgSrc.match(/viewBox="([^"]*)"/);
  const group = svgSrc.match(/<g\b[^>]*>[\s\S]*?<\/g>/);
  if (!viewBox || !group) throw new Error('brand mark: expected <svg viewBox> with a <g> group in plugin.svg');
  return { viewBox: viewBox[1], inner: group[0] };
}

/** The brand mark on its own, high-res, transparent — same role as glyphSvg for the glyphs. */
function brandSvg({ viewBox, inner }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RENDER_PX}" height="${RENDER_PX}" viewBox="${viewBox}">${inner}</svg>`;
}

function tmp(tag) {
  return join(tmpdir(), `sd-icon-1440-${tag}`);
}

function ensureTool(bin, install) {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(`'${bin}' not found — this one-off asset build needs it (${install}).`);
  }
}

/** magick expression that trims the high-res glyph to its drawn bbox and scales it to `target` px. */
function fittedGlyph(glyphPng, target) {
  return [glyphPng, '-trim', '+repage', '-resize', `${target}x${target}`];
}

/** Transparent list icon: glyph fit to LIST_FILL of the frame, centered. */
function renderList(glyphPng, out, size) {
  const target = Math.round(LIST_FILL * size);
  execFileSync('magick', [
    ...fittedGlyph(glyphPng, target),
    '-background', 'none', '-gravity', 'center', '-extent', `${size}x${size}`,
    out,
  ]);
}

/** Key image: glyph fit to KEY_FILL of the frame, centered over the rounded #1C2128 ground. */
function renderKey(glyphPng, out, size) {
  const target = Math.round(KEY_FILL * size);
  const radius = Math.round((CORNER_RADIUS * size) / 72);
  const bg = tmp(`bg-${size}.png`);
  execFileSync('magick', [
    '-size', `${size}x${size}`, 'xc:none', '-fill', BG,
    '-draw', `roundrectangle 0,0,${size - 1},${size - 1},${radius},${radius}`,
    bg,
  ]);
  try {
    execFileSync('magick', [bg, '(', ...fittedGlyph(glyphPng, target), ')', '-gravity', 'center', '-composite', out]);
  } finally {
    rmSync(bg, { force: true });
  }
}

/** Guard the fix: a list icon must fill the frame like its siblings, not sit small and padded. */
function assertListCoverage(out, size, min) {
  const dims = execFileSync('magick', [out, '-trim', '+repage', '-format', '%wx%h', 'info:'], { encoding: 'utf8' });
  const [w, h] = dims.trim().split('x').map(Number);
  const coverage = Math.max(w, h) / size;
  if (coverage < min) {
    throw new Error(`${out}: glyph fills ${(coverage * 100).toFixed(0)}% of the frame, below the ${(min * 100).toFixed(0)}% convention floor`);
  }
}

/**
 * The four manifest variants a single high-res transparent source raster produces: the 72/144 key
 * faces (glyph over the rounded ground) and the 20/40 transparent list icons. Shared by the glyph-
 * and brand-sourced icons so both fit and center identically.
 */
function emit(name, srcPng) {
  renderKey(srcPng, join(PLUGIN, 'icons', `${name}.png`), 72);
  renderKey(srcPng, join(PLUGIN, 'icons', `${name}@2x.png`), 144);
  renderList(srcPng, join(PLUGIN, 'icons', 'list', `${name}.png`), 20);
  renderList(srcPng, join(PLUGIN, 'icons', 'list', `${name}@2x.png`), 40);
  assertListCoverage(join(PLUGIN, 'icons', 'list', `${name}@2x.png`), 40, 0.8);
}

/** Rasterize a source SVG to the shared high-res transparent raster, run `emit`, then clean up. */
function build(name, svg, tag, label) {
  const svgFile = tmp(`${tag}.svg`);
  const srcPng = tmp(`${tag}.png`);
  writeFileSync(svgFile, svg);
  execFileSync('rsvg-convert', ['-w', String(RENDER_PX), '-h', String(RENDER_PX), svgFile, '-o', srcPng]);
  try {
    emit(name, srcPng);
  } finally {
    rmSync(svgFile, { force: true });
    rmSync(srcPng, { force: true });
  }
  console.log(`rendered ${name} (${label}) → 72/144/20/40`);
}

function main() {
  ensureTool('rsvg-convert', 'brew install librsvg');
  ensureTool('magick', 'brew install imagemagick');

  const faceSrc = readFileSync(FACE_TS, 'utf8');
  mkdirSync(join(PLUGIN, 'icons', 'list'), { recursive: true });

  for (const { name, glyph } of ICONS) {
    build(name, glyphSvg(extractGlyph(faceSrc, glyph, GLYPH_COLOR)), glyph, `from GLYPHS.${glyph}`);
  }

  const brandSrc = readFileSync(BRAND_SVG, 'utf8');
  for (const { name } of BRAND_ICONS) {
    build(name, brandSvg(extractBrandMark(brandSrc)), 'brand', 'from icons/plugin.svg brand mark');
  }
}

// Run only when invoked directly (`node scripts/render-action-icons.mjs`); importing the module
// for tests exercises the pure helpers above without rasterizing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
