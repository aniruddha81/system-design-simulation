/** Scrub before truncation, so truncation cannot expose part of a credential. */
export function scrub(value: string, max = 500) {
  const clean = value
    .replace(/\?[^\s#)"']*/g, "?[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\b["']?\s*[:=]\s*["']?[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_+\/-]{24,}={0,2}\b/g, "[redacted]")
    .slice(0, max);
  let result = "";
  let bytes = 0;
  for (const character of clean) {
    bytes += new TextEncoder().encode(character).length;
    if (bytes > max) break;
    result += character;
  }
  return result;
}

export function errorPath(value: string) {
  try { return scrub(decodeURIComponent(new URL(value, "https://local.invalid").pathname), 500); }
  catch { return "/"; }
}

export function reportError(error: unknown) {
  try {
    const body = JSON.stringify({
      message: scrub(error instanceof Error ? error.message : "Unknown client error"),
      stack: scrub(error instanceof Error ? error.stack ?? "" : "", 4096),
      url: errorPath(location.pathname),
    });
    const blob = new Blob([body], { type: "application/json" });
    if (!navigator.sendBeacon?.("/api/errors", blob)) {
      void fetch("/api/errors", { method: "POST", body: blob, keepalive: true, credentials: "same-origin" }).catch(() => {});
    }
  } catch { /* Reporting must never break recovery. */ }
}
