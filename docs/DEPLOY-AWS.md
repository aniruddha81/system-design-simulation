# Self-hosting on AWS EC2 (Docker)

The same app runs on Vercel (see `DEPLOY.md`) or as one Docker host. This is the Docker path.

```mermaid
flowchart LR
  U["Browser"] -->|"80 / 443"| C["Caddy<br/>auto-HTTPS, gzip/zstd"]
  C -->|"3000, internal network"| A["Next.js standalone<br/>non-root, read-only fs"]
  A -->|"HTTPS, pooled host"| N[("Neon Postgres<br/>ap-southeast-1")]
  A -->|"HTTPS API"| R["Brevo email"]
```

## What exists

| Piece | Value |
|---|---|
| Region | `ap-southeast-1` (Singapore): same region as the Neon database |
| Instance | `t3.small` (2 vCPU, 2 GB), Ubuntu 24.04, 20 GB encrypted gp3, IMDSv2 only, 2 GB swap |
| Address | Elastic IP `13.250.70.115` (stays when the instance restarts) |
| Firewall | Security group `sds-web`: 80, 443 open; SSH (22) only from the admin IP |
| Access | SSH key pair `sds-prod` (private key at `~/.ssh/sds-prod.pem`, never committed) |
| Host files | `/opt/sds`: `docker-compose.yml`, `deploy/Caddyfile`, `deploy/check.mjs`, `.env.production` (mode 600) |

## Deploy or update

```bash
deploy/deploy.sh          # build locally, ship the image over SSH, restart, show status
```

No registry is involved: the 100 MB image is streamed with `docker save | ssh`. Roll back by deploying an earlier commit.

CI uses GitHub OIDC to assume `sds-github-deploy`, scoped to this repository's `production` environment. Its policy permits only SSM sessions to `i-056b2dbe47b5a1a63` using `sds-ssh`, a document with port 22 fixed. It cannot open or close firewall rules. The instance profile `sds-ec2-ssm` grants `AmazonSSMManagedInstanceCore`; IMDSv2's hop limit remains 1. Policy sources are `deploy/github-deploy-{trust,policy}.json`, `deploy/ec2-ssm-trust.json`, and `deploy/ssm-ssh.json`. Keep the existing pinned SSH host key in `EC2_HOST_KEY` and private SSH key in the GitHub secret `EC2_SSH_KEY`.

## Environment on the host (`/opt/sds/.env.production`)

`DATABASE_URL` (pooled Neon, restricted `sds_runtime` role), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (public origin: **must match how users reach the site**), `NEXT_PUBLIC_SITE_URL`, `BREVO_CLIENT_ID`, `BREVO_CLIENT_SECRET`, `EMAIL_FROM`, `CRON_SECRET`. After editing: `cd /opt/sds && docker compose up -d`.

The runtime role has database CONNECT, schema USAGE, SELECT/INSERT/UPDATE/DELETE on the eight application tables, and USAGE/SELECT on `sync_seq`. It owns no tables, has no `neon_superuser` membership, and cannot create databases, roles, or bypass RLS. Migration credentials remain owner credentials in `DATABASE_URL_UNPOOLED`; explicitly grant runtime access when migrations add tables or sequences.

## Turning on a domain (HTTPS)

1. Point an `A` record for the hostname at the Elastic IP.
2. On the host set `SITE_ADDRESS=your.host.name` in `/opt/sds/.env` (compose reads it) and set `BETTER_AUTH_URL` / `NEXT_PUBLIC_SITE_URL` to `https://your.host.name` in `.env.production`.
3. `docker compose up -d`. Caddy obtains and renews the certificate itself.
4. Email is configured through Brevo (see `DEPLOY.md`).

## Retention job

Vercel Cron does not exist here. Add a daily cron on the host:

```bash
17 3 * * * cd /opt/sds && docker compose exec -T app node --input-type=module - prune < deploy/check.mjs
```

## Operations

- Logs: `docker compose logs -f app`. Health: `docker compose exec -T app node --input-type=module - health < deploy/check.mjs` from `/opt/sds`.
- Both maintenance checks reach the app directly, reject redirects, and require HTTP 200 plus a successful JSON result. Do not use HTTP localhost through Caddy: it redirects without reaching the app.
- Security updates apply automatically (`unattended-upgrades`); `fail2ban` guards SSH.
- Cost: about USD 17/month for the instance plus a few dollars of storage and traffic. Stop paying: terminate the instance and release the Elastic IP.
