// Feature 2006 -- contractor agreement acceptance
//
// AC1   with no version published nobody is asked for the agreement
// AC8   Bob accepts version 1: the row, the mirror, the stamped record, the readiness item gone
// AC9   accept is refused for a stale version, a second accept, and any session but the contractor's
// AC10  publishing "2" reopens acceptance; the version 1 row stays; a second row follows
// AC11  the stamped record names the legal identity, Bob, the version, the moment in AWST, IP, device, SHA-256
// AC12  files open only through the backend, by role, with a short-lived address
// AC13  with Cloudinary down at accept the acceptance still saves; the first open afterwards makes the record
// (AC3-AC5 -- tests/settings.test.ts; AC6 -- tests/notifications-agreement-mail.test.ts;
//  AC7 -- contractor-dashboard, contractors and dispatch tests; AC14 -- tests/contractors.test.ts)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { fakeStorage, makePdf, pdfText, type FakeStorage } from "./helpers/agreements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { agreementRoutes } from "../src/agreements/routes.js";
import { cloudinaryAgreementStorage } from "../src/agreements/storage.js";
import { contractorDashboardRoutes } from "../src/contractors/dashboard-routes.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;
let storage: FakeStorage;

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  storage = fakeStorage();
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/contractor", contractorDashboardRoutes(db));
  app.use("/api", agreementRoutes(db, { storage: () => storage }));
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  storage.files.clear();
  storage.folders.length = 0;
  storage.opened.length = 0;
  storage.down = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["AUTH_TRUSTED_IP_HEADER"];
});

afterAll(async () => {
  await db.$disconnect();
});

async function signIn(addr: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: addr, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0] ?? "";
}

async function publish(version: string, note = version): Promise<request.Response> {
  const cookie = await signIn("owner@idelta.com.au");
  return request(app)
    .post(`/api/agreements?label=${encodeURIComponent(version)}`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/pdf")
    .send(await makePdf(note));
}

async function accept(cookie: string, versionId: string, headers: Record<string, string> = {}): Promise<request.Response> {
  return request(app).post("/api/contractor/agreement/accept").set("Cookie", cookie).set(headers).send({ versionId });
}

async function bobMissing(): Promise<string[]> {
  const res = await request(app).get("/api/contractor/dashboard").set("Cookie", await signIn("bob@idelta.com.au"));
  return (res.body as { missing: { key: string }[] }).missing.map((item) => item.key);
}

describe("AC1 -- nothing published, nothing asked", () => {
  test("AC1: no agreement readiness item for Bob, Dave or Priya, and Bob's page says nothing to accept", async () => {
    for (const addr of ["bob@idelta.com.au", "dave@idelta.com.au", "priya@idelta.com.au"]) {
      const res = await request(app).get("/api/contractor/dashboard").set("Cookie", await signIn(addr));
      const keys = (res.body as { missing: { key: string }[] }).missing.map((item) => item.key);
      expect(keys).not.toContain("agreement");
    }
    const page = await request(app).get("/api/contractor/agreement").set("Cookie", await signIn("bob@idelta.com.au"));
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ published: false, version: null, accepted: false });
  });
});

describe("AC8 / AC11 -- Bob accepts version 1", () => {
  test("AC8: the row, the mirror, the stamped record, the readiness item gone, the page reads accepted", async () => {
    const v1 = (await publish("1")).body as { id: string };
    expect(await bobMissing()).toContain("agreement");

    process.env["AUTH_TRUSTED_IP_HEADER"] = "x-forwarded-for";
    const cookie = await signIn("bob@idelta.com.au");
    const res = await accept(cookie, v1.id, { "X-Forwarded-For": "203.0.113.7", "User-Agent": "BobsPhone/1.0" });
    expect(res.status).toBe(201);

    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const row = await db.contractorAgreementAcceptance.findFirstOrThrow({ where: { contractorId: bob.id } });
    expect(row.acceptedFromIp).toBe("203.0.113.7");
    expect(row.userAgent).toBe("BobsPhone/1.0");
    expect(row.recordStorageKey).not.toBeNull();
    expect(storage.files.has(row.recordStorageKey ?? "")).toBe(true);
    expect(bob.agreementVersion).toBe("1");
    expect(bob.agreementAcceptedAt?.getTime()).toBe(row.acceptedAt.getTime());

    expect(await bobMissing()).not.toContain("agreement");
    const page = await request(app).get("/api/contractor/agreement").set("Cookie", cookie);
    expect(page.body).toMatchObject({ published: true, accepted: true, version: { label: "1" } });
    expect((page.body as { acceptedAt: string }).acceptedAt).toBe(row.acceptedAt.toISOString());
  });

  test("AC11: the stamped record names the legal entity, ABN, address, Bob, the version, the moment in AWST, IP, device and SHA-256", async () => {
    await db.platformSettings.updateMany({
      data: {
        legalEntityName: "Trade Services Pty Ltd",
        businessAbn: "51 824 753 556",
        businessAddress: { street: "1 Hay Street", suburb: "Perth", state: "WA", country: "Australia", postcode: "6000", lat: -31.95, lng: 115.86, placeId: null },
      },
    });
    const pdf = await makePdf("version one");
    const owner = await signIn("owner@idelta.com.au");
    const published = await request(app)
      .post("/api/agreements?label=1")
      .set("Cookie", owner)
      .set("Content-Type", "application/pdf")
      .send(pdf);
    const v1 = published.body as { id: string; issuedAt: string };
    process.env["AUTH_TRUSTED_IP_HEADER"] = "x-forwarded-for";
    await accept(await signIn("bob@idelta.com.au"), v1.id, { "X-Forwarded-For": "203.0.113.7", "User-Agent": "BobsPhone/1.0" });

    const row = await db.contractorAgreementAcceptance.findFirstOrThrow();
    const text = pdfText(storage.files.get(row.recordStorageKey ?? "") ?? new Uint8Array());
    expect(text).toContain("Trade Services Pty Ltd");
    expect(text).toContain("ABN 51 824 753 556");
    expect(text).toContain("1 Hay Street, Perth WA 6000, Australia");
    expect(text).toContain("Bob Reilly (CON-014)");
    expect(text).toMatch(/Version 1, issued \d{1,2} \w{3} \d{4}/);
    expect(text).toContain("AWST");
    expect(text).toContain("203.0.113.7");
    expect(text).toContain("BobsPhone/1.0");
    expect(text).toContain(createHash("sha256").update(pdf).digest("hex"));
  });
});

describe("AC9 -- who and what may accept", () => {
  test("AC9: a stale version, a second accept, and ops or the owner are all refused", async () => {
    const v1 = (await publish("1")).body as { id: string };
    await new Promise((r) => setTimeout(r, 5));
    const v2 = (await publish("2")).body as { id: string };
    const cookie = await signIn("bob@idelta.com.au");

    expect((await accept(cookie, v1.id)).status).toBe(409); // not the current version
    expect((await accept(cookie, v2.id)).status).toBe(201);
    expect((await accept(cookie, v2.id)).status).toBe(409); // already accepted

    for (const addr of ["mike@idelta.com.au", "owner@idelta.com.au"]) {
      expect((await accept(await signIn(addr), v2.id)).status).toBe(403);
    }
    expect((await request(app).post("/api/contractor/agreement/accept").send({ versionId: v2.id })).status).toBe(401);
    expect(await db.contractorAgreementAcceptance.count()).toBe(1);
  });
});

describe("AC10 -- a new version reopens acceptance", () => {
  test("AC10: publishing 2 makes Bob Not ready again; the version 1 row stays; accepting 2 adds a second row", async () => {
    const v1 = (await publish("1")).body as { id: string };
    const cookie = await signIn("bob@idelta.com.au");
    await accept(cookie, v1.id);
    expect(await bobMissing()).not.toContain("agreement");

    await new Promise((r) => setTimeout(r, 5));
    const v2 = (await publish("2")).body as { id: string };
    expect(await bobMissing()).toContain("agreement");
    expect(await db.contractorAgreementAcceptance.count()).toBe(1);

    await accept(cookie, v2.id);
    expect(await bobMissing()).not.toContain("agreement");
    const rows = await db.contractorAgreementAcceptance.findMany({ include: { agreementVersion: true } });
    expect(rows.map((r) => r.agreementVersion.version).sort()).toEqual(["1", "2"]);
    expect((await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } })).agreementVersion).toBe("2");
  });
});

describe("AC12 -- files open only through the backend", () => {
  test("AC12: a stamped record opens for Bob, Mike and the owner, and is refused to Dave and with no session", async () => {
    const v1 = (await publish("1")).body as { id: string };
    await accept(await signIn("bob@idelta.com.au"), v1.id);

    for (const addr of ["bob@idelta.com.au", "mike@idelta.com.au", "owner@idelta.com.au"]) {
      const res = await request(app).get("/api/agreements/records/CON-014").set("Cookie", await signIn(addr));
      expect(res.status).toBe(200);
      const { url, expiresAt } = res.body as { url: string; expiresAt: string };
      expect(url).toContain("https://files.test/");
      expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    }
    expect((await request(app).get("/api/agreements/records/CON-014").set("Cookie", await signIn("dave@idelta.com.au"))).status).toBe(403);
    expect((await request(app).get("/api/agreements/records/CON-014")).status).toBe(401);
  });

  test("AC12: an agreement version opens for the contractor (current, or one he accepted), Mike and the owner; refused with no session", async () => {
    const v1 = (await publish("1")).body as { id: string };
    await new Promise((r) => setTimeout(r, 5));
    const v2 = (await publish("2")).body as { id: string };
    const open = (id: string, cookie?: string): request.Test => {
      const req = request(app).get(`/api/agreements/${id}/file`);
      return cookie ? req.set("Cookie", cookie) : req;
    };

    const bob = await signIn("bob@idelta.com.au");
    expect((await open(v2.id, bob)).status).toBe(200); // current
    expect((await open(v1.id, bob)).status).toBe(403); // old and never accepted
    await accept(bob, v2.id);
    expect((await open(v2.id, bob)).status).toBe(200);
    expect((await open(v1.id, await signIn("mike@idelta.com.au"))).status).toBe(200);
    expect((await open(v1.id, await signIn("owner@idelta.com.au"))).status).toBe(200);
    expect((await open(v2.id)).status).toBe(401);
  });

  test("AC12: the real store keeps files private in tradeservice/agreements and hands out an address that expires within minutes", async () => {
    const calls: { url: string; body: FormData }[] = [];
    vi.stubGlobal("fetch", (url: string, init: { body: FormData }) => {
      calls.push({ url, body: init.body });
      return Promise.resolve(new Response(JSON.stringify({ public_id: "tradeservice/agreements/x.pdf" }), { status: 200 }));
    });
    const real = cloudinaryAgreementStorage({ cloudName: "demo", apiKey: "k", apiSecret: "s", uploadPreset: "p" });
    const key = await real?.upload("tradeservice/agreements", new Uint8Array([1, 2, 3]));
    expect(key).toBe("tradeservice/agreements/x.pdf");
    const upload = calls[0];
    expect(upload?.url).toBe("https://api.cloudinary.com/v1_1/demo/raw/upload");
    expect(upload?.body.get("type")).toBe("private");
    expect(upload?.body.get("public_id") as string).toMatch(/^tradeservice\/agreements\//);
    expect(upload?.body.get("upload_preset")).toBeNull();

    const now = new Date("2026-10-06T00:00:00Z");
    const opened = real?.signedUrl("tradeservice/agreements/x.pdf", now);
    expect(opened?.expiresAt.getTime()).toBe(now.getTime() + 120_000);
    const query = new URL(opened?.url ?? "").searchParams;
    expect(query.get("type")).toBe("private");
    expect(query.get("signature")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("AC13 -- Cloudinary down at acceptance", () => {
  test("AC13: the acceptance saves with no record key; the first open afterwards makes and stores it", async () => {
    const v1 = (await publish("1")).body as { id: string };
    storage.down = true;
    const cookie = await signIn("bob@idelta.com.au");
    expect((await accept(cookie, v1.id)).status).toBe(201);

    const row = await db.contractorAgreementAcceptance.findFirstOrThrow();
    expect(row.recordStorageKey).toBeNull();
    expect((await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } })).agreementVersion).toBe("1");

    // still down: a plain try-again
    expect((await request(app).get("/api/agreements/records/CON-014").set("Cookie", cookie)).status).toBe(503);

    storage.down = false;
    const open = await request(app).get("/api/agreements/records/CON-014").set("Cookie", cookie);
    expect(open.status).toBe(200);
    const after = await db.contractorAgreementAcceptance.findFirstOrThrow();
    expect(after.recordStorageKey).not.toBeNull();
    expect(storage.files.has(after.recordStorageKey ?? "")).toBe(true);
  });
});
