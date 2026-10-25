import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { accountEmail, emailConfigured, sendEmail } from "./email";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("account email", () => {
  it("escapes interpolated HTML and preserves the plain text link", () => {
    const url = `https://example.test/verify?token=<tag>&name="O'Reilly"`;
    const message = accountEmail("Verify your email", url);
    expect(message.html).toContain("&lt;tag&gt;&amp;name=&quot;O&#39;Reilly&quot;");
    expect(message.html).not.toContain("<tag>");
    expect(message.text).toContain(url);
    expect(() => accountEmail("Reset your password", "javascript:alert(1)")).toThrow("Invalid email link");
  });
  it.each([undefined, "sender@example.test"])("does not send or disclose links in production without full configuration (%s)", async (from) => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", from);
    vi.stubEnv("NODE_ENV", "production");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(emailConfigured()).toBe(false);
    await sendEmail({ to: "private@example.test", ...accountEmail("Reset your password", "https://example.test/reset?token=secret") });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([[JSON.stringify({ message: "email not sent: provider not configured" })]]);
  });
  it("prints the link only in development when unconfigured", async () => {
    vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("NODE_ENV", "development");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const message = accountEmail("Reset your password", "http://localhost/reset?token=dev");
    await sendEmail({ to: "test@example.test", ...message });
    expect(log).toHaveBeenCalledWith(message.text);
  });
  it("sends through Resend and reports failures without provider contents", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("EMAIL_FROM", "sender@example.test");
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetcher);
    const message = { to: "test@example.test", ...accountEmail("Verify your email", "https://example.test/verify") };
    await sendEmail(message);
    expect(fetcher).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({ method: "POST", body: JSON.stringify({ from: "sender@example.test", ...message }) }));
    fetcher.mockResolvedValue({ ok: false });
    await expect(sendEmail(message)).rejects.toThrow("Email delivery failed");
  });
});
