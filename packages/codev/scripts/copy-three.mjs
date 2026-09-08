#!/usr/bin/env node

/**
 * Build step: vendor three.js into templates/vendor/ from the `three`
 * devDependency, instead of committing ~58k lines of library source.
 *
 * Why vendored at all: the 3D model viewer (templates/3d-viewer.html) is a
 * key-bearing page — it holds the injected Tower key to fetch the keyed
 * `api/model` route. A key-bearing page must run zero remote code, so three.js
 * is served same-origin from vendor/ rather than a CDN (advisory
 * GHSA-xvjp-7748-v88v). This script keeps that property while moving the bytes
 * out of git: the copied files are .gitignored and regenerated at build time,
 * and ship in the npm tarball via the package's `files` allowlist (the same
 * mechanism skeleton/ and dashboard-dist/ already rely on).
 *
 * Output is byte-identical to three@0.160.0's published files, except one line
 * in 3MFLoader: its `../libs/fflate.module.js` relative import is rewritten to
 * the bare `fflate` specifier so it resolves through the page's importmap
 * (which maps `fflate` -> vendor/three-fflate.module.js). Do not edit the
 * generated files — edit this script or bump the `three` devDependency.
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

// Resolve the `three` package root by walking up from its resolved entry point
// to the directory whose package.json is name === "three". (three's exports map
// blocks a direct require.resolve('three/package.json'), so we resolve the entry
// and climb.)
function findThreeRoot() {
  let dir = dirname(require.resolve('three'));
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'three') return dir;
      } catch {
        /* keep climbing */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the `three` package root — is it installed?');
}

const threeRoot = findThreeRoot();
const vendorDir = resolve(import.meta.dirname, '..', 'templates', 'vendor');

// source (relative to three package root) -> dest flat filename in vendor/
const VERBATIM = [
  ['build/three.module.js', 'three.module.js'],
  ['examples/jsm/loaders/STLLoader.js', 'three-STLLoader.js'],
  ['examples/jsm/controls/TrackballControls.js', 'three-TrackballControls.js'],
  ['examples/jsm/libs/fflate.module.js', 'three-fflate.module.js'],
];

for (const [src, dest] of VERBATIM) {
  copyFileSync(join(threeRoot, src), join(vendorDir, dest));
}

// 3MFLoader: rewrite the one relative fflate import to the importmap specifier.
const mfSrc = readFileSync(join(threeRoot, 'examples/jsm/loaders/3MFLoader.js'), 'utf8');
const mfRewritten = mfSrc.replace(
  "import * as fflate from '../libs/fflate.module.js';",
  "import * as fflate from 'fflate';",
);
if (mfRewritten === mfSrc) {
  throw new Error(
    "copy-three: expected fflate import to rewrite in 3MFLoader.js but no match was found — " +
      'the `three` version may have changed its import path.',
  );
}
writeFileSync(join(vendorDir, 'three-3MFLoader.js'), mfRewritten);

const version = JSON.parse(readFileSync(join(threeRoot, 'package.json'), 'utf8')).version;
console.log(`copy-three: vendored three@${version} (5 files) into templates/vendor/`);
