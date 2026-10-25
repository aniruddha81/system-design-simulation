import { env } from "@/server/env";

const headers = { "Cache-Control": "no-store" };

/** CSRF + content-type guard shared by every state-changing JSON route: exact same-origin, JSON only. Returns the error response, or null to proceed. */
export function rejectUnlessSameOriginJson(req: Request): Response | null {
  if (req.headers.get("origin") !== new URL(env().BETTER_AUTH_URL).origin) return Response.json({ error: "bad origin" }, { status: 403, headers });
  if (!req.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "json only" }, { status: 415, headers });
  return null;
}
