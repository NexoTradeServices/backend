// Feature 2002 -- service area builder
//
// AC2  GET /api/suburbs/in-range against synthetic suburbs at known
//      distances returns exactly the postcodes with a suburb within km,
//      nearest first, each with all its suburbs and its nearest distance;
//      a postcode with one suburb inside and one outside appears; km of 7,
//      0 or 65 is refused with 400; a logged-out call is 401.
//
// Synthetic Suburb rows (decision 14, 1002's "Test Gully 9001" shape):
// tests never load the licensed CSV. All rows sit on the pin's own
// longitude, offset purely in latitude, so the geodesic distance from the
// pin is (to well under a kilometre) `offsetKm`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { suburbRoutes } from "../src/suburbs/routes.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const PIN = { lat: -32.0, lng: 115.0 };
const KM_PER_DEGREE = 111.32;

function latAtKm(offsetKm: number): number {
  return PIN.lat - offsetKm / KM_PER_DEGREE;
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
  app.use("/api/suburbs", suburbRoutes(db));
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedAuthFixtures(db);

  await db.suburb.createMany({
    data: [
      { name: "Near One", slug: "near-one-zz-9001", postcode: "9001", state: "ZZ", centroidLat: latAtKm(5), centroidLng: PIN.lng },
      { name: "Near Two", slug: "near-two-zz-9001", postcode: "9001", state: "ZZ", centroidLat: latAtKm(8), centroidLng: PIN.lng },
      { name: "Mid Town", slug: "mid-town-zz-9002", postcode: "9002", state: "ZZ", centroidLat: latAtKm(15), centroidLng: PIN.lng },
      { name: "Edge Suburb In", slug: "edge-suburb-in-zz-9003", postcode: "9003", state: "ZZ", centroidLat: latAtKm(19), centroidLng: PIN.lng },
      // Same postcode as "Edge Suburb In", but far past the 20km radius the
      // main test asks for -- the postcode still carries both names.
      { name: "Edge Suburb Out", slug: "edge-suburb-out-zz-9003", postcode: "9003", state: "ZZ", centroidLat: PIN.lat + 25 / KM_PER_DEGREE, centroidLng: PIN.lng },
      { name: "Far Suburb", slug: "far-suburb-zz-9004", postcode: "9004", state: "ZZ", centroidLat: latAtKm(40), centroidLng: PIN.lng },
    ],
  });
});

describe("AC2 -- in-range postcodes, nearest first", () => {
  test("AC2: returns exactly the postcodes with a suburb within 20km, nearest first, each labelled with ALL its suburbs", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const res = await request(app)
      .get("/api/suburbs/in-range")
      .query({ lat: PIN.lat, lng: PIN.lng, km: 20 })
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    const body = res.body as { postcode: string; suburbs: string[]; nearestKm: number }[];
    expect(body.map((row) => row.postcode)).toEqual(["9001", "9002", "9003"]);

    const near = body.find((row) => row.postcode === "9001");
    expect(near?.suburbs).toEqual(["Near One", "Near Two"]);
    expect(near?.nearestKm).toBeCloseTo(5, 0);

    const mid = body.find((row) => row.postcode === "9002");
    expect(mid?.suburbs).toEqual(["Mid Town"]);
    expect(mid?.nearestKm).toBeCloseTo(15, 0);

    // AC2: a postcode with one suburb inside and one outside still appears,
    // carrying BOTH suburb names -- the postcode, not the suburb, is the unit.
    const edge = body.find((row) => row.postcode === "9003");
    expect(edge?.suburbs).toEqual(["Edge Suburb In", "Edge Suburb Out"]);
    expect(edge?.nearestKm).toBeCloseTo(19, 0);

    expect(body.some((row) => row.postcode === "9004")).toBe(false);
  });

  test("AC2: a wider radius picks up the previously-excluded postcode", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const res = await request(app)
      .get("/api/suburbs/in-range")
      .query({ lat: PIN.lat, lng: PIN.lng, km: 60 })
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    const body = res.body as { postcode: string }[];
    expect(body.map((row) => row.postcode)).toEqual(["9001", "9002", "9003", "9004"]);
  });
});

describe("AC2 -- validation and access", () => {
  test.each([7, 0, 65])("AC2: km=%i is refused with 400", async (km) => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const res = await request(app)
      .get("/api/suburbs/in-range")
      .query({ lat: PIN.lat, lng: PIN.lng, km })
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  test("AC2: a logged-out call is 401", async () => {
    const res = await request(app).get("/api/suburbs/in-range").query({ lat: PIN.lat, lng: PIN.lng, km: 20 });
    expect(res.status).toBe(401);
  });

  test("AC2: missing lat/lng is refused with 400", async () => {
    const cookie = await signInCookie("mike@idelta.com.au");
    const res = await request(app).get("/api/suburbs/in-range").query({ km: 20 }).set("Cookie", cookie);
    expect(res.status).toBe(400);
  });
});
