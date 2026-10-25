import "server-only";

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/** Resend's shared test sender only delivers to the account owner, so it must never gate sign-in. */
export function emailSandbox() {
  return /@resend\.dev>?\s*$/i.test(process.env.EMAIL_FROM ?? "");
}

/** True when real users can receive mail: a verified-domain sender is configured. Only then is verification required. */
export function emailEnforced() {
  return emailConfigured() && !emailSandbox();
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function accountEmail(action: "Verify your email" | "Reset your password", url: string) {
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
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, ...message }),
    signal: AbortSignal.timeout(10_000),
  });
  // Provider responses may contain message contents; never include them in errors.
  if (!response.ok) {
    // Sandbox sender rejects everyone but the account owner; log and carry on instead of failing the request.
    if (emailSandbox()) return void console.warn(JSON.stringify({ message: "email not delivered: sandbox sender only reaches the Resend account owner", status: response.status }));
    throw new Error("Email delivery failed");
  }
}
