import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/server/db";

/** Liveness + DB reachability for uptime monitors. No secrets, no caching. */
let last = { at: 0, up: false };
export async function GET() {
  // The route is public: probe the database at most every 10 s so a request flood cannot turn into a query flood.
  if (Date.now() - last.at > 10_000) {
    try {
      await getDb().execute(sql`select 1`);
      last = { at: Date.now(), up: true };
    } catch {
      last = { at: Date.now(), up: false };
    }
  }
  return last.up
    ? NextResponse.json({ ok: true, db: "up" }, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ ok: false, db: "down" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
