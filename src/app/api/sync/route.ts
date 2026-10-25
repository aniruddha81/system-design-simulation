import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { env } from "@/server/env";
import { MAX_PAGE, pullRecords, pushRecords, pushSchema } from "@/server/sync";

const MAX_BODY = 4 * 1024 * 1024;
const noStore = { "Cache-Control": "no-store" };

async function userId() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.id;
}

/** Pull: records changed after `since` (server cursor), oldest first, one page at a time. */
export async function GET(req: Request) {
  const uid = await userId();
  if (!uid)
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: noStore },
    );
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
  const uid = await userId();
  if (!uid)
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: noStore },
    );
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(env().BETTER_AUTH_URL).origin)
    return NextResponse.json(
      { error: "bad origin" },
      { status: 403, headers: noStore },
    );
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    return NextResponse.json(
      { error: "json only" },
      { status: 415, headers: noStore },
    );
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY)
    return NextResponse.json(
      { error: "too large" },
      { status: 413, headers: noStore },
    );
  const body = pushSchema.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return NextResponse.json(
      { error: "invalid body" },
      { status: 400, headers: noStore },
    );
  return NextResponse.json(await pushRecords(uid, body.data.records), {
    headers: noStore,
  });
}
