import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), pull: vi.fn(), push: vi.fn(), limit: vi.fn() }));
vi.mock("@/server/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@/server/rate-limit", () => ({ rateLimit: mocks.limit }));
vi.mock("@/server/env", () => ({ env: () => ({ BETTER_AUTH_URL: "https://example.test" }) }));
vi.mock("@/server/sync", async () => ({ ...await import("../../../server/sync-validate"), pullRecords: mocks.pull, pushRecords: mocks.push }));
import { GET, POST } from "./route";

beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: "B" } }); mocks.limit.mockResolvedValue({ allowed: true }); mocks.pull.mockResolvedValue({ records: [], cursor: 0, hasMore: false }); mocks.push.mockResolvedValue({ accepted: 0, rejected: [] }); });
const request = (method: string, owner?: string) => new Request("https://example.test/api/sync", { method, headers: { origin: "https://example.test", "content-type": "application/json", ...(owner ? { "x-sds-user": owner } : {}) }, ...(method === "POST" ? { body: '{"records":[]}' } : {}) });

it.each([undefined, "A"])("rejects stale or missing workspace identity %s before accessing data", async owner => {
  expect((await GET(request("GET", owner))).status).toBe(401);
  expect((await POST(request("POST", owner))).status).toBe(401);
  expect(mocks.pull).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
});
it("uses the authoritative session and accepts only its workspace", async () => {
  expect((await GET(request("GET", "B"))).status).toBe(200);
  expect((await POST(request("POST", "B"))).status).toBe(200);
  expect(mocks.session.mock.calls[0][0].query.disableCookieCache).toBe(true);
  expect(mocks.push).toHaveBeenCalledWith("B", []);
});
