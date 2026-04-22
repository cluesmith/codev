#!/usr/bin/env node

// Restores executable bits that pnpm pack/publish strips from files outside
// the `bin` field. See issue #693 — without this, `afx spawn` fails with
// Permission denied when invoking forge concept scripts.

import { chmodSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const forgeRoot = join(here, 'forge');

function chmodForgeScripts(root) {
  let providers;
  try {
    providers = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const provider of providers) {
    if (!provider.isDirectory()) continue;
    const providerDir = join(root, provider.name);
    for (const entry of readdirSync(providerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
      chmodSync(join(providerDir, entry.name), 0o755);
    }
  }
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
