#!/usr/bin/env bash
# Waits for DNS, then switches the EC2 host to HTTPS on the domain; waits for the Resend domain, then turns on real email.
# Usage: deploy/enable-domain.sh sds.aniruddha81.tech 13.250.70.115 <resend-domain-id>
set -uo pipefail
DOMAIN="$1"; IP="$2"; RID="${3:-}"
KEY="${SDS_SSH_KEY:-$HOME/.ssh/sds-prod.pem}"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "ubuntu@$IP")

until nslookup "$DOMAIN" 8.8.8.8 2>/dev/null | grep -q "$IP"; do sleep 20; done
echo "dns: $DOMAIN resolves to $IP"

"${SSH[@]}" "cd /opt/sds && echo SITE_ADDRESS=$DOMAIN > .env && sed -i -e 's|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=https://$DOMAIN|' -e 's|^NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=https://$DOMAIN|' .env.production && docker compose up -d --force-recreate" >/dev/null 2>&1
for i in $(seq 1 30); do
  if curl -fsS -m 15 "https://$DOMAIN/api/health" 2>/dev/null | grep -q '"ok":true'; then echo "https: https://$DOMAIN is live"; break; fi
  sleep 10
done

[ -z "$RID" ] && exit 0
resend domains verify "$RID" >/dev/null 2>&1
until [ "$(resend domains get "$RID" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch{console.log("?")}})')" = verified ]; do sleep 30; resend domains verify "$RID" >/dev/null 2>&1; done
echo "resend: $DOMAIN verified"
"${SSH[@]}" "cd /opt/sds && sed -i -e 's|^EMAIL_FROM=.*|EMAIL_FROM=System Design Simulator <noreply@$DOMAIN>|' .env.production && docker compose up -d --force-recreate" >/dev/null 2>&1
echo "email: real sender enabled (verification required from now on)"
