// Feature 2002 -- service area builder
//
// AC3  Mike picks a suburb, keeps the radius, crosses one postcode off and
//      saves: coreLocation is the suburb-only Places shape, lastRadiusKm
//      stored, served rows are exactly the in-range set minus the crossed one
// AC4  reopening derives the crossed-off state from the saved pin+radius
//      (no crossed-off row is ever stored); widening the radius brings a new
//      postcode in kept and leaves the old cross-off alone; Save stores both
// AC5  moving the pin leaves every previously-served postcode outside the new
//      radius, kept -- Save keeps them; "cross off everything outside" then
//      Save drops exactly those, keeping whatever is newly in range
// AC6  refused, nothing written: no pin; nothing kept; a postcode neither in
//      range nor already served; a coreLocation carrying a street; a radius
//      not on the 5km ladder
// AC7  the contractor's own door: self only, never another contractor's;
//      the ops door refuses a contractor role outright
// AC9  the fixture seed's service-area shape (decision 13)
//
// Synthetic Suburb rows throughout (decision 14) -- tests never load the
// licensed CSV.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { contractorRoutes } from "../src/contractors/routes.js";
import { contractorServiceAreaRoutes } from "../src/contractors/service-area-routes.js";
import { suburbRoutes } from "../src/suburbs/routes.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const KM_PER_DEGREE = 111.32;
const OLD_PIN = { lat: -10.0, lng: 140.0 };
// ~110km east of OLD_PIN at this latitude -- everything near OLD_PIN sits
// far outside any radius this suite tests from NEW_PIN.
const NEW_PIN = { lat: -10.0, lng: 141.0 };

function latOffset(pin: { lat: number }, km: number): number {
  return pin.lat - km / KM_PER_DEGREE;
}

interface ServiceAreaBody {
  coreLocation: unknown;
  radiusKm: number;
  postcodes: string[];
}

interface ErrorBody {
  error: string;
  field?: string;
}

function areaBody(res: request.Response): ServiceAreaBody {
  return res.body as ServiceAreaBody;
}

function errorBody(res: request.Response): ErrorBody {
  return res.body as ErrorBody;
}

function suburbPin(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    suburb: "Alpha",
    state: "ZZ",
    country: "AU",
    postcode: "7001",
    lat: OLD_PIN.lat,
    lng: OLD_PIN.lng,
    placeId: "fixture-place-alpha",
    ...overrides,
  };
}

async function seedCast(): Promise<void> {
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
}

async function signInCookie(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/contractors", contractorRoutes(db, auth));
  app.use("/api/contractor", contractorServiceAreaRoutes(db));
  app.use("/api/suburbs", suburbRoutes(db));
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await seedCast();

  await db.suburb.createMany({
    data: [
      // Near OLD_PIN.
      { name: "Alpha", slug: "alpha-zz-7001", postcode: "7001", state: "ZZ", centroidLat: latOffset(OLD_PIN, 5), centroidLng: OLD_PIN.lng },
      { name: "Beta", slug: "beta-zz-7002", postcode: "7002", state: "ZZ", centroidLat: latOffset(OLD_PIN, 20), centroidLng: OLD_PIN.lng },
      { name: "Gamma", slug: "gamma-zz-7003", postcode: "7003", state: "ZZ", centroidLat: latOffset(OLD_PIN, 29), centroidLng: OLD_PIN.lng },
      // 35km from OLD_PIN: outside a 30km radius, inside a 40km one.
      { name: "Delta", slug: "delta-zz-7004", postcode: "7004", state: "ZZ", centroidLat: latOffset(OLD_PIN, 35), centroidLng: OLD_PIN.lng },
      // Genuinely far from both pins -- always out of range, never served.
      { name: "FarAway", slug: "faraway-zz-7099", postcode: "7099", state: "ZZ", centroidLat: latOffset(OLD_PIN, 300), centroidLng: OLD_PIN.lng },
      // Near NEW_PIN only.
      { name: "Epsilon", slug: "epsilon-zz-7005", postcode: "7005", state: "ZZ", centroidLat: latOffset(NEW_PIN, 10), centroidLng: NEW_PIN.lng },
    ],
  });
});

describe("AC3-AC5 -- save, reopen, widen the radius, move the pin", () => {
  test("the pin/radius/postcode lifecycle, one contractor throughout", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");

    // AC3: keep 30km, cross off Gamma (7003) -- served = Alpha + Beta only.
    const save1 = await request(app)
      .put("/api/contractors/CON-030/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: suburbPin(), radiusKm: 30, postcodes: ["7001", "7002"] });
    expect(save1.status).toBe(200);
    expect(areaBody(save1).coreLocation).toMatchObject(suburbPin());
    expect(areaBody(save1).radiusKm).toBe(30);
    expect(areaBody(save1).postcodes.sort()).toEqual(["7001", "7002"]);

    const priya = await db.contractor.findUniqueOrThrow({ where: { code: "CON-030" } });
    expect(priya.coreLocation).toMatchObject({ suburb: "Alpha", postcode: "7001" });
    expect(priya.lastRadiusKm).toBe(30);
    const served1 = await db.contractorServedPostcode.findMany({ where: { contractorId: priya.id } });
    expect(served1.map((r) => r.postcode).sort()).toEqual(["7001", "7002"]);

    // AC4: reopening -- the in-range set at the SAVED pin+radius is Alpha,
    // Beta, Gamma; Gamma has no served row, so it reads crossed off. Nothing
    // is ever stored for "crossed" -- it is derived from these two reads.
    const reopen = await request(app).get("/api/contractors/CON-030/service-area").set("Cookie", cookie);
    expect(areaBody(reopen).postcodes.sort()).toEqual(["7001", "7002"]);
    const rangeAt30 = await request(app)
      .get("/api/suburbs/in-range")
      .query({ lat: OLD_PIN.lat, lng: OLD_PIN.lng, km: 30 })
      .set("Cookie", cookie);
    const inRange30 = (rangeAt30.body as { postcode: string }[]).map((r) => r.postcode);
    expect(inRange30.sort()).toEqual(["7001", "7002", "7003"]);
    const crossedOnReopen = inRange30.filter((pc) => !areaBody(reopen).postcodes.includes(pc));
    expect(crossedOnReopen).toEqual(["7003"]);

    // AC4 continued: widen to 40km -- Delta (7004) enters range, arrives
    // kept by default; Gamma stays crossed. Save stores 40 and the new set.
    const rangeAt40 = await request(app)
      .get("/api/suburbs/in-range")
      .query({ lat: OLD_PIN.lat, lng: OLD_PIN.lng, km: 40 })
      .set("Cookie", cookie);
    expect((rangeAt40.body as { postcode: string }[]).map((r) => r.postcode).sort()).toEqual([
      "7001", "7002", "7003", "7004",
    ]);
    const save2 = await request(app)
      .put("/api/contractors/CON-030/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: suburbPin(), radiusKm: 40, postcodes: ["7001", "7002", "7004"] });
    expect(save2.status).toBe(200);
    expect(areaBody(save2).radiusKm).toBe(40);
    expect(areaBody(save2).postcodes.sort()).toEqual(["7001", "7002", "7004"]);

    // AC5: move the pin far away. Every previously-served postcode
    // (7001/7002/7004) is now outside the new 30km radius -- Save still
    // keeps them (the "already served" exception), alongside Epsilon (7005),
    // freshly in range of the new pin.
    const newPin = suburbPin({ suburb: "Epsilon", postcode: "7005", lat: NEW_PIN.lat, lng: NEW_PIN.lng, placeId: "fixture-place-epsilon" });
    const save3 = await request(app)
      .put("/api/contractors/CON-030/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: newPin, radiusKm: 30, postcodes: ["7001", "7002", "7004", "7005"] });
    expect(save3.status).toBe(200);
    expect(areaBody(save3).postcodes.sort()).toEqual(["7001", "7002", "7004", "7005"]);

    // "Cross off everything outside the radius" then Save drops exactly the
    // three now-outside postcodes, keeping Epsilon.
    const save4 = await request(app)
      .put("/api/contractors/CON-030/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: newPin, radiusKm: 30, postcodes: ["7005"] });
    expect(save4.status).toBe(200);
    expect(areaBody(save4).postcodes).toEqual(["7005"]);
  });
});

describe("AC6 -- refused, nothing written", () => {
  async function currentState(cookie: string): Promise<ServiceAreaBody> {
    const res = await request(app).get("/api/contractors/CON-021/service-area").set("Cookie", cookie);
    return areaBody(res);
  }

  test("AC6: no pin is refused with a field error, nothing written", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await currentState(cookie);
    const res = await request(app)
      .put("/api/contractors/CON-021/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: null, radiusKm: 30, postcodes: ["7001"] });
    expect(res.status).toBe(400);
    expect(errorBody(res).field).toBe("coreLocation");
    expect(await currentState(cookie)).toEqual(before);
  });

  test("AC6: nothing kept is refused, nothing written", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await currentState(cookie);
    const res = await request(app)
      .put("/api/contractors/CON-021/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: suburbPin(), radiusKm: 30, postcodes: [] });
    expect(res.status).toBe(400);
    expect(errorBody(res).field).toBe("postcodes");
    expect(await currentState(cookie)).toEqual(before);
  });

  test("AC6: a postcode neither in range nor already served is refused, nothing written", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await currentState(cookie);
    const res = await request(app)
      .put("/api/contractors/CON-021/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: suburbPin(), radiusKm: 30, postcodes: ["7001", "7099"] });
    expect(res.status).toBe(400);
    expect(errorBody(res).field).toBe("postcodes");
    expect(await currentState(cookie)).toEqual(before);
  });

  test("AC6: a coreLocation carrying a street is refused, nothing written", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await currentState(cookie);
    const res = await request(app)
      .put("/api/contractors/CON-021/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: suburbPin({ street: "12 Main Street" }), radiusKm: 30, postcodes: ["7001"] });
    expect(res.status).toBe(400);
    expect(errorBody(res).field).toBe("coreLocation");
    expect(await currentState(cookie)).toEqual(before);
  });

  test("AC6: radiusKm off the 5km ladder is refused, nothing written", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await currentState(cookie);
    const res = await request(app)
      .put("/api/contractors/CON-021/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: suburbPin(), radiusKm: 33, postcodes: ["7001"] });
    expect(res.status).toBe(400);
    expect(errorBody(res).field).toBe("radiusKm");
    expect(await currentState(cookie)).toEqual(before);
  });
});

describe("AC7 -- the contractor's own door", () => {
  test("AC7: Bob sees and saves his own area through /api/contractor/service-area", async () => {
    const cookie = await signInCookie("bob@idelta.com.au");
    const get = await request(app).get("/api/contractor/service-area").set("Cookie", cookie);
    expect(get.status).toBe(200);
    expect(areaBody(get).coreLocation).toMatchObject({ suburb: "Fremantle", postcode: "6160" });
    expect(areaBody(get).radiusKm).toBe(30);
    expect(areaBody(get).postcodes).toContain("6163");
    expect(areaBody(get).postcodes).not.toContain("6027");
    expect(areaBody(get).postcodes).not.toContain("6161");

    // Crosses off one postcode he already serves -- an "already served"
    // subset needs no in-range Suburb rows at all to succeed.
    const withoutOne = areaBody(get).postcodes.filter((pc) => pc !== "6167");
    const put = await request(app)
      .put("/api/contractor/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: areaBody(get).coreLocation, radiusKm: 30, postcodes: withoutOne });
    expect(put.status).toBe(200);
    expect(areaBody(put).postcodes).not.toContain("6167");
  });

  test("AC7: Priya sees her own (empty) area, never Bob's", async () => {
    const cookie = await signInCookie("priya@idelta.com.au");
    const res = await request(app).get("/api/contractor/service-area").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(areaBody(res).coreLocation).toBeNull();
    expect(areaBody(res).postcodes).toEqual([]);
  });

  test("AC7: Bob at the ops door gets 403 from GET and PUT alike", async () => {
    const cookie = await signInCookie("bob@idelta.com.au");
    const getRes = await request(app).get("/api/contractors/CON-014/service-area").set("Cookie", cookie);
    expect(getRes.status).toBe(403);
    const putRes = await request(app)
      .put("/api/contractors/CON-014/service-area")
      .set("Cookie", cookie)
      .send({ coreLocation: suburbPin(), radiusKm: 30, postcodes: ["7001"] });
    expect(putRes.status).toBe(403);
  });

  test("AC7: a logged-out call to the contractor door is 401", async () => {
    const res = await request(app).get("/api/contractor/service-area");
    expect(res.status).toBe(401);
  });
});

describe("AC9 -- the fixture seed's service-area shape", () => {
  test("AC9: Bob carries the fixed served list; Priya carries no area at all", async () => {
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { servedPostcodes: true } });
    expect(bob.coreLocation).toMatchObject({ suburb: "Fremantle", postcode: "6160", state: "WA" });
    expect(bob.lastRadiusKm).toBe(30);
    const bobPostcodes = bob.servedPostcodes.map((r) => r.postcode);
    expect(bobPostcodes).toContain("6163");
    expect(bobPostcodes).not.toContain("6027");
    expect(bobPostcodes).not.toContain("6161");

    const priya = await db.contractor.findUniqueOrThrow({ where: { code: "CON-030" }, include: { servedPostcodes: true } });
    expect(priya.coreLocation).toBeNull();
    expect(priya.lastRadiusKm).toBeNull();
    expect(priya.servedPostcodes).toHaveLength(0);
  });

  // Feature 4002, plan decision 16 (AC36): Dave now carries his own area --
  // Victoria Park, 25km -- written by the fixture seed once he has none.
  test("AC36 (4002): Dave carries Victoria Park, 25km, including 6153/6163/6076 but never 6027", async () => {
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" }, include: { servedPostcodes: true } });
    expect(dave.coreLocation).toMatchObject({ suburb: "Victoria Park", postcode: "6100", state: "WA" });
    expect(dave.lastRadiusKm).toBe(25);
    const davePostcodes = dave.servedPostcodes.map((r) => r.postcode);
    expect(davePostcodes).toContain("6153");
    expect(davePostcodes).toContain("6163");
    expect(davePostcodes).toContain("6076");
    expect(davePostcodes).not.toContain("6027");
  });
});
