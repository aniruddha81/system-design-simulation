#!/usr/bin/env bash
# Waits for DNS, then switches the EC2 host to HTTPS on the domain.
# Usage: deploy/enable-domain.sh sds.aniruddha81.tech 13.250.70.115
set -uo pipefail
DOMAIN="$1"; IP="$2"
KEY="${SDS_SSH_KEY:-$HOME/.ssh/sds-prod.pem}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "ubuntu@$IP")

# SKIP_DNS=1: records are published at the authoritative servers but some public resolvers still cache the old NXDOMAIN (SOA negative TTL).
[ -n "${SKIP_DNS:-}" ] || until nslookup "$DOMAIN" 8.8.8.8 2>/dev/null | grep -q "$IP"; do sleep 20; done
echo "dns: $DOMAIN resolves to $IP"

"${SSH[@]}" "cd /opt/sds && echo SITE_ADDRESS=$DOMAIN > .env && sed -i -e 's|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=https://$DOMAIN|' -e 's|^NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=https://$DOMAIN|' .env.production && docker compose up -d --force-recreate" >/dev/null 2>&1
for i in $(seq 1 30); do
  if curl -fsS -m 15 --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/api/health" 2>/dev/null | grep -q '"ok":true'; then echo "https: https://$DOMAIN is live"; break; fi
  sleep 10
done
