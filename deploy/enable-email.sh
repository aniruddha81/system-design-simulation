#!/usr/bin/env bash
# Switch the EC2 host from Resend's sandbox sender to the verified domain, but only once Resend reports the domain
# verified on 3 consecutive checks 90 s apart. After switching it watches for 10 minutes and rolls back to the sandbox
# sender if the domain flips back to pending (a failing real sender blocks sign-in for new users).
# Usage: deploy/enable-email.sh <resend-domain-id> <from-domain> [host-ip]
set -uo pipefail
RID="$1"; DOMAIN="$2"; IP="${3:-13.250.70.115}"
KEY="${SDS_SSH_KEY:-$HOME/.ssh/sds-prod.pem}"
status() { resend domains get "$RID" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch{console.log("?")}})'; }
setfrom() { ssh -i "$KEY" "ubuntu@$IP" "cd /opt/sds && sed -i 's|^EMAIL_FROM=.*|EMAIL_FROM=System Design Simulator <$1>|' .env.production && docker compose up -d --force-recreate" >/dev/null 2>&1; }

ok=0
while [ "$ok" -lt 3 ]; do
  resend domains verify "$RID" >/dev/null 2>&1
  sleep 5
  if [ "$(status)" = verified ]; then ok=$((ok + 1)); else ok=0; fi
  [ "$ok" -lt 3 ] && sleep 90
done
echo "resend: $DOMAIN verified 3 times in a row"
setfrom "noreply@$DOMAIN"
echo "email: real sender enabled"
for i in $(seq 1 20); do
  sleep 30
  if [ "$(status)" != verified ]; then setfrom "onboarding@resend.dev"; echo "email: domain flipped back to pending, rolled back to sandbox sender"; exit 1; fi
done
echo "email: stable for 10 minutes"
