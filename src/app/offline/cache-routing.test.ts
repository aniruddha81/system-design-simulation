import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const route = runInNewContext(`${readFileSync("public/sw.js", "utf8")}\ncacheRoute`, {
  URL, self: { addEventListener() {} },
}) as (request: { url: string; method: string; mode: string }, origin: string) => string;
const origin = "https://notebook.test";
const classify = (path: string, method = "GET", mode = "navigate") =>
  route({ url: new URL(path, origin).href, method, mode }, origin);

describe("offline cache routing", () => {
  it("caches public documents and static assets", () => {
    for (const path of ["/learn", "/learn/building-blocks/caching", "/case-studies/example", "/offline", "/privacy", "/terms"]) expect(classify(path)).toBe("page");
    expect(classify("/_next/static/chunk.js", "GET", "cors")).toBe("asset");
    expect(classify("/icons/icon-192.png")).toBe("asset");
  });
  it("bypasses APIs, auth, personal pages, mutations and other origins", () => {
    for (const path of ["/api/sync", "/api/auth/get-session", "/auth", "/account", "/settings", "/sandbox", "/learn?token=secret", "https://other.test/learn"]) expect(classify(path)).toBe("network");
    expect(classify("/learn", "POST")).toBe("network");
    expect(classify("/learn/building-blocks/caching", "GET", "cors")).toBe("network");
    expect(classify("/learn?_rsc=abc", "GET", "cors")).toBe("network");
  });
});
