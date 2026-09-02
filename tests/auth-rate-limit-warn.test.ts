// Feature 1013 -- auth rate limiting sees real client IPs
//
// AC4  with the environment configured, the shared-bucket WARN Better Auth
//      logs when it cannot resolve a client IP no longer appears.
//
// That WARN only fires when resolution truly fails -- and
// @better-auth/core's own getIp() falls back to "127.0.0.1" whenever
// NODE_ENV is "dev"/"development"/"test" (see node_modules/@better-auth/
// core/src/utils/ip.ts), which is every other test in this suite. So the
// one thing worth proving here -- that resolution now succeeds where it used
// to fail -- is only observable under NODE_ENV=production, and that env
// read is itself frozen at module-load time inside @better-auth/core (see
// node_modules/@better-auth/core/src/env/env-impl.ts, the `nodeENV` const).
// This file sets NODE_ENV before each dynamic import and resets vitest's
// module registry so that const is re-evaluated fresh -- isolated in its own
// file so that reset never touches the DB-backed auth instance the other
// AC1-3 tests share. Vitest itself also sets `TEST=true` (and `VITEST=true`)
// process-wide, and isTest() honours TEST on its own regardless of NODE_ENV
// (`nodeENV === "test" || toBoolean(env.TEST)`) -- both have to come off too,
// or the dev/test fallback still wins.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_TEST = process.env["TEST"];
const ORIGINAL_VITEST = process.env["VITEST"];
const ORIGINAL_HEADER = process.env["AUTH_TRUSTED_IP_HEADER"];
const ORIGINAL_PROXIES = process.env["AUTH_TRUSTED_PROXIES"];

type GetIp = (req: Headers, options: {
  advanced?: { ipAddress?: { ipAddressHeaders?: string[]; trustedProxies?: string[] } };
}) => string | null;

async function freshProductionGetIp(): Promise<GetIp> {
  process.env["NODE_ENV"] = "production";
  delete process.env["TEST"];
  delete process.env["VITEST"];
  vi.resetModules();
  const mod = await import("@better-auth/core/utils/ip");
  return mod.getIp;
}

async function freshIpAddressConfig(): Promise<() => { ipAddressHeaders?: string[]; trustedProxies?: string[] } | undefined> {
  vi.resetModules();
  const mod = await import("../src/auth/ip-config.js");
  return mod.buildIpAddressConfig;
}

beforeEach(() => {
  delete process.env["AUTH_TRUSTED_IP_HEADER"];
  delete process.env["AUTH_TRUSTED_PROXIES"];
});

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  if (ORIGINAL_TEST === undefined) delete process.env["TEST"];
  else process.env["TEST"] = ORIGINAL_TEST;
  if (ORIGINAL_VITEST === undefined) delete process.env["VITEST"];
  else process.env["VITEST"] = ORIGINAL_VITEST;
  if (ORIGINAL_HEADER === undefined) delete process.env["AUTH_TRUSTED_IP_HEADER"];
  else process.env["AUTH_TRUSTED_IP_HEADER"] = ORIGINAL_HEADER;
  if (ORIGINAL_PROXIES === undefined) delete process.env["AUTH_TRUSTED_PROXIES"];
  else process.env["AUTH_TRUSTED_PROXIES"] = ORIGINAL_PROXIES;
  vi.resetModules();
});

describe("AC4 -- the shared-bucket WARN no longer appears once configured", () => {
  test("AC4: fly-client-ip resolves under production once AUTH_TRUSTED_IP_HEADER is set -- no WARN condition", async () => {
    process.env["AUTH_TRUSTED_IP_HEADER"] = "fly-client-ip";
    const buildIpAddressConfig = await freshIpAddressConfig();
    const getIp = await freshProductionGetIp();

    const headers = new Headers({ "fly-client-ip": "198.51.100.77" });
    const ip = getIp(headers, { advanced: { ipAddress: buildIpAddressConfig() } });

    // Non-null is exactly the condition that skips the WARN in
    // resolveRateLimitConfig() (better-auth/dist/api/rate-limiter/index.mjs):
    // `if (!ip && !ipWarningLogged) { ctx.logger.warn(...) }`.
    expect(ip).toBe("198.51.100.77");
  });

  test("AC4: the same request resolves to nothing left unconfigured -- the bug this feature fixes", async () => {
    // AUTH_TRUSTED_IP_HEADER stays unset (beforeEach already deleted it) --
    // Better Auth's own out-of-box default only ever checks x-forwarded-for.
    const buildIpAddressConfig = await freshIpAddressConfig();
    const getIp = await freshProductionGetIp();

    const headers = new Headers({ "fly-client-ip": "198.51.100.77" });
    const ip = getIp(headers, { advanced: { ipAddress: buildIpAddressConfig() } });

    expect(ip).toBeNull();
    expect(buildIpAddressConfig()).toBeUndefined();
  });
});
