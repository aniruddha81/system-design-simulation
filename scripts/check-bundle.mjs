import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const CONTENT_BYTES = 170 * 1024;
const SANDBOX_BYTES = 350 * 1024;

function limit(route) {
  return route.startsWith("/sandbox/") || (route.startsWith("/challenges/") && route !== "/challenges/page") ? SANDBOX_BYTES : CONTENT_BYTES;
}

function normalize(file) {
  const name = file.replace(/^\/_next\//, "");
  if (!/^static\/.+\.js$/.test(name) || name.split("/").includes("..")) throw new Error(`Unexpected JS chunk path: ${file}`);
  return name;
}

function clientManifest(source) {
  // Next writes an assignment of JSON, not a JSON file. Parse its RHS without
  // executing generated JavaScript, and fail closed if the format changes.
  const assignment = source.match(/(?:globalThis\.)?__RSC_MANIFEST\[[^\n]+?\]\s*=\s*(\{[^]*\});?\s*$/);
  if (!assignment) throw new Error("Unrecognized Next client-reference manifest format");
  return JSON.parse(assignment[1]);
}

function routeChunks(build, client, dynamic) {
  const files = [...(build.rootMainFiles ?? []), ...(build.pages?.["/_app"] ?? [])];
  for (const chunks of Object.values(client.entryJSFiles ?? {})) files.push(...chunks);
  for (const entry of Object.values(dynamic)) files.push(...entry.files);
  return [...new Set(files.filter((f) => f.endsWith(".js")).map(normalize))];
}

async function check() {
  const root = path.resolve(".next");
  const json = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
  await readFile(path.join(root, "BUILD_ID")); // Never accept an incomplete/dev build.
  const routes = await json("server/app-paths-manifest.json");
  const build = await json("build-manifest.json");
  const sizes = new Map();
  const rows = [];
  for (const [route, entry] of Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))) {
    if (!route.endsWith("/page") || route.startsWith("/dev/") || route === "/_global-error/page") continue;
    const base = `server/${entry.slice(0, -3)}`;
    const client = clientManifest(await readFile(path.join(root, `${base}_client-reference-manifest.js`), "utf8"));
    // Include on-demand client islands (notably EditorLoader), not just the shell.
    // Turbopack emits this per route; Webpack emits one global manifest.
    let dynamic;
    try {
      dynamic = await json(`${base}/react-loadable-manifest.json`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // shortcut: the Webpack fallback counts all dynamic islands conservatively;
      // use per-route Webpack chunk graphs if this project switches bundlers.
      dynamic = await json("react-loadable-manifest.json");
    }
    const chunks = routeChunks(build, client, dynamic);
    assert(chunks.length > 0, `No initial JS found for ${route}`);
    let bytes = 0;
    for (const chunk of chunks) {
      if (!sizes.has(chunk)) sizes.set(chunk, gzipSync(await readFile(path.join(root, chunk)), { level: 9 }).length);
      bytes += sizes.get(chunk);
    }
    const budget = limit(route);
    rows.push({ Route: route.replace(/\/page$/, "") || "/", Chunks: chunks.length, "JS gzip KiB": (bytes / 1024).toFixed(2), "Budget KiB": budget / 1024, Result: bytes <= budget ? "PASS" : "FAIL" });
  }
  assert(rows.some((r) => r.Route === "/learn/[track]/[lesson]"), "Lesson route missing from build");
  assert(rows.some((r) => r.Route === "/sandbox/[designId]"), "Sandbox route missing from build");
  console.table(rows);
  if (rows.some((r) => r.Result === "FAIL")) process.exitCode = 1;
}

function selfTest() {
  const js = "static/chunks/shared.js";
  const client = { entryJSFiles: { layout: [js], page: ["static/chunks/page.js", js] } };
  assert.deepEqual(clientManifest(`globalThis.__RSC_MANIFEST = {};\nglobalThis.__RSC_MANIFEST["/page"] = ${JSON.stringify(client)};`), client);
  assert.throws(() => clientManifest("changed manifest format"));
  assert.throws(() => normalize("static/../outside.js"));
  assert.deepEqual(routeChunks({ rootMainFiles: [js] }, client, { editor: { files: ["/_next/static/chunks/editor.js", "static/editor.css"] } }), [js, "static/chunks/page.js", "static/chunks/editor.js"]);
  assert.equal(limit("/learn/[track]/[lesson]/page"), 174080);
  assert.equal(limit("/sandbox/[designId]/page"), 358400);
  assert.equal(limit("/sandbox/page"), SANDBOX_BYTES);
  assert.equal(limit("/challenges/[id]/page"), SANDBOX_BYTES);
  console.log("Bundle checker self-test passed.");
}

try {
  if (process.argv.includes("--self-test")) selfTest();
  else await check();
} catch (error) {
  console.error(`Bundle check failed: ${error.message}`);
  process.exitCode = 1;
}
