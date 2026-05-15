#!/bin/sh
# Bump the VS Code extension — version field in packages/vscode/package.json
# AND promote `## [Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD` in
# packages/vscode/CHANGELOG.md so the Marketplace listing reflects the new
# version.
#
# Standalone: anchors on vscode's OWN current version. When called from
# scripts/bump-all.sh, the lockstep version is passed explicitly.
#
# Usage:
#   scripts/bump-vscode.sh                # default: patch bump from current vscode version
#   scripts/bump-vscode.sh patch          # patch bump (same as no-arg)
#   scripts/bump-vscode.sh minor          # minor bump
#   scripts/bump-vscode.sh major          # major bump
#   scripts/bump-vscode.sh 3.0.4          # explicit version (must NOT be pre-release)
#
# Pre-release versions (anything containing '-') are rejected: VS Code
# Marketplace requires plain semver. Bump vscode independently when promoting
# an RC to stable.
#
# Like scripts/bump-all.sh, this only rewrites files — no commit, no tag.

set -e

INPUT="${1:-patch}"

CURRENT="$(node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("packages/vscode/package.json", "utf8"));
  if (!p.version) { console.error("packages/vscode/package.json has no version field"); process.exit(1); }
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
    echo "vscode @$CURRENT → $INPUT bump → $VERSION"
    ;;
  *)
    VERSION="$INPUT"
    ;;
esac

case "$VERSION" in
  *-*)
    echo "VS Code Marketplace rejects pre-release versions like '$VERSION'. Use plain semver (e.g. 3.0.4)." >&2
    exit 1
    ;;
esac

# Bump packages/vscode/package.json (byte-preserving regex on the version line).
PKG_FILE="packages/vscode/package.json" VERSION="$VERSION" node -e '
  const fs = require("fs");
  const p = process.env.PKG_FILE;
  const content = fs.readFileSync(p, "utf8");
  const pattern = /^(  "version"\s*:\s*")[^"]*(")/m;
  if (!pattern.test(content)) {
    console.error("Failed to find top-level version field in " + p);
    process.exit(1);
  }
  const newContent = content.replace(pattern, `$1${process.env.VERSION}$2`);
  fs.writeFileSync(p, newContent);
  const pkg = JSON.parse(newContent);
  console.log("Bumped " + pkg.name + " → " + pkg.version);
'

# Promote Keep-a-Changelog `## [Unreleased]` → `## [X.Y.Z] - DATE`.
# No fresh [Unreleased] heading is inserted — the next PR with notes adds one
# back. Keeps the published Marketplace changelog free of empty sections.
FILE="packages/vscode/CHANGELOG.md" VERSION="$VERSION" DATE="$(date +%Y-%m-%d)" node -e '
  const fs = require("fs");
  const f = process.env.FILE;
  if (!fs.existsSync(f)) {
    console.log("No changelog at " + f + " — skipping promotion");
    process.exit(0);
  }
  const content = fs.readFileSync(f, "utf8");
  const heading = "## [Unreleased]";
  const idx = content.indexOf(heading);
  if (idx === -1) {
    console.log("No [Unreleased] section in " + f + " — skipping promotion");
    process.exit(0);
  }
  const replacement = "## [" + process.env.VERSION + "] - " + process.env.DATE;
  const newContent = content.slice(0, idx) + replacement + content.slice(idx + heading.length);
  fs.writeFileSync(f, newContent);
  console.log("Promoted " + f + ": [Unreleased] → [" + process.env.VERSION + "] - " + process.env.DATE);
'
