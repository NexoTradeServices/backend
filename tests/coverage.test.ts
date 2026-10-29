// Feature 3002 -- coverage tiers at the pick (the derivation and the public check)
//
// AC1  Hilton 6163 (on Bob's list) is covered
// AC2  Rottnest Island 6161 (nobody lists it, Bob's core is inside reach) is near-miss
// AC3  Joondalup 6027 is out of reach
// AC6  GET /api/enquiries/coverage answers a { suburbId } pick as well as a Places pick
// AC8  the public check answers the tier only; bad input is 400, an unknown suburbId 404;
//      no login needed
// AC10 only active contractors count: with Bob suspended Hilton is no longer covered
// AC12 raising serviceReachKm turns an out-of-reach point into a near-miss, nothing stored
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { coverageFor, coverageOf } from "../src/coverage/tier.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;

const HILTON = { postcode: "6163", lat: -32.0872, lng: 115.7913 };
const ROTTNEST = { postcode: "6161", lat: -32.0072, lng: 115.5413 };
const JOONDALUP = { postcode: "6027", lat: -31.7448, lng: 115.7661 };
const FREMANTLE = { postcode: "6160", lat: -32.0569, lng: 115.7439 };

beforeAll(() => {
  db = testClient();
  app = express();
  app.use(express.json());
  app.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("the derivation", () => {
  test("AC1/AC2/AC3: covered, near-miss and out of reach, with the distance past the list", async () => {
    const [hilton, rottnest, joondalup] = await coverageFor(db, [HILTON, ROTTNEST, JOONDALUP]);
    expect(hilton).toEqual({ tier: "covered", nearestKm: null });
    expect(rottnest?.tier).toBe("near_miss");
    expect(rottnest?.nearestKm).toBeGreaterThan(10);
    expect(rottnest?.nearestKm).toBeLessThanOrEqual(25);
    expect(joondalup?.tier).toBe("out_of_reach");
    expect(joondalup?.nearestKm).toBeGreaterThan(25);
  });

  test("the batch form answers in the order asked", async () => {
    const tiers = (await coverageFor(db, [JOONDALUP, HILTON, ROTTNEST])).map((c) => c.tier);
    expect(tiers).toEqual(["out_of_reach", "covered", "near_miss"]);
    expect(await coverageFor(db, [])).toEqual([]);
  });

  test("near-miss just inside reach, out of reach just past it", async () => {
    const point = ROTTNEST;
    const { nearestKm } = await coverageOf(db, point);
    expect(nearestKm).not.toBeNull();
    await db.platformSettings.updateMany({ data: { serviceReachKm: (nearestKm ?? 0) + 0.5 } });
    expect((await coverageOf(db, point)).tier).toBe("near_miss");
    await db.platformSettings.updateMany({ data: { serviceReachKm: (nearestKm ?? 0) - 0.5 } });
    expect((await coverageOf(db, point)).tier).toBe("out_of_reach");
  });

  test("AC12: raising serviceReachKm turns out of reach into near-miss without touching any job", async () => {
    const before = await coverageOf(db, JOONDALUP);
    expect(before.tier).toBe("out_of_reach");
    await db.platformSettings.updateMany({ data: { serviceReachKm: Math.ceil(before.nearestKm ?? 0) + 1 } });
    expect((await coverageOf(db, JOONDALUP)).tier).toBe("near_miss");
  });

  test("AC10: a suspended contractor counts for neither check", async () => {
    // Dave (Victoria Park) lists 6163 too, so Bob alone suspended leaves Hilton covered by Dave
    // (a logged deviation: the plan's AC10 named Bob only). Suspend both and nothing is left.
    await db.contractor.updateMany({ where: { code: "CON-014" }, data: { status: "suspended" } });
    expect((await coverageOf(db, HILTON)).tier).toBe("covered");
    expect((await coverageOf(db, ROTTNEST)).tier).toBe("out_of_reach");
    await db.contractor.updateMany({ data: { status: "suspended" } });
    expect(await coverageOf(db, HILTON)).toEqual({ tier: "out_of_reach", nearestKm: null });
    expect(await coverageOf(db, ROTTNEST)).toEqual({ tier: "out_of_reach", nearestKm: null });
  });

  test("trade-blind: another trade's served postcode covers the point", async () => {
    // Dave is an electrician; a postcode only he lists covers a plumbing enquiry too.
    await db.contractorServedPostcode.deleteMany({ where: { postcode: "6153", contractor: { code: "CON-014" } } });
    const dave = await db.contractor.findFirstOrThrow({ where: { code: "CON-021" } });
    await db.contractorServedPostcode.upsert({
      where: { contractorId_postcode: { contractorId: dave.id, postcode: "6153" } },
      update: {},
      create: { contractorId: dave.id, postcode: "6153" },
    });
    expect((await coverageOf(db, { postcode: "6153", lat: -32.0149, lng: 115.8332 })).tier).toBe("covered");
  });

  test("a point with no active core anywhere is out of reach with no distance", async () => {
    await db.contractorServedPostcode.deleteMany({});
    await db.contractor.updateMany({ data: { coreLocation: undefined, status: "active" } });
    await db.$executeRaw`UPDATE "Contractor" SET "coreLocation" = NULL`;
    expect(await coverageOf(db, FREMANTLE)).toEqual({ tier: "out_of_reach", nearestKm: null });
  });
});

describe("GET /api/enquiries/coverage", () => {
  test("AC8: a Places-shaped pick answers the tier only, with no login", async () => {
    const res = await request(app).get("/api/enquiries/coverage").query(JOONDALUP);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tier: "out_of_reach" });
  });

  test("AC1/AC2: covered and near-miss are answered the same way", async () => {
    expect((await request(app).get("/api/enquiries/coverage").query(HILTON)).body).toEqual({ tier: "covered" });
    expect((await request(app).get("/api/enquiries/coverage").query(ROTTNEST)).body).toEqual({ tier: "near_miss" });
  });

  test("AC6: a platform-suburb pick (suburbId) gets the same check", async () => {
    const suburb = await db.suburb.create({
      data: {
        name: "Joondalup Test",
        slug: "joondalup-test-6027-wa",
        postcode: "6027",
        state: "WA",
        centroidLat: JOONDALUP.lat,
        centroidLng: JOONDALUP.lng,
      },
    });
    const res = await request(app).get("/api/enquiries/coverage").query({ suburbId: suburb.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tier: "out_of_reach" });
  });

  test("AC8: missing or non-numeric input is 400; an unknown suburbId is 404", async () => {
    expect((await request(app).get("/api/enquiries/coverage")).status).toBe(400);
    expect((await request(app).get("/api/enquiries/coverage").query({ postcode: "6027", lat: "x", lng: "1" })).status).toBe(400);
    expect((await request(app).get("/api/enquiries/coverage").query({ postcode: "6027", lat: "-31.7" })).status).toBe(400);
    const missing = await request(app).get("/api/enquiries/coverage").query({ suburbId: "00000000-0000-7000-8000-000000000000" });
    expect(missing.status).toBe(404);
  });
});
