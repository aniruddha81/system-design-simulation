import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { MAX_PAGE, pullRecords, pushRecords, pushSchema } from "@/server/sync";

import { rateLimit } from "@/server/rate-limit";
import { rejectUnlessSameOriginJson } from "../guard";
import { readBody } from "../body";

const MAX_BODY = 4 * 1024 * 1024;
const noStore = { "Cache-Control": "no-store" };

async function userId(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers, query: { disableCookieCache: true } });
  // Bind each request to the workspace that started it, even if another tab changes the session cookie.
  return session && req.headers.get("x-sds-user") === session.user.id ? session.user.id : undefined;
}

/** Pull: records changed after `since` (server cursor), oldest first, one page at a time. */
export async function GET(req: Request) {
  const uid = await userId(req);
  if (!uid)
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: noStore },
    );
  const limit = await rateLimit(`sync:${uid}`);
  if (!limit.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { ...noStore, "Retry-After": String(limit.retryAfter) } });
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") ?? 0);
  if (!Number.isSafeInteger(since) || since < 0)
    return NextResponse.json(
      { error: "bad cursor" },
      { status: 400, headers: noStore },
    );
  return NextResponse.json(await pullRecords(uid, since, MAX_PAGE), {
    headers: noStore,
  });
}

/** Push: a batch of records. Same-origin JSON only (CSRF), size-capped, each record validated. */
export async function POST(req: Request) {
  const uid = await userId(req);
  if (!uid)
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: noStore },
    );
  const rejected = rejectUnlessSameOriginJson(req);
  if (rejected) return rejected;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY)
    return NextResponse.json(
      { error: "too large" },
      { status: 413, headers: noStore },
    );
  let raw: string;
  try { raw = await readBody(req, MAX_BODY); }
  catch { return NextResponse.json({ error: "too large" }, { status: 413, headers: noStore }); }
  const limit = await rateLimit(`sync:${uid}`, Buffer.byteLength(raw));
  if (!limit.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { ...noStore, "Retry-After": String(limit.retryAfter) } });
  let json: unknown;
  try { json = JSON.parse(raw); } catch { json = null; }
  const body = pushSchema.safeParse(json);
  if (!body.success)
    return NextResponse.json(
      { error: "invalid body" },
      { status: 400, headers: noStore },
    );
  return NextResponse.json(await pushRecords(uid, body.data.records), {
    headers: noStore,
  });
}
