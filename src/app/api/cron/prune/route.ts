import { timingSafeEqual } from "node:crypto";
import { lt } from "drizzle-orm";
import { getDb } from "@/server/db";
import { apiRateLimit, clientErrors } from "@/server/db/schema";
import { log } from "@/server/log";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  const headers = { "Cache-Control": "no-store" };
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    const now = Date.now();
    await getDb().delete(clientErrors).where(lt(clientErrors.createdAt, new Date(now - 30 * 86400_000)));
    await getDb().delete(apiRateLimit).where(lt(apiRateLimit.windowStart, new Date(now - 86400_000)));
    return Response.json({ ok: true }, { headers });
  } catch {
    log("error", "prune_failed");
    return Response.json({ error: "unavailable" }, { status: 503, headers });
  }
}
