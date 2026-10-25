# Operations

## Health and incidents

Monitor `GET /api/health` once per minute. A 200 means the process can query Postgres; 503 means the DB check failed. Responses contain no credentials. Alert after three consecutive failures. Also monitor function error counts and the age of the last successful pruning invocation.

During an incident:

1. Record the start time, affected routes, deployment release and impact. Never copy session cookies, sync payloads or database URLs into tickets.
2. Check health, Neon availability and `docker compose logs app` on EC2. Logs are one-line JSON with fixed event names; `rate_limit_unavailable` means protection is temporarily failing open.
3. Roll back the application deployment if correlated with a release. Do not blindly reverse a migration or delete local learner data.
4. Restore service, verify authenticated push/pull and signed-out local use, then document the cause and prevention.

Server logs deliberately omit raw error messages, stacks, headers, user IDs and request URLs. Client reports retain a scrubbed message, stack, path, user agent, release and optional account ID. Treat these rows as restricted diagnostic data: heuristic scrubbing cannot guarantee removal of arbitrary personal text. Limit database access to incident responders. No external reporting vendor receives this data.

## Rate limits

`/api/sync` shares 120 requests and 10 MiB of POST body bytes per authenticated user per fixed UTC minute, across instances. Requests and bytes are charged atomically in one Postgres upsert. Rejected pushes do not alter sync records. 429 includes seconds in `Retry-After`; the browser pauses sync requests until that time, leaving local changes pending for the next sync trigger. Window boundaries can permit two minutes of quota in a short burst. DB failures log a warning and fail open, so an unavailable limiter does not itself block sync.

`POST /api/errors` requires the configured same origin, JSON, and at most 16 KiB streamed bytes. It permits 20 reports per minute per IP and 10 per signed-in user. Keys use HMAC hashes; raw IPs are not stored. Caddy overwrites `x-real-ip` with the TCP peer address and the app port is not public. Never trust arbitrary forwarded headers. Query strings, fragments, email patterns and credential-shaped text are removed before storage. Stack is capped to 4096 UTF-8 bytes and the whole request to 16 KiB. Release comes from the server deployment, not the browser.

## Migrations

1. Change the Drizzle schema; run `npx drizzle-kit generate` offline. Review generated SQL and snapshot. Commit these through the normal runner.
2. Before applying, create a Neon branch or verify the point-in-time recovery window. Test migration on a disposable branch with the same existing schema.
3. The lead runs `npm run db:migrate` using `DATABASE_URL_UNPOOLED` (direct host). Never run migrations from a request handler. Apply this additive migration before deploying its consumers.
4. Deploy, check health, authenticated sync, errors ingestion and pruning authorization. Keep old columns/tables while rollback compatibility is needed. Application rollback does not undo SQL.

## Database restore

Use the Neon console with an authorized operator. Choose a restore point just before the incident within the project's configured recovery window; create a recovery branch and inspect counts, account/session integrity and representative sync records. Do not overwrite production as the first step. Test health and sync against the branch in an isolated deployment. Pause writes for final cutover, update pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` together, redeploy, and verify schema/migration history before resuming traffic. Retain the original branch until reconciliation is complete. A restore can lose writes after the recovery point; reconcile cloud and local copies before promising recovery. Recovery availability depends on the project's Neon plan and retention settings; verify these before launch.

## Authentication secret rotation

Generate a fresh cryptographically random secret of at least 32 bytes through the deployment secret manager. Update `BETTER_AUTH_SECRET` for the intended environment and redeploy all instances together. Expect existing sessions to require sign-in again; verify login, logout, OAuth callbacks and sync. HMAC limiter identities also change, resetting error-report quotas. Keep the old secret only in controlled rollback storage and revoke it after verification. If compromise is suspected, do not restore the old secret to roll back; invalidate existing sessions in the database and review account activity with the auth owner.

## Retention and cron

The EC2 host runs the daily UTC schedule `17 3 * * *` described in `DEPLOY-AWS.md`. It executes `deploy/check.mjs prune` inside the app container, reading `CRON_SECRET` from its environment and requiring a successful HTTP 200 JSON response. Missing or incorrect credentials return 401 and make no changes. Never put the secret in a URL or call HTTP localhost through Caddy: that returns a redirect without pruning. Check the scheduler's success record daily and alert on failures. The endpoint is safe to retry: it deletes client errors older than 30 days and limiter rows whose minute began over one day ago. Partial deletion on failure is harmless; rerun after resolving the database issue. Retention in backups follows Neon's separately configured recovery policy.

Required existing environment: `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (migration only), `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`. New: `CRON_SECRET`. Optional: `VERCEL_GIT_COMMIT_SHA` for diagnostic release attribution (otherwise `unknown`). Never expose secrets with `NEXT_PUBLIC_`.

## Release verification by the lead

Apply the generated migration, then run production build and e2e. Exercise concurrent quota enforcement, byte limits, 429 Retry-After and resumed sync; simulate DB limiter failure and confirm the warning. Check error reports for scrubbed content and restricted DB access. Send oversized chunked bodies, foreign origins, anonymous report floods and invalid cron credentials. Check both error boundaries at phone/desktop widths, keyboard focus and both themes; force a root layout error and verify its standalone styles, recovery action and report delivery. Confirm a dry-run retention query selects only expired rows before enabling cron.
