#!/bin/bash
# ==============================================================================
# SessionStart Hook Script for Claude Code Cloud Sessions
# Runs whenever a cloud session starts or resumes.
# ==============================================================================
set -u

# Only execute inside Claude Code Cloud Sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_ROOT" || exit 1

# 1. Ensure submodules are checked out (shallow)
if [ -f ".gitmodules" ] && command -v git &> /dev/null; then
  if git submodule status | grep -q '^-'; then
    echo "=== [SessionStart] Checking out missing git submodules ==="
    git submodule update --init --recursive --depth 1 2>/dev/null || true
  fi
fi

# 2. Sync npm dependencies in functions/ if package.json has changed
if [ -d "functions" ]; then
  cd functions || exit 1
  hashes="node_modules/.install_pkgs.sha256"

  if ! sha256sum --check --status "$hashes" 2>/dev/null; then
    echo "=== [SessionStart] Dependency change detected. Running npm ci in functions/ ==="
    rm -f "$hashes"
    if npm ci; then
      sha256sum package.json package-lock.json > "$hashes" 2>/dev/null || true
    fi
  fi
  cd "$PROJECT_ROOT" || exit 1
fi

exit 0
