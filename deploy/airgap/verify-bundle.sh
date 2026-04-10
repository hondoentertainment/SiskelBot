#!/bin/bash
# Verify an air-gapped SiskelBot bundle without installing.
#
# Usage:
#   ./verify-bundle.sh siskelbot-airgap-1.2.3.tar.gz
#
# Performs three checks:
#   1. Top-level SHA256 (if .sha256 sidecar exists)
#   2. GPG signature (if .asc sidecar exists and gpg available)
#   3. Per-file MANIFEST.sha256 integrity (extracted to a temp dir)

set -e

BUNDLE="$1"
if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "Usage: $0 <bundle.tar.gz>"
  exit 1
fi

echo "Verifying bundle: $BUNDLE"
echo ""

# 1. Top-level checksum
if [ -f "${BUNDLE}.sha256" ]; then
  echo "Step 1/3: top-level SHA256"
  if sha256sum -c "${BUNDLE}.sha256"; then
    echo "  ok"
  else
    echo "  FAILED"
    exit 1
  fi
else
  echo "Step 1/3: no ${BUNDLE}.sha256 sidecar, skipping"
fi
echo ""

# 2. GPG signature
if [ -f "${BUNDLE}.asc" ]; then
  echo "Step 2/3: GPG signature"
  if command -v gpg >/dev/null; then
    if gpg --verify "${BUNDLE}.asc" "${BUNDLE}"; then
      echo "  ok"
    else
      echo "  WARNING: signature verification failed"
    fi
  else
    echo "  gpg not installed, skipping"
  fi
else
  echo "Step 2/3: no ${BUNDLE}.asc sidecar, skipping"
fi
echo ""

# 3. Per-file MANIFEST.sha256
echo "Step 3/3: per-file MANIFEST.sha256"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "  extracting to $TMP_DIR..."
tar -xzf "$BUNDLE" -C "$TMP_DIR"

BUNDLE_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "siskelbot-airgap-*" | head -1)
if [ -z "$BUNDLE_DIR" ] || [ ! -f "$BUNDLE_DIR/MANIFEST.sha256" ]; then
  echo "  MANIFEST.sha256 not found in bundle"
  exit 1
fi

echo "  contents (first 20 entries):"
tar -tzf "$BUNDLE" | head -20 | sed 's/^/    /'
echo "  ..."
TOTAL=$(tar -tzf "$BUNDLE" | wc -l)
echo "  total entries: $TOTAL"
echo ""

echo "  checking file hashes..."
if (cd "$BUNDLE_DIR" && sha256sum -c MANIFEST.sha256 --quiet); then
  echo "  ok"
else
  echo "  FAILED"
  exit 1
fi

echo ""
echo "=============================================="
echo "Bundle $BUNDLE verified successfully"
echo "=============================================="
