#!/bin/bash
# ==============================================================================
# Claude Code Cloud Environment Setup Script for activitypub-firebase
# Runs once as root on Ubuntu 24.04 (x86_64) when building the environment cache snapshot.
# Time limit: ~5 minutes.
# ==============================================================================
set -u

echo "=== [Setup] Starting Claude Code Cloud Environment setup for activitypub-firebase ==="
start_time=$(date +%s)

# 1. Ensure basic utilities and Google Cloud CLI (gcloud)
echo "=== [Setup] Checking Google Cloud CLI (gcloud) ==="
if ! command -v gcloud &> /dev/null; then
  echo "Installing google-cloud-cli via apt..."
  apt-get update -qq
  apt-get install -y -qq apt-transport-https ca-certificates gnupg curl
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg --yes 2>/dev/null || true
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -qq
  apt-get install -y -qq google-cloud-cli || {
    echo "Warning: apt-get install google-cloud-cli failed. Continuing..."
  }
else
  echo "gcloud CLI is already installed: $(gcloud --version 2>/dev/null | head -n 1)"
fi

# 1b. Configure Google Cloud ADC if service account key is provided.
#    Runs right after gcloud is installed so that the time limit cannot cut it off. scripts/cloud_session_start.sh repeats it on every session start.
if [ -n "${GCP_SA_KEY:-}" ]; then
  echo "=== [Setup] Configuring Google Cloud Service Account ==="
  ADC=/root/.config/gcloud/application_default_credentials.json
  mkdir -p /root/.config/gcloud
  (umask 077 && printf '%s' "$GCP_SA_KEY" > "$ADC")
  if command -v gcloud &> /dev/null; then
    gcloud auth activate-service-account --key-file="$ADC" --quiet \
      || echo "Warning: gcloud auth activate-service-account failed (check GCP_SA_KEY)."
  fi
fi

# 2. Install firebase-tools globally
echo "=== [Setup] Checking firebase-tools ==="
if ! command -v firebase &> /dev/null; then
  echo "Installing firebase-tools globally..."
  npm install -g firebase-tools || echo "Warning: global firebase-tools install failed. functions/node_modules will provide it."
else
  echo "firebase-tools is already installed: $(firebase --version 2>/dev/null)"
fi

# 3. Initialize Git submodules (shallow clone to save time and bandwidth)
echo "=== [Setup] Initializing git submodules (depth 1) ==="
TARGET_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$TARGET_DIR" || cd /root

if [ -d ".git" ]; then
  git submodule update --init --recursive --depth 1 || {
    echo "Warning: shallow submodule checkout failed. Retrying standard checkout..."
    git submodule update --init --recursive || echo "Warning: git submodule update encountered errors. Continuing..."
  }
fi

# 4. Install npm dependencies in functions/
echo "=== [Setup] Installing npm dependencies in functions/ ==="
if [ -d "$TARGET_DIR/functions" ]; then
  cd "$TARGET_DIR/functions"
  npm ci || {
    echo "Warning: npm ci failed. Falling back to npm install..."
    npm install
  }

  # Record package checksum for session start hook
  mkdir -p node_modules
  sha256sum package.json package-lock.json > node_modules/.install_pkgs.sha256 2>/dev/null || true
fi

# 5. Pre-download Firestore emulator JAR (caches ~130MB emulator)
echo "=== [Setup] Pre-caching Firestore emulator ==="
cd "$TARGET_DIR" || cd /root
if command -v firebase &> /dev/null; then
  firebase setup:emulators:firestore || echo "Warning: firebase setup:emulators:firestore failed. It will be downloaded on first test run."
elif [ -f "$TARGET_DIR/functions/node_modules/.bin/firebase" ]; then
  "$TARGET_DIR/functions/node_modules/.bin/firebase" setup:emulators:firestore || echo "Warning: local firebase setup:emulators:firestore failed."
fi

# 6. Pre-build functions (tsc)
echo "=== [Setup] Pre-building functions ==="
if [ -d "$TARGET_DIR/functions" ]; then
  cd "$TARGET_DIR/functions"
  npm run build || echo "Warning: initial build failed. Continuing..."
fi

elapsed=$(( $(date +%s) - start_time ))
echo "=== [Setup] Setup completed in ${elapsed}s ==="
exit 0
