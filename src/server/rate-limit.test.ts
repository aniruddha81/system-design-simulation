import { describe, expect, it } from "vitest";
import { windowFor, withinLimit } from "./rate-limit";
import { errorPath, scrub } from "../lib/report-error";
import { readBody } from "../app/api/body";

describe("production safeguards", () => {
  it("uses fixed minute boundaries with a positive Retry-After", () => {
    expect(windowFor(0)).toEqual({ start: 0, retryAfter: 60 });
    expect(windowFor(59_999)).toEqual({ start: 0, retryAfter: 1 });
    expect(windowFor(60_000)).toEqual({ start: 60_000, retryAfter: 60 });
    expect(withinLimit(120, 10, 120, 10)).toBe(true);
    expect(withinLimit(121, 10, 120, 10)).toBe(false);
    expect(withinLimit(1, 11, 120, 10)).toBe(false);
  });
  it("removes queries, emails and credential-shaped strings before truncating", () => {
    const value = scrub('https://site/a?token=private user@example.com Bearer abc.def token=foo secret: bar abcdefghijklmnopqrstuvwxyz123456');
    for (const secret of ["private", "user@example.com", "abc.def", "foo", "bar", "abcdefghijklmnopqrstuvwxyz123456"]) expect(value).not.toContain(secret);
    expect(errorPath("https://site/a?q=secret#fragment")).toBe("/a");
    expect(errorPath("/user/person@example.com?token=x")).toBe("/user/[email]");
    expect(new TextEncoder().encode(scrub("\u754c".repeat(200), 500)).length).toBeLessThanOrEqual(500);
    expect(errorPath("/user/person%40example.com?token=x")).toBe("/user/[email]");
    expect(scrub("x".repeat(600)).length).toBeLessThanOrEqual(500);
  });
  it("caps streamed bodies without trusting Content-Length", async () => {
    await expect(readBody(new Request("https://local", { method: "POST", body: "abcd" }), 3)).rejects.toThrow("too large");
    expect(await readBody(new Request("https://local", { method: "POST", body: "\u00e9" }), 2)).toBe("\u00e9");
  });
});
