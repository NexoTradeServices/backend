// Feature 1013 -- auth rate limiting sees real client IPs.
//
// Kept out of config.ts and free of any Prisma/notifications import so a test
// can re-import it fresh (vitest's resetModules) under a different NODE_ENV
// without dragging the database client along.
//
// AUTH_TRUSTED_IP_HEADER names the ONE header this app's runtime actually
// sits behind: Caddy on .41 sets X-Forwarded-For for dev (project/setup/
// 01-dev-environment.md); Fly's own edge sets Fly-Client-IP for prod
// (fly.toml [env]) and that header is not client-settable. AUTH_TRUSTED_PROXIES
// is the address(es) that hop connects from, so a forwarded chain is only
// walked past a hop we actually recognise (Better Auth's own
// advanced.ipAddress.trustedProxies -- see node_modules/@better-auth/core/
// src/utils/ip.ts, getIPFromHeader). Both are optional and read fresh, not
// defaulted here -- an unset value leaves Better Auth's own out-of-box
// behaviour (single shared bucket, WARN) exactly as it was before this
// feature, matching decision 1 (environment CONFIG, not code).
export interface IpAddressConfig {
  ipAddressHeaders?: string[];
  trustedProxies?: string[];
}

export function buildIpAddressConfig(): IpAddressConfig | undefined {
  const header = process.env["AUTH_TRUSTED_IP_HEADER"];
  const proxies = process.env["AUTH_TRUSTED_PROXIES"];
  if (!header && !proxies) {
    return undefined;
  }
  const config: IpAddressConfig = {};
  if (header) {
    config.ipAddressHeaders = [header];
  }
  if (proxies) {
    config.trustedProxies = proxies
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return config;
}
