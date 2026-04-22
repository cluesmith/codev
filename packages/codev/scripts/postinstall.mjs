#!/usr/bin/env node

// Restores executable bits that pnpm pack/publish strips from files outside
// the `bin` field. See issue #693 — without this, `afx spawn` fails with
// Permission denied when invoking forge concept scripts.

import { chmodSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const forgeRoot = join(here, 'forge');

function chmodForgeScripts(root) {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return 0;

  let count = 0;
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.sh')) continue;
      const filePath = join(dirPath, file);
      chmodSync(filePath, 0o755);
      count += 1;
    }
  }
  return count;
}

function chmodNodePtySpawnHelper() {
  try {
    const require = createRequire(import.meta.url);
    const ptyEntry = require.resolve('node-pty');
    const helper = join(
      ptyEntry,
      '..',
      '..',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    );
    chmodSync(helper, 0o755);
  } catch {
    // node-pty may not ship a prebuild for this platform; harmless.
  }
}

chmodForgeScripts(forgeRoot);
chmodNodePtySpawnHelper();
