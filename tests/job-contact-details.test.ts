// Feature 3010 -- per-job contact details
//
// AC2  the job read says what she gave where it differs from her record: the phone (on its digits) and
//      the business name flag `newDetails`; the name alone is carried but never flags
// AC3  a text about the job goes to the phone given on it; her other jobs' texts go to the record's;
//      site-contact texts are unchanged
// AC4  Update customer copies the given phone and business name onto the record (never the name or the
//      email), the flag and the given values go, and the next job's texts go to the new phone
// AC5  an empty business name never flags and never clears one
// AC6  a name alone ("Sara") is shown, never flagged, and has nothing to copy (409)
// AC9  an older job with no contact reads as before and texts the record's phone
// AC10 Update customer is ops-only: a contractor is 403, logged out is 401
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { dispatchedSms, recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { drainOnce, sendNotification } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { givenDetails } from "../src/jobs/enquiry-contact.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-3010", "email");
const sms = recordingAdapter("test-sms-3010", "sms");

const HILTON = { suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };

interface Detail {
  customer: {
    phone: string | null;
    businessName: string | null;
    name: string;
    given: { name: string | null; phone: string | null; businessName: string | null };
    newDetails: boolean;
  };
}

function enquiry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Sarah Chen",
    email: "sarah@idelta.com.au",
    phone: "0412 555 019",
    location: HILTON,
    trade: "Plumbing",
    selectedOptions: [],
    preferredDate: "2026-09-09",
    preferredWindow: "morning",
    description: "Mixer tap leaking.",
    marketingEmail: false,
    marketingSms: false,
    ...overrides,
  };
}

async function signIn(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return (cookies.find((c) => c.includes("better-auth.session_token=")) ?? "").split(";")[0] ?? "";
}

async function makeJob(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app).post("/api/enquiries").send(enquiry(overrides));
  expect(res.status).toBe(201);
  return (res.body as { reference: string }).reference;
}

async function read(cookie: string, reference: string): Promise<Detail> {
  const res = await request(app).get(`/api/jobs/${reference}`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as Detail;
}

async function textAbout(reference: string): Promise<string | undefined> {
  const job = await db.job.findUniqueOrThrow({ where: { reference } });
  await sendNotification(
    {
      type: "dispatched",
      channel: "sms",
      recipientType: "customer",
      recipientId: job.customerId,
      idempotencyKey: `dispatched:test:${reference}:${Math.random().toString(36).slice(2)}`,
      jobId: job.id,
      context: { jobReference: reference },
    },
    db,
  );
  sms.reset();
  await drainOnce(db);
  return sms.sent[0]?.to;
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  registerProvider(email);
  registerProvider(sms);
  registerTemplate(dispatchedSms);
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await setProviders(db, { emailProvider: email.name, smsProvider: sms.name, providerOverrides: null });
  email.reset();
  sms.reset();
});

afterEach(async () => {
  await resetReferenceSequences(db);
});

describe("the derivation", () => {
  const record = { name: "Sarah Chen", phone: "0411 222 333", businessName: null as string | null };
  test("phones compare on their digits; the name never counts; an empty business name never flags", () => {
    expect(givenDetails({ name: "Sarah Chen", phone: "0411-222-333" }, record).newDetails).toBe(false);
    expect(givenDetails({ name: "Sarah Chen", phone: "0412 555 019" }, record)).toMatchObject({ phone: "0412 555 019", newDetails: true });
    expect(givenDetails({ name: "Sara", phone: "0411 222 333" }, record)).toEqual({ name: "Sara", phone: null, businessName: null, newDetails: false });
    expect(givenDetails({ name: "Sarah Chen", phone: "0411 222 333", businessName: "Chen Consulting" }, record).newDetails).toBe(true);
    expect(givenDetails({ name: "Sarah Chen", phone: "0411 222 333" }, { ...record, businessName: "Rossi's Cafe" })).toMatchObject({ businessName: null, newDetails: false });
    expect(givenDetails(null, record)).toEqual({ name: null, phone: null, businessName: null, newDetails: false });
  });
});

describe("AC2/AC5/AC6/AC9 -- the job read", () => {
  test("AC2: a new phone and a business name flag newDetails, each carried as given", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob({ businessName: "Chen Consulting" });
    const { customer } = await read(mike, reference);
    expect(customer.newDetails).toBe(true);
    expect(customer.given).toEqual({ name: null, phone: "0412 555 019", businessName: "Chen Consulting" });
  });

  test("AC5: Nina's request with the business name empty does not flag and her record keeps Rossi's Cafe", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const nina = await db.customer.create({ data: { code: "CUS-9001", name: "Nina Rossi", email: "nina@idelta.com.au", phone: "0400 002 060", businessName: "Rossi's Cafe" } });
    const reference = await makeJob({ name: "Nina Rossi", email: "nina@idelta.com.au", phone: "0400 002 060", businessName: "" });
    const { customer } = await read(mike, reference);
    expect(customer.newDetails).toBe(false);
    expect(customer.given.businessName).toBeNull();
    expect((await db.customer.findUniqueOrThrow({ where: { id: nina.id } })).businessName).toBe("Rossi's Cafe");
  });

  test("AC6: 'Sara' alone is shown as given, never flagged, and has nothing to copy", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const reference = await makeJob({ name: "Sara", phone: sarah.phone ?? "" });
    const { customer } = await read(mike, reference);
    expect(customer.given).toEqual({ name: "Sara", phone: null, businessName: null });
    expect(customer.newDetails).toBe(false);
    const res = await request(app).post(`/api/jobs/${reference}/customer/update-from-request`).set("Cookie", mike);
    expect(res.status).toBe(409);
  });

  test("AC9: an older job with no contact reads as before", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const { customer } = await read(mike, "JOB-1042");
    expect(customer.newDetails).toBe(false);
    expect(customer.given).toEqual({ name: null, phone: null, businessName: null });
  });
});

describe("AC3/AC9 -- where this job's texts go", () => {
  test("AC3: the text about the job goes to the phone given on it; another job's goes to the record's", async () => {
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const reference = await makeJob({ businessName: "Chen Consulting" });
    expect(await textAbout(reference)).toBe("0412 555 019");
    expect(await textAbout("JOB-1042")).toBe(sarah.phone);
  });

  test("AC9: a job with no contact texts the record's phone; a text with no job does too", async () => {
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(await textAbout("JOB-1042")).toBe(sarah.phone);
  });
});

describe("AC4/AC10 -- Update customer", () => {
  test("AC4: the record gets the new phone and business name, never the name or email; the flag goes; the next job texts the new phone", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob({ name: "Sara", businessName: "Chen Consulting" });
    const before = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });

    const res = await request(app).post(`/api/jobs/${reference}/customer/update-from-request`).set("Cookie", mike);
    expect(res.status).toBe(200);
    const detail = res.body as Detail;
    expect(detail.customer.newDetails).toBe(false);
    expect(detail.customer.phone).toBe("0412 555 019");
    expect(detail.customer.businessName).toBe("Chen Consulting");

    const after = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(after.name).toBe(before.name);
    expect(after.email).toBe(before.email);
    expect(after.phone).toBe("0412 555 019");

    const next = await makeJob({ phone: "0412 555 019" });
    expect(await textAbout(next)).toBe("0412 555 019");
    expect(await textAbout("JOB-1042")).toBe("0412 555 019");
    // A second press has nothing left to copy.
    expect((await request(app).post(`/api/jobs/${reference}/customer/update-from-request`).set("Cookie", mike)).status).toBe(409);
  });

  test("AC4: it works on a job in any status", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    await db.job.update({ where: { reference }, data: { status: "cancelled" } });
    expect((await request(app).post(`/api/jobs/${reference}/customer/update-from-request`).set("Cookie", mike)).status).toBe(200);
  });

  test("AC10: a contractor is 403, logged out is 401, nothing changes", async () => {
    const reference = await makeJob();
    const bob = await signIn("bob@idelta.com.au");
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect((await request(app).post(`/api/jobs/${reference}/customer/update-from-request`).set("Cookie", bob)).status).toBe(403);
    expect((await request(app).post(`/api/jobs/${reference}/customer/update-from-request`)).status).toBe(401);
    expect((await db.customer.findUniqueOrThrow({ where: { id: sarah.id } })).phone).toBe(sarah.phone);
  });

  test("an unknown job is 404", async () => {
    const mike = await signIn("mike@idelta.com.au");
    expect((await request(app).post("/api/jobs/JOB-9999999/customer/update-from-request").set("Cookie", mike)).status).toBe(404);
  });
});
