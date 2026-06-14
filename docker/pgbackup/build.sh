#!/usr/bin/env bash
# Local build of the pgbackup image
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-16-aws-local}"

cd "${SCRIPT_DIR}"
docker build -t "ghcr.io/hondoentertainment/pgbackup:${TAG}" .
echo "Built ghcr.io/hondoentertainment/pgbackup:${TAG}"
echo
echo "Verify:"
docker run --rm "ghcr.io/hondoentertainment/pgbackup:${TAG}" -c "pg_dump --version && aws --version"
