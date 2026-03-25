#!/bin/sh
# Forge concept: repo-archive (Gitea via tea CLI)
# Input: CODEV_REPO (owner/repo), CODEV_REF (tag/branch/sha, empty for default), CODEV_OUTPUT_DIR
# Output: Extracts repository archive into CODEV_OUTPUT_DIR
REF_PART="${CODEV_REF:-main}"
# Gitea API: GET /repos/:owner/:repo/archive/:ref.tar.gz
tea api "repos/${CODEV_REPO}/archive/${REF_PART}.tar.gz" > /tmp/codev-archive-$$.tar.gz
mkdir -p "${CODEV_OUTPUT_DIR}"
tar xzf /tmp/codev-archive-$$.tar.gz -C "${CODEV_OUTPUT_DIR}" --strip-components=1
rm -f /tmp/codev-archive-$$.tar.gz
echo '{"status":"ok"}'
