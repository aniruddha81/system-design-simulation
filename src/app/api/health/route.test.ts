import { afterEach, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("@/server/db", () => ({ getDb: () => ({ execute }) }));
import { GET } from "./route";
afterEach(() => vi.useRealTimers());

it("shares in-flight checks, caches failures, and retries after expiry", async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  execute.mockReturnValueOnce(new Promise<void>(r => { resolve = r; }));
  const requests = Array.from({ length: 8 }, () => GET());
  expect(execute).toHaveBeenCalledTimes(1);
  resolve();
  expect((await Promise.all(requests)).every(r => r.status === 200)).toBe(true);
  await GET();
  expect(execute).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(10001);
  execute.mockRejectedValueOnce(new Error("offline"));
  expect((await GET()).status).toBe(503);
  expect((await GET()).status).toBe(503);
  expect(execute).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(10001);
  execute.mockResolvedValueOnce(undefined);
  expect((await GET()).status).toBe(200);
});
