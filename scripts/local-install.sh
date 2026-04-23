#!/bin/sh
# Pack workspace packages into tarballs and install them globally for testing.
# Run from the monorepo root: pnpm -w run local-install

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Pack — clear stale tarballs first so the install glob matches exactly one file.
rm -f packages/core/*.tgz packages/codev/*.tgz
pnpm --filter @cluesmith/codev-core pack --pack-destination packages/core
pnpm --filter @cluesmith/codev pack --pack-destination packages/codev

# Uninstall first — `npm install -g` over an existing same-name package
# is sometimes a silent no-op, leaving the previous version installed.
npm uninstall -g @cluesmith/codev @cluesmith/codev-core 2>/dev/null || true

npm install -g \
  "$REPO_ROOT/packages/core/cluesmith-codev-core-"*.tgz \
  "$REPO_ROOT/packages/codev/cluesmith-codev-"*.tgz

# pnpm pack strips the executable bit from shell scripts in the tarball,
# which causes "GitHub CLI unavailable" errors when overview.ts tries to
# spawn scripts/forge/github/*.sh. Restore +x after install.
chmod -R +x "$(npm root -g)/@cluesmith/codev/scripts/forge"

echo "Installed: $(codev --version)"

# Restart Tower so it picks up the new code.
afx tower stop && afx tower start

echo "Tower restarted — new code is now live."
