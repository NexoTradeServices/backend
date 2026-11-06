// Feature 2005 -- contractor My details
//
// AC2  Bob edits address, emergency contact and bank details and they hold; a bad BSB is refused
// AC3  everything else is read-only, on the screen and by sending it; another contractor's details cannot be read
// AC4  the address has no state check; Bob's Operating state and service area do not change
// AC5  replacing bank details stamps who and when and emails Bob and the office with no numbers; no payout is held
// AC6  a first entry of bank details sends nothing
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
import { getTemplate } from "../src/notifications/templates/registry.js";
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
const bankMessages = () => db.notification.findMany({ where: { type: "bank_details_changed" }, orderBy: { createdAt: "asc" } });

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
  test("AC3: the page carries Bob's own fields and, apart, the office's facts; Dave's details cannot be asked for", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const body = (await details(bob)).body as { own: Record<string, unknown>; office: Record<string, unknown> };
    expect(Object.keys(body.own).sort()).toEqual(["address", "emergencyContactName", "emergencyContactPhone", "payoutAccountName", "payoutAccountNo", "payoutBsb"]);
    expect(body.office).toMatchObject({ name: "Bob Reilly", code: "CON-014", operatingState: "WA", status: "active" });
    expect((body.office["specialties"] as { trade: string }[]).map((s) => s.trade)).toEqual(["Plumbing"]);
    // There is no code in the door: the session decides whose details come back.
    const asked = (await request(app).get("/api/contractor/details?code=CON-021").set("Cookie", bob)).body as { office: { code: string } };
    expect(asked.office.code).toBe("CON-014");
    // Mike has no contractor record, so the door is not his.
    expect((await details(await signInCookie("mike@idelta.com.au"))).status).toBe(403);
    expect((await request(app).get("/api/contractor/details")).status).toBe(401);
  });

  test("AC2: address, emergency contact and bank details hold after a reload; a bad BSB is refused with the words", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const refused = await save(bob, { payoutBsb: "12345", payoutAccountNo: "12345678", payoutAccountName: "B Reilly" });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "A BSB is six digits.", field: "payoutBsb" });

    const ok = await save(bob, {
      address: SYDNEY,
      emergencyContactName: "Ann Reilly",
      emergencyContactPhone: "0400 000 321",
      payoutBsb: "066-000",
      payoutAccountNo: "12345678",
      payoutAccountName: "B Reilly",
    });
    expect(ok.status).toBe(200);
    const again = (await details(bob)).body as { own: Record<string, unknown> };
    expect(again.own).toMatchObject({ address: SYDNEY, emergencyContactName: "Ann Reilly", emergencyContactPhone: "0400 000 321", payoutBsb: "066-000" });
  });

  test("AC3: anything that is the office's is not read from the body", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await save(bob, {
      name: "Not Bob",
      email: "not-bob@idelta.com.au",
      phone: "0",
      businessName: "Other Pty",
      abn: "1",
      gstRegistered: false,
      operatingState: "NSW",
      status: "suspended",
      active: false,
      specialties: [],
      insurer: "Nobody",
      payoutBsb: "066-000",
      payoutAccountNo: "12345678",
      payoutAccountName: "B Reilly",
    });
    expect(res.status).toBe(200);
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    expect(bobRow).toMatchObject({ name: "Bob Reilly", email: "bob@idelta.com.au", operatingState: "WA", status: "active", insurer: "QBE" });
    expect(bobRow.businessName).not.toBe("Other Pty");
    expect(bobRow.specialties).toHaveLength(1);
  });
});

describe("AC4 -- the address is for the file", () => {
  test("AC4: an address in a state we do not operate in saves; Operating state and service area stay as they were", async () => {
    const before = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { _count: { select: { servedPostcodes: true } } } });
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await save(bob, { address: { ...SYDNEY, state: "VIC", suburb: "Carlton", postcode: "3053" }, payoutBsb: before.payoutBsb, payoutAccountNo: before.payoutAccountNo, payoutAccountName: before.payoutAccountName });
    expect(res.status).toBe(200);
    const after = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { _count: { select: { servedPostcodes: true } } } });
    expect(after.operatingState).toBe(before.operatingState);
    expect(after._count.servedPostcodes).toBe(before._count.servedPostcodes);
    expect(after.coreLocation).toEqual(before.coreLocation);
    expect((after.address as { state: string }).state).toBe("VIC");
  });
});

describe("AC5, AC6 -- bank details change", () => {
  test("AC5: replacing details stamps who and when and emails Bob and the office, with no numbers, and holds nothing", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await save(bob, { payoutBsb: "062-000", payoutAccountNo: "99887766", payoutAccountName: "B Reilly" });
    expect(res.status).toBe(200);
    const row = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    expect(row.payoutChangedByUserId).toBe(row.userId);
    expect(row.payoutChangedAt).not.toBeNull();
    expect(row.status).toBe("active"); // nothing is held

    const sent = await bankMessages();
    expect(sent.map((n) => n.recipientType).sort()).toEqual(["contractor", "ops"]);
    const template = getTemplate("bank_details_changed", "email");
    if (!template) throw new Error("bank_details_changed email template is not registered");
    const rendered = template.render({ audience: "contractor", firstName: "Bob", contractorName: "Bob Reilly", code: "CON-014", platformName: "Perth Trades" });
    expect(rendered.subject).toBe("Bank details changed - Bob Reilly");
    expect(rendered.text).toContain("Bob's bank details were changed. If this wasn't Bob, contact the office now.");
    for (const digits of ["062", "99887766", "066", "12345678"]) expect(rendered.text + rendered.html + JSON.stringify(sent.map((n) => n.context))).not.toContain(digits);
  });

  test("AC5: saving the same details again sends nothing more", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    await save(bob, { payoutBsb: "062-000", payoutAccountNo: "99887766", payoutAccountName: "B Reilly" });
    await save(bob, { payoutBsb: "062-000", payoutAccountNo: "99887766", payoutAccountName: "B Reilly" });
    expect(await bankMessages()).toHaveLength(2);
  });

  test("AC6: a first entry of bank details stamps nothing and sends nothing", async () => {
    const priya = await signInCookie("priya@idelta.com.au");
    const res = await save(priya, { payoutBsb: "062-000", payoutAccountNo: "55443322", payoutAccountName: "P Nair" });
    expect(res.status).toBe(200);
    const row = await db.contractor.findUniqueOrThrow({ where: { code: "CON-030" } });
    expect(row.payoutBsb).toBe("062-000");
    expect(row.payoutChangedAt).toBeNull();
    expect(row.payoutChangedByUserId).toBeNull();
    expect(await bankMessages()).toHaveLength(0);
  });
});
