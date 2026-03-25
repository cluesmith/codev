#!/bin/sh
# Forge concept: repo-archive (GitLab via lab/glab CLI)
# Input: CODEV_REPO (owner/repo), CODEV_REF (tag/branch/sha, empty for default), CODEV_OUTPUT_DIR
# Output: Extracts repository archive into CODEV_OUTPUT_DIR
REF_PART="${CODEV_REF:-main}"
# GitLab API: GET /projects/:id/repository/archive
PROJECT_ENCODED=$(echo "${CODEV_REPO}" | sed 's/\//%2F/g')
glab api "projects/${PROJECT_ENCODED}/repository/archive?sha=${REF_PART}" > /tmp/codev-archive-$$.tar.gz
mkdir -p "${CODEV_OUTPUT_DIR}"
tar xzf /tmp/codev-archive-$$.tar.gz -C "${CODEV_OUTPUT_DIR}" --strip-components=1
rm -f /tmp/codev-archive-$$.tar.gz
echo '{"status":"ok"}'
