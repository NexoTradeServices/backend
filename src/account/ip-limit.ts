// A per-client-IP limiter for the public account endpoint -- Feature 3004.
//
// The login's limiter is Better Auth's own, inside its handler, and only sees its own paths. This
// endpoint is ours, so it carries the same idea: a sliding one-minute window per client IP, read
// from the same trusted header the login uses (AUTH_TRUSTED_IP_HEADER, feature 1013), else the
// socket address. In memory: one process, and a restart clears the window, which is harmless.
import type { Request } from "express";

export function clientIpOf(req: Request): string {
  const header = process.env["AUTH_TRUSTED_IP_HEADER"]?.toLowerCase();
  if (header) {
    const value = req.headers[header];
    const first = (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function ipLimiter(perMinute: number): (req: Request) => boolean {
  const hits = new Map<string, number[]>();
  return (req) => {
    const now = Date.now();
    const ip = clientIpOf(req);
    const recent = (hits.get(ip) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= perMinute) {
      hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    hits.set(ip, recent);
    return true;
  };
}
