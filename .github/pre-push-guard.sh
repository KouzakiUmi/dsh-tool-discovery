#!/usr/bin/env bash
# Pre-push guard.
#
# Why this exists: force-pushing a rewritten history to the wrong remote is
# destructive and hard to undo. The remote URL is the last line of defence,
# so it is checked here rather than trusted from memory at push time.
#
# Checks, in order:
#   1. every push remote's URL points at the repository this tree belongs to
#   2. the authenticated GitHub account owns that repository
#   3. a force-push is announced, so it is never a surprise to the remote
#
# Not a security boundary — it prevents accidents, not a determined mistake.
set -euo pipefail

EXPECTED_OWNER="KouzakiUmi"
EXPECTED_REPO="dsh-tool-discovery"

remote_line="$(git remote get-url --push "${1:-origin}")"
echo "pre-push: target ${1:-origin} -> ${remote_line}"

# Extract owner/repo from an https:// or ssh:// URL.
path="${remote_line#*github.com/}"
path="${path#*github.com:}"
path="${path%.git}"
path="${path#/}"
owner="${path%%/*}"
repo="${path#*/}"

if [ "$owner" != "$EXPECTED_OWNER" ] || [ "$repo" != "$EXPECTED_REPO" ]; then
  echo "REFUSED: expected ${EXPECTED_OWNER}/${EXPECTED_REPO}, got ${owner}/${repo}" >&2
  echo "If this is genuinely correct, update EXPECTED_OWNER/EXPECTED_REPO in this file deliberately." >&2
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  account="$(gh api user --jq .login 2>/dev/null || true)"
  if [ -n "$account" ] && [ "$account" != "$owner" ]; then
    echo "REFUSED: authenticated as ${account}, target owned by ${owner}" >&2
    exit 1
  fi
fi

# Announce forced updates; they rewrite history on the remote.
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue # branch deletion
  fi
  if [ "$remote_sha" != "0000000000000000000000000000000000000000" ]; then
    if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
      echo "pre-push: WARNING non-fast-forward ${remote_ref} ${remote_sha:0:7} -> ${local_sha:0:7} (history rewrite)"
    fi
  fi
done

exit 0