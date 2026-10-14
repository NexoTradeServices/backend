// The identity cache -- Feature 1014, brand strings go to config.
//
// GET /api/identity is public, no session, hit by every logged-out page load
// (Foundations / Brand identity, decision 4). Caching it in-process avoids a
// DB round trip per page view; the settings PUT invalidates it directly on a
// save, and the 60-second TTL is only the backstop for a change that landed
// some other way (a direct DB edit, a second app instance).
const TTL_MS = 60_000;

// Feature 1018: the public identity is the name AND the support phone (the
// frontend Footer reads both), held together so one save clears both.
export interface PublicIdentity {
  displayName: string;
  operatorPhone: string;
  // Feature 8002: the one host search engines may list; null = none (fail-safe).
  approvedPublicDomain: string | null;
}

let cached: { identity: PublicIdentity; expiresAt: number } | null = null;

export function getCachedIdentity(): PublicIdentity | null {
  if (cached === null) return null;
  if (Date.now() >= cached.expiresAt) {
    cached = null;
    return null;
  }
  return cached.identity;
}

export function setCachedIdentity(identity: PublicIdentity): void {
  cached = { identity, expiresAt: Date.now() + TTL_MS };
}

/** Called by the settings PUT on every save -- the next identity read is never stale. */
export function invalidateIdentityCache(): void {
  cached = null;
}
