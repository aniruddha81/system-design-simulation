import assert from "node:assert/strict";

async function validate(response, mode) {
  if (response.status !== 200) throw new Error(`${mode}: expected HTTP 200, got ${response.status}`);
  const body = await response.json();
  if (body.ok !== true || (mode === "health" && body.db !== "up")) throw new Error(`${mode}: check failed`);
}

const mode = process.argv[2] ?? "health";
if (mode === "--self-test") {
  await validate(Response.json({ ok: true, db: "up" }), "health");
  await validate(Response.json({ ok: true }), "prune");
  await assert.rejects(validate(new Response(null, { status: 308 }), "health"));
  await assert.rejects(validate(Response.json({ ok: true, db: "down" }), "health"));
  await assert.rejects(validate(Response.json({ ok: false }), "prune"));
  console.log("maintenance response checks passed");
} else {
  if (mode !== "health" && mode !== "prune") throw new Error("Expected health or prune");
  if (mode === "prune" && !process.env.CRON_SECRET) throw new Error("CRON_SECRET is required");
  const response = await fetch(`http://127.0.0.1:3000/api/${mode === "prune" ? "cron/prune" : "health"}`, {
    redirect: "error", signal: AbortSignal.timeout(15000),
    headers: mode === "prune" ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
  });
  await validate(response, mode);
  console.log(`${mode}: ok`);
}
