#!/bin/bash
# Build an air-gapped bundle for SiskelBot
# Output: siskelbot-airgap-{version}.tar.gz
#
# Contains:
#   - Source code (git archive)
#   - node_modules (pre-installed)
#   - Pre-downloaded Docker images (optional)
#   - Ollama model blobs (optional)
#   - Installation scripts
#   - SHA256 manifest for integrity verification
#
# Usage:
#   ./build-bundle.sh                    # source + node_modules only
#   ./build-bundle.sh --with-docker      # include Docker images
#   ./build-bundle.sh --with-ollama MODEL # include Ollama model blobs

set -e

# Run from repo root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

VERSION=$(node -p "require('./package.json').version")
BUNDLE_DIR="siskelbot-airgap-${VERSION}"
BUNDLE_FILE="${BUNDLE_DIR}.tar.gz"

echo "Building air-gapped bundle v${VERSION}..."

# Create workdir
rm -rf "${BUNDLE_DIR}"
mkdir -p "${BUNDLE_DIR}"

# 1. Archive source code (excluding node_modules, data, .git)
echo "Archiving source code..."
git archive HEAD --format=tar | tar -xC "${BUNDLE_DIR}/"

# 2. Install production dependencies
echo "Installing production dependencies..."
(cd "${BUNDLE_DIR}" && npm ci --omit=dev)

# 3. Copy installation scripts
echo "Copying installation scripts..."
cp deploy/airgap/install.sh "${BUNDLE_DIR}/"
cp deploy/airgap/verify-bundle.sh "${BUNDLE_DIR}/"
cp deploy/airgap/templates/offline.env "${BUNDLE_DIR}/.env.template"
cp deploy/airgap/templates/systemd.service "${BUNDLE_DIR}/"
cp deploy/airgap/README.md "${BUNDLE_DIR}/AIRGAP_README.md"
chmod +x "${BUNDLE_DIR}/install.sh" "${BUNDLE_DIR}/verify-bundle.sh"

# 4. Download Docker images if requested
if [ "$1" = "--with-docker" ]; then
  echo "Saving Docker images..."
  mkdir -p "${BUNDLE_DIR}/docker-images"
  docker save postgres:16-alpine -o "${BUNDLE_DIR}/docker-images/postgres.tar"
  docker save redis:7-alpine -o "${BUNDLE_DIR}/docker-images/redis.tar"
  docker save ollama/ollama:latest -o "${BUNDLE_DIR}/docker-images/ollama.tar"
fi

# 5. Copy Ollama model blobs if requested
if [ "$1" = "--with-ollama" ] && [ -n "$2" ]; then
  MODEL="$2"
  echo "Copying Ollama model blobs for ${MODEL}..."
  mkdir -p "${BUNDLE_DIR}/ollama-models"
  OLLAMA_DIR="${OLLAMA_MODELS:-$HOME/.ollama/models}"
  if [ -d "${OLLAMA_DIR}" ]; then
    cp -r "${OLLAMA_DIR}"/* "${BUNDLE_DIR}/ollama-models/"
    echo "${MODEL}" > "${BUNDLE_DIR}/ollama-models/MODEL_NAME"
  else
    echo "WARNING: Ollama model directory not found at ${OLLAMA_DIR}"
  fi
fi

# 6. Generate SHA256 manifest
echo "Generating integrity manifest..."
(cd "${BUNDLE_DIR}" && find . -type f ! -name MANIFEST.sha256 -exec sha256sum {} \; | sort > MANIFEST.sha256)

# 7. Create tarball
echo "Creating tarball..."
tar -czf "${BUNDLE_FILE}" "${BUNDLE_DIR}"
rm -rf "${BUNDLE_DIR}"

# 8. Generate top-level checksum
sha256sum "${BUNDLE_FILE}" > "${BUNDLE_FILE}.sha256"

# 9. Sign bundle (if gpg available)
if command -v gpg >/dev/null; then
  if gpg --list-secret-keys >/dev/null 2>&1; then
    gpg --detach-sign --armor "${BUNDLE_FILE}"
    echo "Signed: ${BUNDLE_FILE}.asc"
  else
    echo "GPG available but no secret key configured, skipping signing"
  fi
fi

SIZE=$(du -h "${BUNDLE_FILE}" | cut -f1)
echo ""
echo "=============================================="
echo "Bundle created: ${BUNDLE_FILE} (${SIZE})"
echo "Checksum:       ${BUNDLE_FILE}.sha256"
[ -f "${BUNDLE_FILE}.asc" ] && echo "Signature:      ${BUNDLE_FILE}.asc"
echo "=============================================="
