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

# 0. Register the GCP service account (dev) so gcloud / firebase / ADC work.
#    Also done in setup.sh, but the snapshot may predate GCP_SA_KEY, so repeat it on every start.
if [ -n "${GCP_SA_KEY:-}" ]; then
  adc=/root/.config/gcloud/application_default_credentials.json
  mkdir -p "$(dirname "$adc")"
  (umask 077 && printf '%s' "$GCP_SA_KEY" > "$adc")
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export GOOGLE_APPLICATION_CREDENTIALS=$adc" >> "$CLAUDE_ENV_FILE"
  fi
  if command -v gcloud &> /dev/null; then
    gcloud auth activate-service-account --key-file="$adc" --quiet \
      || echo "Warning: gcloud auth activate-service-account failed (check GCP_SA_KEY)."
    gcloud config set project "${GCLOUD_PROJECT:-activitypub-firebase-dev}" --quiet 2>/dev/null || true
  fi
fi

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
