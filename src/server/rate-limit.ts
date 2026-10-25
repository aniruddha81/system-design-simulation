export const WINDOW_MS = 60_000;
export const SYNC_REQUESTS = 120;
export const SYNC_BYTES = 10 * 1024 * 1024;

export function windowFor(now: number) {
  const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  return { start, retryAfter: Math.max(1, Math.ceil((start + WINDOW_MS - now) / 1000)) };
}

export function withinLimit(requests: number, bytes: number, maxRequests: number, maxBytes: number) {
  return requests <= maxRequests && bytes <= maxBytes;
}

/** One atomic upsert; database time is shared by every serverless instance. */
export async function rateLimit(key: string, bytes = 0, maxRequests = SYNC_REQUESTS, maxBytes = SYNC_BYTES) {
  try {
    const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
    const rows = await getDb().execute(sql`
      insert into api_rate_limit (key, window_start, requests, bytes)
      values (${key}, date_trunc('minute', statement_timestamp()), 1, ${bytes})
      on conflict (key) do update set
        requests = case when api_rate_limit.window_start = excluded.window_start then least(api_rate_limit.requests + 1, ${maxRequests + 1}) else 1 end,
        bytes = case when api_rate_limit.window_start = excluded.window_start then least(api_rate_limit.bytes + excluded.bytes, ${maxBytes + 1}) else excluded.bytes end,
        window_start = excluded.window_start
      returning requests, bytes,
        greatest(1, ceil(extract(epoch from (window_start + interval '1 minute' - statement_timestamp())))) as retry_after
    `);
    const row = rows.rows[0];
    return { allowed: withinLimit(Number(row.requests), Number(row.bytes), maxRequests, maxBytes), retryAfter: Number(row.retry_after) };
  } catch {
    const { log } = await import("./log");
    log("warn", "rate_limit_unavailable");
    return { allowed: true, retryAfter: 60 };
  }
}
