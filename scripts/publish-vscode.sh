#!/bin/sh
# Publish the VS Code extension to BOTH registries from a single packaged
# .vsix — keeps VS Code Marketplace and Open VSX byte-identical.
#
# Usage:
#   scripts/publish-vscode.sh                # stable, both registries
#   scripts/publish-vscode.sh --pre-release  # pre-release channel, both registries
#
# Auth:
#   VSCE_PAT  — VS Code Marketplace token, or run `vsce login cluesmith` once
#               (stored in OS keychain under service `vscode-vsce`)
#   OVSX_PAT  — Open VSX token. ovsx has no keychain support; export via shell rc
#               or pull from a secrets manager. See codev/protocols/release/protocol.md.
#
# Failure recovery:
#   Both registries reject duplicate-version uploads. If Marketplace succeeds
#   and Open VSX fails, the .vsix is still on disk — retry just the failed one:
#       ovsx publish packages/vscode/codev-vscode-X.Y.Z.vsix
#
# Why one script instead of two separate publishes:
#   Running `vsce publish` then `ovsx publish` would each rebuild + repackage,
#   producing two functionally-equivalent but byte-different .vsix files.
#   Packaging once guarantees both registries receive identical bytes.

set -e

cd packages/vscode

PRE=""
if [ "$1" = "--pre-release" ]; then
  PRE="--pre-release"
fi

VERSION="$(node -e "console.log(require('./package.json').version)")"
VSIX="codev-vscode-${VERSION}.vsix"

# Sanity-check OVSX_PAT before we package anything — fail fast if missing.
if [ -z "$OVSX_PAT" ]; then
  echo "OVSX_PAT not set. Open VSX publish will fail." >&2
  echo "Export it from your shell rc, secrets manager, or keychain:" >&2
  echo "  export OVSX_PAT=\"<token from https://open-vsx.org/user-settings/tokens>\"" >&2
  exit 1
fi

# Package once. The vscode:prepublish hook builds @cluesmith/codev-core and
# @cluesmith/codev-types first, then runs check-types + lint + esbuild --production.
rm -f *.vsix
echo "▶ packaging $VSIX..."
vsce package --no-dependencies

echo ""
echo "▶ publishing to VS Code Marketplace..."
vsce publish $PRE --packagePath "$VSIX" --no-dependencies

echo ""
echo "▶ publishing to Open VSX..."
ovsx publish $PRE "$VSIX"

echo ""
echo "✓ Published $VSIX to Marketplace + Open VSX"
