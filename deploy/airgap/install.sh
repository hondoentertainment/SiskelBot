#!/bin/bash
# Install SiskelBot from air-gapped bundle
# Usage: sudo ./install.sh [/opt/siskelbot]
#
# Runs on the target (air-gapped) machine after extracting the bundle.
# Verifies integrity, checks prerequisites, creates a service user,
# copies files into place, and installs the systemd unit.

set -e

INSTALL_DIR="${1:-/opt/siskelbot}"
SERVICE_USER="siskelbot"
SCRIPT_NAME="$(basename "$0")"

echo "SiskelBot air-gapped installer"
echo "Install dir: ${INSTALL_DIR}"
echo "Service user: ${SERVICE_USER}"
echo ""

# 0. Must be root to install systemd unit and create user
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must be run as root (try: sudo $0)"
  exit 1
fi

# 1. Verify bundle integrity
if [ -f MANIFEST.sha256 ]; then
  echo "Verifying bundle integrity..."
  if ! sha256sum -c MANIFEST.sha256 --quiet; then
    echo "INTEGRITY CHECK FAILED"
    exit 1
  fi
  echo "  integrity verified"
else
  echo "WARNING: MANIFEST.sha256 not found, skipping integrity check"
fi

# 2. Verify GPG signature if present
if [ -f "${SCRIPT_NAME}.asc" ] && command -v gpg >/dev/null; then
  echo "Verifying GPG signature..."
  if gpg --verify "${SCRIPT_NAME}.asc" "${SCRIPT_NAME}" 2>/dev/null; then
    echo "  signature verified"
  else
    echo "WARNING: signature verification failed"
  fi
fi

# 3. Check prerequisites
echo "Checking prerequisites..."
for cmd in node npm systemctl; do
  if ! command -v "$cmd" >/dev/null; then
    echo "ERROR: missing required command: $cmd"
    exit 1
  fi
done

NODE_VERSION=$(node -v | sed 's/v//')
MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found $NODE_VERSION)"
  exit 1
fi
echo "  node $NODE_VERSION ok"

# 4. Create service user
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Creating service user ${SERVICE_USER}..."
  useradd -r -s /bin/false -d "$INSTALL_DIR" "$SERVICE_USER"
fi

# 5. Copy files to install dir
echo "Copying files to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
# Copy everything except install-time artifacts
for item in *; do
  case "$item" in
    install.sh|verify-bundle.sh|MANIFEST.sha256|*.asc|docker-images|ollama-models)
      ;;
    *)
      cp -r "$item" "$INSTALL_DIR/"
      ;;
  esac
done

mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

# 6. Create .env from template if missing
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.template" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  chown "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR/.env"
  echo ""
  echo "NOTE: Edit $INSTALL_DIR/.env before starting the service"
fi

# 7. Load Docker images if present
if [ -d "docker-images" ] && command -v docker >/dev/null; then
  echo "Loading bundled Docker images..."
  for img in docker-images/*.tar; do
    [ -f "$img" ] && docker load -i "$img"
  done
fi

# 8. Copy Ollama model blobs if present
if [ -d "ollama-models" ]; then
  OLLAMA_TARGET="${OLLAMA_MODELS:-/usr/share/ollama/.ollama/models}"
  if [ -d "$(dirname "$OLLAMA_TARGET")" ] || mkdir -p "$OLLAMA_TARGET" 2>/dev/null; then
    echo "Copying Ollama model blobs to ${OLLAMA_TARGET}..."
    cp -r ollama-models/* "$OLLAMA_TARGET/" || echo "WARNING: failed to copy Ollama models"
  fi
fi

# 9. Install systemd service
echo "Installing systemd unit..."
cp systemd.service /etc/systemd/system/siskelbot.service
sed -i "s|INSTALL_DIR|$INSTALL_DIR|g" /etc/systemd/system/siskelbot.service
sed -i "s|SERVICE_USER|$SERVICE_USER|g" /etc/systemd/system/siskelbot.service
systemctl daemon-reload
systemctl enable siskelbot

echo ""
echo "=============================================="
echo "SiskelBot installed to $INSTALL_DIR"
echo ""
echo "Next steps:"
echo "  1. Edit configuration:  sudo -u $SERVICE_USER \$EDITOR $INSTALL_DIR/.env"
echo "  2. Start the service:   sudo systemctl start siskelbot"
echo "  3. Check status:        sudo systemctl status siskelbot"
echo "  4. View logs:           sudo journalctl -u siskelbot -f"
echo "=============================================="
