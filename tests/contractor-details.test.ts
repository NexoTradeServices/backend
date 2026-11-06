// Feature 2005 -- contractor My details
//
// AC2  Bob edits his name, phone, business name, address and emergency contact and they hold; a blank name is refused
// AC3  everything else is read-only, on the screen and by sending it (email, ABN, GST, the bank details, trades,
//      insurance, status, Operating state); another contractor's details cannot be read
// AC4  a new address must be in Bob's Operating state (the rule 1021 gave Mike's form); an address already on file stays;
//      Bob's Operating state and service area do not change
// AC5  the bank details are the office's: Bob cannot change them; when Mike replaces them the contractor and the office
//      are emailed with no numbers and the change is stamped (tests/contractors.test.ts)
// AC6  a first entry by Mike sends nothing (tests/contractors.test.ts)
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
import { contractorDetailsRoutes } from "../src/contractors/details-routes.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email, password: DEV_PASSWORD });
  return cookieHeader(res);
}

const details = (cookie: string) => request(app).get("/api/contractor/details").set("Cookie", cookie);
const save = (cookie: string, body: Record<string, unknown>) => request(app).put("/api/contractor/details").set("Cookie", cookie).send(body);

const PERTH_HOME = { street: "9 Rokeby Road", suburb: "Subiaco", state: "WA", country: "AU", postcode: "6008", lat: -31.95, lng: 115.82, placeId: "p-subiaco-home" };
const SYDNEY = { street: "30 King Street", suburb: "Newtown", state: "NSW", country: "AU", postcode: "2042", lat: -33.897, lng: 151.179, placeId: "p-newtown" };

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/contractor", contractorDetailsRoutes(db));
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
});

describe("AC2, AC3 -- the page reads and writes only what is Bob's", () => {
  test("AC3: the page carries Bob's own fields and, apart, the office's facts (the bank details locked); Dave's details cannot be asked for", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const body = (await details(bob)).body as { own: Record<string, unknown>; office: Record<string, unknown> };
    expect(Object.keys(body.own).sort()).toEqual(["address", "businessName", "emergencyContactName", "emergencyContactPhone", "name", "phone"]);
    expect(body.office).toMatchObject({ code: "CON-014", operatingState: "WA", status: "active", payoutBsb: "066-000", payoutAccountNo: "12345678", payoutAccountName: "B Reilly" });
    expect((body.office["specialties"] as { trade: string }[]).map((s) => s.trade)).toEqual(["Plumbing"]);
    // There is no code in the door: the session decides whose details come back.
    const asked = (await request(app).get("/api/contractor/details?code=CON-021").set("Cookie", bob)).body as { office: { code: string } };
    expect(asked.office.code).toBe("CON-014");
    // Mike has no contractor record, so the door is not his.
    expect((await details(await signInCookie("mike@idelta.com.au"))).status).toBe(403);
    expect((await request(app).get("/api/contractor/details")).status).toBe(401);
  });

  test("AC2: name, phone, business name, address and emergency contact hold after a reload; the login's name follows; a blank name is refused", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const refused = await save(bob, { name: "  ", phone: "0400 000 014" });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "Required.", field: "name" });

    const ok = await save(bob, {
      name: "Robert Reilly",
      phone: "0400 111 222",
      businessName: "Reilly & Son Plumbing",
      address: PERTH_HOME,
      emergencyContactName: "Ann Reilly",
      emergencyContactPhone: "0400 000 321",
    });
    expect(ok.status).toBe(200);
    const again = (await details(bob)).body as { own: Record<string, unknown> };
    expect(again.own).toMatchObject({
      name: "Robert Reilly",
      phone: "0400 111 222",
      businessName: "Reilly & Son Plumbing",
      address: PERTH_HOME,
      emergencyContactName: "Ann Reilly",
      emergencyContactPhone: "0400 000 321",
    });
    expect((await db.user.findUniqueOrThrow({ where: { email: "bob@idelta.com.au" } })).name).toBe("Robert Reilly");
  });

  test("AC3, AC5: anything that is the office's is not read from the body -- the bank details included -- and nothing is sent", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await save(bob, {
      email: "not-bob@idelta.com.au",
      abn: "1",
      gstRegistered: false,
      operatingState: "NSW",
      status: "suspended",
      active: false,
      specialties: [],
      insurer: "Nobody",
      payoutBsb: "062-000",
      payoutAccountNo: "99887766",
      payoutAccountName: "Not Bob",
    });
    expect(res.status).toBe(200);
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    expect(bobRow).toMatchObject({
      email: "bob@idelta.com.au",
      abn: "51000000680",
      gstRegistered: true,
      operatingState: "WA",
      status: "active",
      insurer: "QBE",
      payoutBsb: "066-000",
      payoutAccountNo: "12345678",
      payoutAccountName: "B Reilly",
      payoutChangedAt: null,
    });
    expect(bobRow.specialties).toHaveLength(1);
    expect(await db.notification.count({ where: { type: "bank_details_changed" } })).toBe(0);
  });
});

describe("AC4 -- the address sits in the Operating state", () => {
  test("AC4: a new address in another state is refused; one in WA saves; Operating state and service area never change", async () => {
    const before = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { _count: { select: { servedPostcodes: true } } } });
    const bob = await signInCookie("bob@idelta.com.au");
    const refused = await save(bob, { address: { ...SYDNEY, state: "VIC", suburb: "Carlton", postcode: "3053" } });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "The address must be in WA. Ring the office if you have moved.", field: "address" });
    expect((await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } })).address).toEqual(before.address);

    const ok = await save(bob, { address: { ...SYDNEY, state: "WA", suburb: "Subiaco", postcode: "6008", placeId: "p-subiaco" } });
    expect(ok.status).toBe(200);
    const after = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { _count: { select: { servedPostcodes: true } } } });
    expect(after.operatingState).toBe(before.operatingState);
    expect(after._count.servedPostcodes).toBe(before._count.servedPostcodes);
    expect(after.coreLocation).toEqual(before.coreLocation);
    expect((after.address as { suburb: string }).suburb).toBe("Subiaco");
  });

  test("AC4: an address already on file in another state stays, and the page still saves other changes", async () => {
    await db.contractor.update({ where: { code: "CON-014" }, data: { address: { ...SYDNEY } } });
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await save(bob, { address: { ...SYDNEY }, phone: "0400 222 333" });
    expect(res.status).toBe(200);
  });
});
