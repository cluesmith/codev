#!/bin/sh
# Forge concept: repo-archive (GitHub via gh CLI)
# Input: CODEV_REPO (owner/repo), CODEV_REF (tag/branch/sha, empty for default), CODEV_OUTPUT_DIR
# Output: Extracts repository archive into CODEV_OUTPUT_DIR
REF_PART="${CODEV_REF:-HEAD}"
gh api "repos/${CODEV_REPO}/tarball/${REF_PART}" > /tmp/codev-archive-$$.tar.gz
mkdir -p "${CODEV_OUTPUT_DIR}"
tar xzf /tmp/codev-archive-$$.tar.gz -C "${CODEV_OUTPUT_DIR}" --strip-components=1
rm -f /tmp/codev-archive-$$.tar.gz
echo '{"status":"ok"}'
