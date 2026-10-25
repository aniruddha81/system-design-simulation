# Deploying with accounts and sync

Accounts are **optional**. The app is local-first (IndexedDB); signing in mirrors designs, progress and reviews to Postgres so a learner can switch devices. Runs stay local.

```mermaid
flowchart LR
  B["Browser<br/>IndexedDB (source of truth)"] -- "better-auth session cookie" --> A["Next.js on Vercel<br/>region sin1"]
  A -- "Drizzle + neon-http<br/>pooled host" --> N[("Neon Postgres<br/>aws-ap-southeast-1<br/>Singapore")]
  B -- "POST/GET /api/sync<br/>batched, cursor-based" --> A
```

## Why these choices

- **Neon `aws-ap-southeast-1` (Singapore)**: the closest Neon region to Bangladesh. Vercel functions are pinned to `sin1` in `vercel.json`, so the app-to-database hop stays inside one region.
- **Drizzle ORM + `neon-http`**: no query engine binary, no connection pool to warm, one HTTPS round trip per query. Writes are single statements, so none needs an interactive transaction.
- **Better Auth**: email + password out of the box; GitHub and Google switch on when their env vars exist. Rate limits are stored in Postgres, so they hold across serverless instances.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Pooled Neon URL (host contains `-pooler`). Runtime. |
| `DATABASE_URL_UNPOOLED` | Direct Neon URL. Migrations only. |
| `BETTER_AUTH_SECRET` | 32+ random bytes. Rotate to invalidate all sessions. |
| `BETTER_AUTH_URL` | Public origin, e.g. `https://your-domain`. Also the allowed `Origin` for `/api/sync`. |
| `BREVO_CLIENT_ID` / `BREVO_CLIENT_SECRET` / `EMAIL_FROM` | Optional. When all three are set, sign-up requires email verification and password-reset emails are sent through Brevo's transactional API. `EMAIL_FROM` is `Name <address>` and the address must be authenticated in Brevo. When unset, nobody is locked out and emails are not sent. |
| `CRON_SECRET` | Bearer token for `/api/cron/prune` (daily retention job in `vercel.json`). Vercel sends it automatically. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional. |

Copy `.env.example` to `.env.local` for development. Never commit real values.

## Email (Brevo)

Mail goes through Brevo's transactional API using a private machine-to-machine OAuth app limited to the `transactional.email:write` scope (`BREVO_CLIENT_ID` / `BREVO_CLIENT_SECRET`). The server mints a one-hour bearer token from `https://oauth.brevo.com/realms/partner/oauth/token` and caches it; no long-lived API key exists.

Set up (already done for `aniruddha81.tech`; sender `noreply@aniruddha81.tech`):

1. `brevo app create --name <name> --distribution private --m2m --scopes transactional.email:write --json`, then `brevo app secret rotate --app-id <id> --yes --json` to obtain a client secret (it is shown once).
2. In Brevo, authenticate the sending domain (Senders, domains & dedicated IPs): add the DKIM, SPF and DMARC records it lists to DNS.
3. Put the three variables in the host environment and restart.

Rotate the secret with the same `secret rotate` command; the old one keeps working for a short grace period.

## Release steps

1. Set the variables above in the Vercel project (Production and Preview).
2. `npm run db:generate` after any change to `src/server/db/schema.ts`, commit the new `drizzle/` files.
3. CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build, then `npm run db:migrate` on `main`. Add the `DATABASE_URL_UNPOOLED` repo secret.
4. Monitor `GET /api/health` (returns 503 when the database is unreachable).

## Data model

| Table | Purpose |
|---|---|
| `user`, `session`, `account`, `verification` | Better Auth |
| `rate_limit` | Better Auth rate-limit counters |
| `sync_records` | One row per synced record: `(user_id, store, key)`, JSON `data`, `updated_at`, tombstone flag, global `seq` cursor |

Runs sync as RunKey + summary (never raw events); deleting a design deletes its runs in the cloud too. Deleting an account cascades to every session, account and sync record.

## Known limits

- Email verification and password reset are on when the three Brevo variables are set. Existing unverified users must verify before their next sign-in. Brevo's free plan allows 300 emails a day.
- See `docs/OPERATIONS.md` for the runbook (restore, secret rotation, retention).
- Conflict rule: designs and reviews are last-write-wins by `updatedAt`; progress is max-merged on the client.
- Quotas: 5,000 synced records per user, 2 MB per design, 200 records per request.
