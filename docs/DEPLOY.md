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
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional. |

Copy `.env.example` to `.env.local` for development. Never commit real values.

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

Deleting an account cascades to every session, account and sync record.

## Known limits

- Email verification and password reset need an email provider; none is configured yet. Add one with Better Auth's `sendResetPassword` / `sendVerificationEmail` hooks before opening sign-ups widely.
- Conflict rule: designs and reviews are last-write-wins by `updatedAt`; progress is max-merged on the client.
- Quotas: 5,000 synced records per user, 2 MB per design, 200 records per request.
