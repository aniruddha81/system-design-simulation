import { createHmac } from "node:crypto";
import { z } from "zod";
import { auth } from "@/server/auth";
import { getDb } from "@/server/db";
import { clientErrors } from "@/server/db/schema";
import { env } from "@/server/env";
import { rateLimit } from "@/server/rate-limit";
import { log } from "@/server/log";
import { errorPath, scrub } from "@/lib/report-error";
import { readBody } from "../body";

const schema = z.object({ message: z.string().max(2000), stack: z.string().max(8000).optional(), url: z.string().max(2000) });
const headers = { "Cache-Control": "no-store" };
export async function POST(req: Request) {
  if (req.headers.get("origin") !== new URL(env().BETTER_AUTH_URL).origin)
    return Response.json({ error: "bad origin" }, { status: 403, headers });
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ error: "json only" }, { status: 415, headers });
  // Vercel overwrites x-vercel-forwarded-for. Never trust client-supplied x-forwarded-for.
  const ip = req.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const hash = (value: string) => createHmac("sha256", env().BETTER_AUTH_SECRET).update(value).digest("hex");
  const ipLimit = await rateLimit(`errors:ip:${hash(ip)}`, 0, 20);
  if (!ipLimit.allowed) return Response.json({ error: "rate limited" }, { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retryAfter) } });
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (session) {
      const limit = await rateLimit(`errors:user:${hash(session.user.id)}`, 0, 10);
      if (!limit.allowed) return Response.json({ error: "rate limited" }, { status: 429, headers: { ...headers, "Retry-After": String(limit.retryAfter) } });
    }
    let raw: string;
    try { raw = await readBody(req, 16 * 1024); }
    catch { return Response.json({ error: "too large" }, { status: 413, headers }); }
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400, headers });
    await getDb().insert(clientErrors).values({
      id: crypto.randomUUID(), userId: session?.user.id ?? null,
      message: scrub(parsed.data.message), stack: scrub(parsed.data.stack ?? "", 4096),
      url: errorPath(parsed.data.url), userAgent: scrub(req.headers.get("user-agent") ?? "", 200),
      release: /^[a-f0-9]{7,40}$/i.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "") ? process.env.VERCEL_GIT_COMMIT_SHA : "unknown",
    });
    return new Response(null, { status: 204, headers });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "invalid json" }, { status: 400, headers });
    log("warn", "error_report_unavailable");
    return Response.json({ error: "unavailable" }, { status: 503, headers });
  }
}
