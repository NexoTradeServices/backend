// Feature 1013 -- auth rate limiting sees real client IPs
//
// AC1  a hammered IP is refused while Bob, from a different IP at the same
//      moment, logs in normally -- separate buckets
// AC2  the hammering IP actually receives a 429 once past the threshold
//      (Better Auth's own default for /sign-in*: window 10s, max 3), and it
//      engages exactly at the boundary, not before
// AC3  the spoof test -- a forwarded IP is honoured when the chain's nearest
//      hop is the configured trusted proxy, and an attacker cannot borrow
//      another IP's bucket by merely prepending a claim in front of a hop
//      that ISN'T the trusted one
//
// Rate-limit counters live in a module-level in-memory Map inside Better
// Auth itself (dist/api/rate-limiter/index.mjs), shared by every `betterAuth()`
// instance in this process -- so every IP literal below is unique to its own
// test to keep buckets from bleeding across tests.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import type { PrismaClient } from "../src/db/client.js";

// A made-up, RFC 5737 documentation address standing in for Caddy on .41 --
// never a real routable address, so it can never collide with a real request.
const TEST_PROXY_IP = "203.0.113.1";

let db: PrismaClient;
let auth: Auth;
let app: Express;

// Saved/restored in afterAll -- review R1.1: this file is the only
// env-mutating test in the suite that didn't, unlike its own sibling
// auth-rate-limit-warn.test.ts and the pre-existing notifications-*
// env-mutating files.
const ORIGINAL_HEADER = process.env["AUTH_TRUSTED_IP_HEADER"];
const ORIGINAL_PROXIES = process.env["AUTH_TRUSTED_PROXIES"];

beforeAll(() => {
  process.env["AUTH_TRUSTED_IP_HEADER"] = "x-forwarded-for";
  process.env["AUTH_TRUSTED_PROXIES"] = TEST_PROXY_IP;

  db = testClient();
  auth = buildAuth({ client: db, rateLimit: { enabled: true } });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  if (ORIGINAL_HEADER === undefined) delete process.env["AUTH_TRUSTED_IP_HEADER"];
  else process.env["AUTH_TRUSTED_IP_HEADER"] = ORIGINAL_HEADER;
  if (ORIGINAL_PROXIES === undefined) delete process.env["AUTH_TRUSTED_PROXIES"];
  else process.env["AUTH_TRUSTED_PROXIES"] = ORIGINAL_PROXIES;
  await db.$disconnect();
});

/** The header shape a request that actually arrived via the trusted hop carries. */
function viaTrustedHop(claimedIp: string): string {
  return `${claimedIp}, ${TEST_PROXY_IP}`;
}

async function signInAs(ip: string, email: string, password: string): Promise<request.Response> {
  return request(app)
    .post("/api/auth/sign-in/email")
    .set("X-Forwarded-For", ip)
    .send({ email, password });
}

describe("AC1 -- separate buckets per IP", () => {
  test("AC1: a hammered IP is refused while Bob, a different IP, logs in normally", async () => {
    await seedBase(db);
    await seedFixtures(db);
    await seedAuthFixtures(db);

    const attackerIp = viaTrustedHop("198.51.100.10");
    const bobIp = viaTrustedHop("198.51.100.20");

    // Better Auth's default for /sign-in*: window 10s, max 3 -- three wrong
    // guesses are let through, the fourth is refused.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await request(app)
        .post("/api/auth/sign-in/email")
        .set("X-Forwarded-For", attackerIp)
        .send({ email: "bob@idelta.com.au", password: "not-the-right-password" });
      expect(res.status).not.toBe(429);
    }
    const fourth = await request(app)
      .post("/api/auth/sign-in/email")
      .set("X-Forwarded-For", attackerIp)
      .send({ email: "bob@idelta.com.au", password: "not-the-right-password" });
    expect(fourth.status).toBe(429);

    // Bob, from a genuinely different IP, logs in normally at the same moment.
    const bobLogin = await request(app)
      .post("/api/auth/sign-in/email")
      .set("X-Forwarded-For", bobIp)
      .send({ email: "bob@idelta.com.au", password: DEV_PASSWORD });
    expect(bobLogin.status).toBe(200);
  });
});

describe("AC2 -- the protection actually engages, per IP, at the threshold", () => {
  test("AC2: three attempts pass, the fourth is a real 429, and it is IP-scoped", async () => {
    const hammered = viaTrustedHop("198.51.100.30");
    const bystander = viaTrustedHop("198.51.100.31");

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await signInAs(hammered, "nobody@example.com", "whatever");
      expect(res.status).not.toBe(429);
    }
    const refused = await signInAs(hammered, "nobody@example.com", "whatever");
    expect(refused.status).toBe(429);
    // Better Auth answers a rate-limited request as plain text, not JSON.
    expect(refused.text).toMatch(/too many requests/i);
    expect(refused.headers["x-retry-after"]).toBeDefined();

    // A different IP, hit right after, is not caught in the same bucket.
    const untouched = await signInAs(bystander, "nobody@example.com", "whatever");
    expect(untouched.status).not.toBe(429);
  });
});

describe("AC3 -- the spoof test", () => {
  test("AC3: a forwarded IP is honoured when it actually arrived via the trusted hop", async () => {
    const claimedIp = "198.51.100.40";
    const header = viaTrustedHop(claimedIp);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await signInAs(header, "nobody@example.com", "whatever");
      expect(res.status).not.toBe(429);
    }
    const fourth = await signInAs(header, "nobody@example.com", "whatever");
    expect(fourth.status).toBe(429);
  });

  test("AC3: prepending someone else's IP in front of an UNTRUSTED hop never borrows their bucket", async () => {
    const bobsRealIp = "198.51.100.41";
    const bobsOwnBucket = viaTrustedHop(bobsRealIp);

    // The attacker's own connection isn't the trusted proxy at all -- just
    // some other address -- so decision 2 says this claim is never honoured.
    const attackerNotViaTrustedHop = `${bobsRealIp}, 192.0.2.50`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await signInAs(attackerNotViaTrustedHop, "nobody@example.com", "whatever");
      expect(res.status).not.toBe(429);
    }
    const fourthFromAttacker = await signInAs(attackerNotViaTrustedHop, "nobody@example.com", "whatever");
    expect(fourthFromAttacker.status).toBe(429);

    // Bob's own, genuinely-trusted-hop request is in a completely different
    // bucket -- the attacker's spoofed claim never touched it.
    const bobsRequest = await signInAs(bobsOwnBucket, "nobody@example.com", "whatever");
    expect(bobsRequest.status).not.toBe(429);
  });

  // Discovery, not a defect of this feature: a single, un-chained
  // X-Forwarded-For value is trusted at face value by Better Auth's own
  // trustedProxies algorithm regardless of who actually connected (see
  // node_modules/@better-auth/core/src/utils/ip.ts, getIPFromHeader -- the
  // single-value branch never checks trustedProxies membership at all). That
  // is only exploitable by a caller who can reach this backend directly,
  // bypassing Caddy -- and project/setup/01-dev-environment.md records .40 as
  // having no host firewall. Recorded in change.md Discoveries for the
  // architect/owner; not fixable inside this feature's scope (Better Auth's
  // advanced ipAddress config, not a firewall rule).
  test.todo(
    "discovery: a direct connection to :8080 bypassing Caddy can spoof a single-value X-Forwarded-For -- see change.md Discoveries",
  );
});
