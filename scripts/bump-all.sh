#!/bin/sh
# Set every workspace package to the same version, anchored on the root
# package.json's version field. The root is private (never published), but
# its version is the canonical "what version is this monorepo" — same pattern
# used by Vue (vuejs/core) and Babel (babel/babel).
#
# Usage:
#   scripts/bump-all.sh                 # default: patch bump from root version
#   scripts/bump-all.sh patch           # patch bump (same as no-arg)
#   scripts/bump-all.sh minor           # minor bump
#   scripts/bump-all.sh major           # major bump
#   scripts/bump-all.sh 3.1.0-rc.1      # explicit version (for RCs, etc.)
#
# This script only rewrites the version field of each package.json — it does
# NOT commit or tag (so no `--no-git-tag-version` passthrough is needed,
# unlike `pnpm version` which auto-commits by default). It also does NOT
# reformat the JSON: the version line is patched in place so hand-formatted
# files (e.g. packages/vscode/package.json with compact view arrays) are
# preserved byte-for-byte outside the version field. Stage, commit, and tag
# yourself afterward.
#
# VS Code Marketplace rejects semver pre-release suffixes (e.g. 1.7.0-rc.1),
# so packages/vscode is skipped when VERSION contains a '-'. The extension
# catches up when an RC is promoted to a stable version.

set -e

INPUT="${1:-patch}"

CURRENT="$(PKG=. node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (!p.version) { console.error("Root package.json has no version field"); process.exit(1); }
  console.log(p.version);
')"

case "$INPUT" in
  patch|minor|major)
    case "$CURRENT" in
      *-*)
        echo "Cannot semantic-bump from pre-release version '$CURRENT'. Pass an explicit version instead." >&2
        exit 1
        ;;
    esac
    VERSION="$(CURRENT="$CURRENT" INPUT="$INPUT" node -e '
      const [maj, min, patch] = process.env.CURRENT.split(".").map(Number);
      const out = process.env.INPUT === "major" ? [maj + 1, 0, 0]
                : process.env.INPUT === "minor" ? [maj, min + 1, 0]
                : [maj, min, patch + 1];
      console.log(out.join("."));
    ')"
    echo "Anchor (root) @$CURRENT → $INPUT bump → $VERSION"
    ;;
  *)
    VERSION="$INPUT"
    ;;
esac

case "$VERSION" in
  *-*) IS_PRERELEASE=1 ;;
  *)   IS_PRERELEASE=0 ;;
esac

bump_file() {
  PKG_FILE="$1" VERSION="$VERSION" node -e '
    const fs = require("fs");
    const p = process.env.PKG_FILE;
    const newVersion = process.env.VERSION;
    const content = fs.readFileSync(p, "utf8");
    // Match the FIRST top-level "version" field (2-space indent, root level).
    // Anything deeper (e.g. version strings inside dependencies) is left alone.
    const pattern = /^(  "version"\s*:\s*")[^"]*(")/m;
    if (!pattern.test(content)) {
      console.error("Failed to find top-level version field in " + p);
      process.exit(1);
    }
    const newContent = content.replace(pattern, `$1${newVersion}$2`);
    fs.writeFileSync(p, newContent);
    const pkg = JSON.parse(newContent);
    console.log("Bumped " + pkg.name + " → " + pkg.version);
  '
}

# Root first — always bumped (private, no marketplace constraints).
bump_file "package.json"

# Bump the npm-published packages (codev, core, types).
for pkg in packages/codev packages/core packages/types; do
  bump_file "$pkg/package.json"
done

# vscode lives in its own script — version + CHANGELOG promotion + marketplace
# constraints. Delegate to scripts/bump-vscode.sh, which is also callable on
# its own when bumping the extension independently from a codev release.
if [ "$IS_PRERELEASE" = "1" ]; then
  echo "Skipping packages/vscode ($VERSION is a pre-release; VS Code Marketplace requires plain semver)"
else
  SCRIPT_DIR="$(dirname "$0")"
  "$SCRIPT_DIR/bump-vscode.sh" "$VERSION"
fi
