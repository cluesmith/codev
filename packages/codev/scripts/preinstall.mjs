#!/usr/bin/env node

// Stops a native Windows install on a Node version without prebuilt native
// binaries, before any dependency's install script can fall back to a source
// build (Spec 1658). A no-op on every other platform. See native-deps-guard.mjs.

import { checkWindowsNodeForPrebuilds } from './native-deps-guard.mjs';

const message = checkWindowsNodeForPrebuilds({
  platform: process.platform,
  arch: process.arch,
  abi: process.versions.modules,
  nodeVersion: process.version,
});

if (message !== null) {
  console.error(message);
  process.exit(1);
}
