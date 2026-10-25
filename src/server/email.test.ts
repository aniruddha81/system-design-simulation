import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { accountEmail, emailConfigured, parseSender, sendEmail } from "./email";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const configure = () => { vi.stubEnv("BREVO_CLIENT_ID", "id"); vi.stubEnv("BREVO_CLIENT_SECRET", "secret"); vi.stubEnv("EMAIL_FROM", "System Design Simulator <noreply@example.test>"); };
const token = { ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) };

describe("account email", () => {
  it("escapes interpolated HTML and preserves the plain text link", () => {
    const url = `https://example.test/verify?token=<tag>&name="O'Reilly"`;
    const message = accountEmail("Verify your email", url);
    expect(message.html).toContain("&lt;tag&gt;&amp;name=&quot;O&#39;Reilly&quot;");
    expect(message.html).not.toContain("<tag>");
    expect(message.text).toContain(url);
    expect(() => accountEmail("Reset your password", "javascript:alert(1)")).toThrow("Invalid email link");
  });
  it.each([["", "sender@example.test"], ["id", ""]])("does not send or disclose links without full configuration (%s/%s)", async (id, from) => {
    vi.stubEnv("BREVO_CLIENT_ID", id); vi.stubEnv("BREVO_CLIENT_SECRET", id); vi.stubEnv("EMAIL_FROM", from); vi.stubEnv("NODE_ENV", "production");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(emailConfigured()).toBe(false);
    await sendEmail({ to: "private@example.test", ...accountEmail("Reset your password", "https://example.test/reset?token=secret") });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([[JSON.stringify({ message: "email not sent: provider not configured" })]]);
  });
  it("prints the link only in development when unconfigured", async () => {
    vi.stubEnv("BREVO_CLIENT_ID", ""); vi.stubEnv("NODE_ENV", "development");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const message = accountEmail("Reset your password", "http://localhost/reset?token=dev");
    await sendEmail({ to: "test@example.test", ...message });
    expect(log).toHaveBeenCalledWith(message.text);
  });
  it("parses sender addresses", () => {
    expect(parseSender("System Design Simulator <noreply@example.test>")).toEqual({ name: "System Design Simulator", email: "noreply@example.test" });
    expect(parseSender("noreply@example.test")).toEqual({ email: "noreply@example.test" });
  });
  it("mints a token, sends through Brevo and reports failures without provider contents", async () => {
    configure();
    const message = { to: "test@example.test", ...accountEmail("Verify your email", "https://example.test/verify") };
    const fetcher = vi.fn().mockResolvedValueOnce(token).mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetcher);
    await sendEmail(message);
    expect(fetcher.mock.calls[0][0]).toBe("https://oauth.brevo.com/realms/partner/oauth/token");
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toMatchObject({ sender: { name: "System Design Simulator", email: "noreply@example.test" }, to: [{ email: "test@example.test" }], subject: "Verify your email", textContent: message.text });
    // the cached token is reused, no second token request
    await sendEmail(message);
    expect(fetcher.mock.calls.filter(([u]) => String(u).includes("oauth")).length).toBe(1);
    fetcher.mockResolvedValue({ ok: false, status: 400, text: async () => "secret provider detail" });
    await expect(sendEmail(message)).rejects.toThrow(/^Email delivery failed$/);
  });
});
