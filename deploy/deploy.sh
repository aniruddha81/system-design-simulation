#!/usr/bin/env bash
# Build the image locally, ship it to the EC2 host over SSH, restart. Usage: deploy/deploy.sh [host]
# Needs: Docker, an SSH key at ~/.ssh/sds-prod.pem, and /opt/sds/.env.production on the host (see docs/DEPLOY-AWS.md).
set -euo pipefail
HOST="${1:-ubuntu@13.250.70.115}"
KEY="${SDS_SSH_KEY:-$HOME/.ssh/sds-prod.pem}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "$HOST")
cd "$(dirname "$0")/.."
docker build -t system-design-simulation:latest .
docker save system-design-simulation:latest | gzip > "${TMPDIR:-/tmp}/sds-image.tgz"
scp -i "$KEY" "${TMPDIR:-/tmp}/sds-image.tgz" "$HOST:/opt/sds/"
scp -i "$KEY" docker-compose.prod.yml "$HOST:/opt/sds/docker-compose.yml"
scp -i "$KEY" deploy/Caddyfile "$HOST:/opt/sds/deploy/Caddyfile"
"${SSH[@]}" 'cd /opt/sds && gunzip -c sds-image.tgz | docker load && rm sds-image.tgz && docker compose up -d && docker image prune -f >/dev/null && docker compose ps'
