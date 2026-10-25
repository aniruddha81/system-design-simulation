// Fixed event names only: never serialize errors, request headers, paths or user data.
export function log(level: "info" | "warn" | "error", event: "server_started" | "server_error" | "rate_limit_unavailable" | "error_report_unavailable" | "prune_failed") {
  console[level](JSON.stringify({ level, event, time: new Date().toISOString() }));
}
