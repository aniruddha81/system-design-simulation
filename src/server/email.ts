import "server-only";

// Brevo transactional email (https://developers.brevo.com). A private machine-to-machine OAuth app
// (scope transactional.email:write) mints 1-hour bearer tokens; the sender address must be authenticated in Brevo.
const TOKEN_URL = "https://oauth.brevo.com/realms/partner/oauth/token";
const SEND_URL = "https://api.brevo.com/v3/smtp/email";

export function emailConfigured() {
  return Boolean(process.env.BREVO_CLIENT_ID && process.env.BREVO_CLIENT_SECRET && process.env.EMAIL_FROM);
}

/** When mail can be delivered, sign-up requires a verified email. Without a provider nobody is locked out. */
// Fail closed in production: a missing Brevo setting must not silently turn verification off.
export const emailEnforced = () => process.env.NODE_ENV === "production" || emailConfigured();

/** "Name <a@b.c>" or "a@b.c" -> {name?, email}. */
export function parseSender(from: string) {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(from);
  return match ? { ...(match[1] ? { name: match[1] } : {}), email: match[2] } : { email: from.trim() };
}

let cached: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.BREVO_CLIENT_ID!,
      client_secret: process.env.BREVO_CLIENT_SECRET!,
      scope: "transactional.email:write",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Email provider authentication failed");
  const body = (await response.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function accountEmail(action: "Verify your email" | "Reset your password" | "Confirm account deletion", url: string) {
  const link = new URL(url);
  if (link.protocol !== "https:" && link.protocol !== "http:") throw new Error("Invalid email link");
  return {
    subject: action,
    text: `System Design Simulator\n\n${action}\n${url}\n\nIf you did not request this, ignore this email.`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(action)}</title></head><body><main><p>System Design Simulator</p><h1>${escape(action)}</h1><p><a href="${escape(url)}">${escape(action)}</a></p><p>If you did not request this, ignore this email.</p></main></body></html>`,
  };
}

export async function sendEmail(message: { to: string; subject: string; text: string; html: string }) {
  if (!emailConfigured()) {
    console.info(JSON.stringify({ message: "email not sent: provider not configured" }));
    if (process.env.NODE_ENV === "development") console.info(message.text);
    return;
  }
  const response = await fetch(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: parseSender(process.env.EMAIL_FROM!),
      to: [{ email: message.to }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // Provider responses may contain message contents; never include them in errors.
  if (!response.ok) {
    if (response.status === 401) cached = undefined; // token revoked or rotated: mint a new one next time
    throw new Error("Email delivery failed");
  }
}
