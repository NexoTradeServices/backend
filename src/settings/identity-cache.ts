// The identity cache -- Feature 1014, brand strings go to config.
//
// GET /api/identity is public, no session, hit by every logged-out page load
// (Foundations / Brand identity, decision 4). Caching it in-process avoids a
// DB round trip per page view; the settings PUT invalidates it directly on a
// save, and the 60-second TTL is only the backstop for a change that landed
// some other way (a direct DB edit, a second app instance).
const TTL_MS = 60_000;

let cached: { displayName: string; expiresAt: number } | null = null;

export function getCachedDisplayName(): string | null {
  if (cached === null) return null;
  if (Date.now() >= cached.expiresAt) {
    cached = null;
    return null;
  }
  return cached.displayName;
}

export function setCachedDisplayName(displayName: string): void {
  cached = { displayName, expiresAt: Date.now() + TTL_MS };
}

/** Called by the settings PUT on every save -- the next identity read is never stale. */
export function invalidateIdentityCache(): void {
  cached = null;
}
