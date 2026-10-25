import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";
import { readBody } from "../../body";

const handlers = toNextJsHandler(auth);
export const GET = handlers.GET;
export async function POST(req: Request) {
  let body: string;
  try { body = await readBody(req, 16 * 1024); }
  catch { return Response.json({ error: "too large" }, { status: 413, headers: { "Cache-Control": "no-store" } }); }
  return handlers.POST(new Request(req.url, { method: "POST", headers: req.headers, body }));
}
