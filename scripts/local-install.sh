#!/usr/bin/env bash
# Pack workspace packages into tarballs and install them globally for testing.
# Run from the monorepo root: pnpm -w run local-install

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Workaround pnpm's prefix redirection: when this script is invoked via
# `pnpm -w run local-install`, pnpm sets `npm_config_prefix` to the workspace
# root, which makes `npm install -g` install into <workspace>/lib/node_modules
# instead of the actual system-global location. The result: the script
# reports "Installed" but the system binary is unchanged. Unset the override
# so npm uses the user's real global prefix (e.g. /opt/homebrew). Also clear
# the matching pnpm var for completeness.
unset npm_config_prefix
unset PNPM_CONFIG_PREFIX

# Pack — clear stale tarballs first so the install glob matches exactly one file.
rm -f packages/core/*.tgz packages/codev/*.tgz
pnpm --filter @cluesmith/codev-core pack --pack-destination packages/core
pnpm --filter @cluesmith/codev pack --pack-destination packages/codev

# Uninstall first — `npm install -g` over an existing same-name package
# is sometimes a silent no-op, leaving the previous version installed.
# The rm -rf is belt-and-suspenders: when the tarball version matches the
# previously-installed version, npm's same-version short-circuit can leave
# stale files on disk even after uninstall+install.
GLOBAL_ROOT="$(npm root -g)"
npm uninstall -g @cluesmith/codev @cluesmith/codev-core 2>/dev/null || true
rm -rf "$GLOBAL_ROOT/@cluesmith/codev" "$GLOBAL_ROOT/@cluesmith/codev-core"

npm install -g \
  "$REPO_ROOT/packages/core/cluesmith-codev-core-"*.tgz \
  "$REPO_ROOT/packages/codev/cluesmith-codev-"*.tgz

# pnpm pack strips the executable bit from shell scripts in the tarball,
# which causes "GitHub CLI unavailable" errors when overview.ts tries to
# spawn scripts/forge/github/*.sh. Restore +x after install.
find "$(npm root -g)/@cluesmith/codev/scripts/forge" -name '*.sh' -exec chmod +x {} +

echo "Installed: $(codev --version)"

# Restart Tower so it picks up the new code.
afx tower stop && afx tower start

echo "Tower restarted — new code is now live."
