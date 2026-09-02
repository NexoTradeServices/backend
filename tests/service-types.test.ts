// Feature 1007 -- ServiceType catalog screen
//
// AC1  the owner sees the seeded catalog (Plumbing $250 / $180 among them);
//      Mike (ops) and Bob (contractor) get 403s from every endpoint
// AC2  the owner edits Plumbing's standard rate 180 -> 190 and saves; reload
//      shows it; the stored value is 19000 cents
// AC3  the multiplier alone is what changes -- nothing else is written when
//      only serviceLevelMultipliers.weekend is updated (the preview itself
//      is a frontend computation, never stored)
// AC4  the normal multiplier is locked at 1.0 server-side: whatever the
//      caller sends for `normal`, only 1.0 is ever stored
// AC5  the owner reorders Plumbing's prefilled options; the saved order is
//      what the API returns
// AC6  creating a new, genuinely unseeded trade succeeds and appears in the
//      list; creating "Plumbing" again is refused with the field error on
//      the name -- [IMPL] plan.md illustrates this with "Air conditioning",
//      but the base seed (src/db/seed/base.ts) already seeds that trade as
//      a placeholder row awaiting 1007 pricing, so the create-succeeds half
//      of this AC uses a genuinely new trade name instead; the duplicate
//      half still uses "Plumbing" exactly as written
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { serviceTypeRoutes } from "../src/service-types/routes.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerCalloutRate: 25_000,
    customerStandardRate: 18_000,
    serviceLevelMultipliers: { normal: 1.0, emergency: 1.5, weekend: 1.5 },
    prefilledFields: [],
    ...overrides,
  };
}

async function seedCast(): Promise<void> {
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/sign-in/email")
    .send({ email, password: DEV_PASSWORD });
  return cookieHeader(res);
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/service-types", serviceTypeRoutes(db));
});

beforeEach(async () => {
  await truncateAll(db);
});

describe("AC1 -- the seeded catalog, owner-only", () => {
  test("AC1: the owner sees Plumbing $250 / $180 among the seeded catalog", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app).get("/api/service-types").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const plumbing = (res.body as { trade: string; customerCalloutRate: number; customerStandardRate: number }[]).find(
      (row) => row.trade === "Plumbing",
    );
    expect(plumbing?.customerCalloutRate).toBe(25_000);
    expect(plumbing?.customerStandardRate).toBe(18_000);
  });

  test("AC1: Mike (ops) gets 403 from every endpoint", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const plumbing = await db.serviceType.findFirstOrThrow({ where: { trade: "Plumbing" } });

    expect((await request(app).get("/api/service-types").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).get(`/api/service-types/${plumbing.id}`).set("Cookie", cookie)).status).toBe(403);
    expect(
      (await request(app).put(`/api/service-types/${plumbing.id}`).set("Cookie", cookie).send(validBody())).status,
    ).toBe(403);
    expect(
      (await request(app).post("/api/service-types").set("Cookie", cookie).send({ trade: "Gas fitting", ...validBody() }))
        .status,
    ).toBe(403);
  });

  test("AC1: Bob (contractor) gets 403 from every endpoint", async () => {
    await seedCast();
    const cookie = await signInCookie("bob@idelta.com.au");
    const plumbing = await db.serviceType.findFirstOrThrow({ where: { trade: "Plumbing" } });

    expect((await request(app).get("/api/service-types").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).get(`/api/service-types/${plumbing.id}`).set("Cookie", cookie)).status).toBe(403);
    expect(
      (await request(app).put(`/api/service-types/${plumbing.id}`).set("Cookie", cookie).send(validBody())).status,
    ).toBe(403);
    expect(
      (await request(app).post("/api/service-types").set("Cookie", cookie).send({ trade: "Gas fitting", ...validBody() }))
        .status,
    ).toBe(403);
  });
});

describe("AC2 -- the owner edits a rate and saves", () => {
  test("AC2: Plumbing's standard rate 180 -> 190 saves as 19000 cents and reloads showing it", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const plumbing = await db.serviceType.findFirstOrThrow({ where: { trade: "Plumbing" } });

    const putRes = await request(app)
      .put(`/api/service-types/${plumbing.id}`)
      .set("Cookie", cookie)
      .send(validBody({ customerStandardRate: 19_000 }));
    expect(putRes.status).toBe(200);
    expect((putRes.body as { customerStandardRate: number }).customerStandardRate).toBe(19_000);

    const getRes = await request(app).get(`/api/service-types/${plumbing.id}`).set("Cookie", cookie);
    expect((getRes.body as { customerStandardRate: number }).customerStandardRate).toBe(19_000);

    const stored = await db.serviceType.findUniqueOrThrow({ where: { id: plumbing.id } });
    expect(stored.customerStandardRate).toBe(19_000);
  });
});

describe("AC3 -- only the multiplier is written", () => {
  test("AC3: saving a new weekend multiplier leaves the rates exactly as they were", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const plumbing = await db.serviceType.findFirstOrThrow({ where: { trade: "Plumbing" } });

    const res = await request(app)
      .put(`/api/service-types/${plumbing.id}`)
      .set("Cookie", cookie)
      .send(
        validBody({
          customerCalloutRate: plumbing.customerCalloutRate,
          customerStandardRate: plumbing.customerStandardRate,
          serviceLevelMultipliers: { normal: 1.0, emergency: 1.5, weekend: 1.25 },
        }),
      );
    expect(res.status).toBe(200);

    const stored = await db.serviceType.findUniqueOrThrow({ where: { id: plumbing.id } });
    expect(stored.customerCalloutRate).toBe(plumbing.customerCalloutRate);
    expect(stored.customerStandardRate).toBe(plumbing.customerStandardRate);
    expect(stored.serviceLevelMultipliers).toEqual({ normal: 1, emergency: 1.5, weekend: 1.25 });
  });
});

describe("AC4 -- the normal multiplier is locked at 1.0", () => {
  test("AC4: sending normal: 2 for the multiplier still stores normal: 1", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const plumbing = await db.serviceType.findFirstOrThrow({ where: { trade: "Plumbing" } });

    const res = await request(app)
      .put(`/api/service-types/${plumbing.id}`)
      .set("Cookie", cookie)
      .send(validBody({ serviceLevelMultipliers: { normal: 2, emergency: 1.5, weekend: 1.5 } }));
    expect(res.status).toBe(200);
    expect((res.body as { serviceLevelMultipliers: { normal: number } }).serviceLevelMultipliers.normal).toBe(1);

    const stored = await db.serviceType.findUniqueOrThrow({ where: { id: plumbing.id } });
    expect((stored.serviceLevelMultipliers as { normal: number }).normal).toBe(1);
  });
});

describe("AC5 -- prefilled options reorder", () => {
  test("AC5: the saved order of Plumbing's prefilled options is what the API returns", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const plumbing = await db.serviceType.findFirstOrThrow({ where: { trade: "Plumbing" } });

    const reordered = ["Blocked drain", "Leaking tap", "Hot water system"];
    const putRes = await request(app)
      .put(`/api/service-types/${plumbing.id}`)
      .set("Cookie", cookie)
      .send(validBody({ prefilledFields: reordered }));
    expect(putRes.status).toBe(200);
    expect((putRes.body as { prefilledFields: string[] }).prefilledFields).toEqual(reordered);

    const getRes = await request(app).get(`/api/service-types/${plumbing.id}`).set("Cookie", cookie);
    expect((getRes.body as { prefilledFields: string[] }).prefilledFields).toEqual(reordered);
  });
});

describe("AC6 -- add-a-trade, unique by name", () => {
  test("AC6: creating a genuinely new trade succeeds and appears in the list", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app)
      .post("/api/service-types")
      .set("Cookie", cookie)
      .send({ trade: "Gas fitting", ...validBody() });
    expect(res.status).toBe(201);
    expect((res.body as { trade: string }).trade).toBe("Gas fitting");

    const listRes = await request(app).get("/api/service-types").set("Cookie", cookie);
    expect((listRes.body as { trade: string }[]).some((row) => row.trade === "Gas fitting")).toBe(true);
  });

  test("AC6: creating 'Plumbing' again is refused with the field error on the name", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app)
      .post("/api/service-types")
      .set("Cookie", cookie)
      .send({ trade: "Plumbing", ...validBody() });
    expect(res.status).toBe(400);
    expect((res.body as { field?: string }).field).toBe("trade");

    const count = await db.serviceType.count({ where: { trade: "Plumbing" } });
    expect(count).toBe(1);
  });
});
