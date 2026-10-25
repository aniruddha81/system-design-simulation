import { beforeEach, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

const state = vi.hoisted(() => ({ db: { user: [], session: [], account: [], verification: [], rateLimit: [] } as Record<string, Record<string, unknown>[]>, mail: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./env", () => ({ env: () => ({ DATABASE_URL: "postgresql://unused", BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "local-test-secret-not-for-production-12345" }) }));
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: () => memoryAdapter(state.db) }));
vi.mock("./email", () => ({ emailEnforced: () => true, accountEmail: () => ({ subject: "test", text: "test", html: "test" }), sendEmail: state.mail }));
import { auth } from "./auth";
import { POST } from "../app/api/auth/[...all]/route";

const email = "security@example.test";
const password = "Local-security-test-Password123!";
const request = (path: string, body: unknown, cookie = "") => new Request(`http://localhost:3000/api/auth/${path}`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": "192.0.2.50", cookie }, body: JSON.stringify(body) });
const cookies = (response: Response) => response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
beforeEach(() => { for (const key of Object.keys(state.db)) state.db[key] = []; state.mail.mockClear(); });

it("rejects old cached session cookies immediately after logout", async () => {
  expect((await auth.handler(request("sign-up/email", { email, password, name: "Learner" }))).status).toBe(200);
  state.db.user[0].emailVerified = true;
  const oldAuth = betterAuth({ ...auth.options, plugins: [], session: { cookieCache: { enabled: true, maxAge: 300 } } });
  const cookie = cookies(await oldAuth.handler(request("sign-in/email", { email, password })));
  expect(cookie).toContain("session_data=");
  expect((await auth.handler(request("sign-out", {}, cookie))).status).toBe(200);
  expect(state.db.session).toHaveLength(0);
  expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
});

it("validates names before creating unverified accounts and on profile updates", async () => {
  expect((await auth.handler(request("sign-up/email", { email, password, name: "x".repeat(100000) }))).status).toBe(400);
  expect(state.db.user).toHaveLength(0);
  expect(state.mail).not.toHaveBeenCalled();
  expect((await auth.handler(request("sign-up/email", { email, password, name: "Learner" }))).status).toBe(200);
  state.db.user[0].emailVerified = true;
  const cookie = cookies(await auth.handler(request("sign-in/email", { email, password })));
  expect((await auth.handler(request("update-user", { name: "x".repeat(81) }, cookie))).status).toBe(400);
  expect(state.db.user[0].name).toBe("Learner");
  expect((await auth.handler(request("update-user", { image: "javascript:alert(1)" }, cookie))).status).toBe(400);
});

it("caps streamed auth bodies without relying on Content-Length", async () => {
  const response = await POST(request("sign-up/email", { email, password, name: "x".repeat(17000) }));
  expect(response.status).toBe(413);
  expect(state.db.user).toHaveLength(0);
});
