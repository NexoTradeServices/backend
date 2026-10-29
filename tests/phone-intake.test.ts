// Feature 3005 -- phone-taken job intake (POST /api/jobs/phone)
//
// AC1  ops and the owner can create; a contractor is refused (403); logged out is 401
// AC2  Tom (CUS-1052) rings: a plumbing job in Kalamunda is a `new` job, source phone, on Tom's
//      existing record (no second Tom), with the rate snapshot and zone like a web job
// AC3  the customer gets the Enquiry received email with the job reference and that day's prices;
//      the office gets no new-job-request email
// AC4  Karl (no customer record) becomes a new guest customer with a CUS code, his name, email, phone
//      and business name as typed
// AC5  answered trade questions are stored on the job
// AC6  a missing name, email, phone, suburb, trade, description or window: the field's own 400, nothing created
// AC7  a { suburbId } pick (Places down) resolves and saves
// 3010 AC8 the phone job keeps the contact typed on it
// AC8  a `source` sent in the body is ignored; photos, marketing ticks and reCAPTCHA are not part of it
// UAT (owner's call) the street address and the site contact are taken on the call: both optional,
//      a street pick moves the job to the pick, a half-filled contact or a typed address is a 400
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-3005", "email");

const KALAMUNDA = { suburb: "Kalamunda", state: "WA", country: "AU", postcode: "6076", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Tom",
    email: "tom@idelta.com.au",
    phone: "0400 001 052",
    location: KALAMUNDA,
    trade: "Plumbing",
    selectedOptions: [],
    // A fixed Wednesday, so the normal rate is never flaky against the day the suite runs.
    preferredDate: "2026-09-09",
    preferredWindow: "morning",
    description: "Burst pipe under the house.",
    ...overrides,
  };
}

async function signIn(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!session) throw new Error("no session cookie");
  return session.split(";")[0] ?? "";
}

const phone = (cookie: string, payload: Record<string, unknown>) => request(app).post("/api/jobs/phone").set("Cookie", cookie).send(payload);

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  registerProvider(email);
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  email.reset();
});

afterEach(async () => {
  await resetReferenceSequences(db);
});

describe("AC1 -- who may key a phone job", () => {
  test("AC1: Mike and the owner create; a contractor is 403; logged out is 401; nothing is created for the refused", async () => {
    const jobs = await db.job.count();
    expect((await phone(await signIn("mike@idelta.com.au"), body())).status).toBe(201);
    expect((await phone(await signIn("owner@idelta.com.au"), body())).status).toBe(201);
    expect((await phone(await signIn("bob@idelta.com.au"), body())).status).toBe(403);
    expect((await request(app).post("/api/jobs/phone").send(body())).status).toBe(401);
    expect(await db.job.count()).toBe(jobs + 2);
  });
});

describe("AC2/AC3 -- Tom rings", () => {
  test("AC2: a `new` job, source phone, on Tom's existing record, with the rate snapshot and zone", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const customers = await db.customer.count();
    const tom = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
    const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });

    const res = await phone(mike, body());
    expect(res.status).toBe(201);
    const reference = (res.body as { reference: string }).reference;
    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(job.status).toBe("new");
    expect(job.source).toBe("phone");
    expect(job.customerId).toBe(tom.id);
    expect(await db.customer.count()).toBe(customers);
    expect(job.customerCalloutRate).toBe(plumbing.customerCalloutRate);
    expect(job.customerStandardRate).toBe(plumbing.customerStandardRate);
    expect(job.timezone).toBe("Australia/Perth");
    expect(job.postcode).toBe("6076");
  });

  test("AC3: Tom gets the Enquiry received email with the reference and the prices; the office gets no new-job-request", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(mike, body());
    const reference = (res.body as { reference: string }).reference;
    expect(await db.notification.count({ where: { type: "new_job_request" } })).toBe(0);
    expect(await db.notification.count({ where: { type: "enquiry_confirmation" } })).toBe(1);
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("tom@idelta.com.au");
    expect(email.sent[0]?.message.text).toContain(reference);
    expect(email.sent[0]?.message.text).toContain("$");
  });
});

describe("AC4/AC5 -- Karl, and the trade's questions", () => {
  test("AC4: a new guest customer with a CUS code and the details as typed", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(mike, body({ name: "Karl", email: "Karl@idelta.com.au", phone: "0400 000 999", businessName: "Karl's Sheds", location: { ...KALAMUNDA, suburb: "Joondalup", postcode: "6027", placeId: "p-joondalup" } }));
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference }, include: { customer: true } });
    expect(job.customer).toMatchObject({ name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999", businessName: "Karl's Sheds", userId: null });
    expect(job.customer.code).toMatch(/^CUS-\d+$/);
  });

  test("AC5: the answered questions are stored on the job", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(mike, body({ selectedOptions: ["Where in the property is it?: Kitchen"] }));
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference } });
    expect(job.selectedOptions).toEqual(["Where in the property is it?: Kitchen"]);
  });
});

describe("AC6 -- the field's own error", () => {
  test.each([
    ["name", { name: "" }],
    ["email", { email: "not-an-email" }],
    ["phone", { phone: "" }],
    ["location", { location: undefined }],
    ["trade", { trade: "" }],
    ["description", { description: " " }],
    ["preferredWindow", { preferredWindow: undefined }],
  ])("AC6: a missing %s is a 400 on that field and nothing is created", async (field, override) => {
    const mike = await signIn("mike@idelta.com.au");
    const jobs = await db.job.count();
    const res = await phone(mike, body(override));
    expect(res.status).toBe(400);
    expect((res.body as { field: string }).field).toBe(field);
    expect(await db.job.count()).toBe(jobs);
  });

  test("AC6: an unknown trade is a 400 on trade", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(mike, body({ trade: "Basket weaving" }));
    expect(res.status).toBe(400);
    expect((res.body as { field: string }).field).toBe("trade");
  });
});

describe("AC7/AC8", () => {
  test("AC7: a suburbId pick (Places down) resolves to the suburb's own values and saves", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const suburb = await db.suburb.create({ data: { name: "Hilton", slug: "hilton-6163-wa", postcode: "6163", state: "WA", centroidLat: -32.0731, centroidLng: 115.7797 } });
    const res = await phone(mike, body({ location: { suburbId: suburb.id } }));
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference } });
    expect(job.postcode).toBe("6163");
    expect(JSON.stringify(job.serviceLocation)).not.toContain("placeId");
  });

  test("AC8: a source sent in the body is ignored; photos and marketing sent are not stored", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(mike, body({ source: "web", marketingEmail: true, marketingSms: true, photos: [{ storageKey: "enquiry-photos/x", fileName: "x.jpg" }] }));
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference }, include: { customer: true } });
    expect(job.source).toBe("phone");
    expect(await db.attachment.count({ where: { jobId: job.id } })).toBe(0);
    expect(job.customer.marketingConsent).toBeNull();
  });
});

describe("3010 AC8 -- a phone job keeps what Mike keyed", () => {
  test("3010 AC8: Tom's phone job with a new phone keeps it on the job; his record is untouched", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const tom = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
    const res = await phone(mike, body({ phone: "0412 777 888" }));
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference } });
    expect(job.enquiryContact).toEqual({ name: "Tom", phone: "0412 777 888" });
    expect((await db.customer.findUniqueOrThrow({ where: { id: tom.id } })).phone).toBe(tom.phone);
  });
});

describe("UAT -- the addresses, ABN and site contact taken on the call", () => {
  const HILTON_STREET = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton-street" };
  const KALAMUNDA_STREET = { street: "14 Mundaring Weir Road", ...KALAMUNDA, placeId: "fixture-place-14-mundaring" };

  test("billing, a site of its own, the ABN, GST and the contact are saved; the street moves the job to its suburb", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(
      mike,
      body({
        email: "nina-phone@idelta.com.au",
        businessName: "Rossi's Cafe",
        abn: "51 824 753 556",
        gstRegistered: "yes",
        billingAddress: KALAMUNDA_STREET,
        site: { sameAsBilling: false, address: HILTON_STREET },
        siteContact: { name: "Lena Park", phone: "0400 111 222", email: "lena@idelta.com.au" },
      }),
    );
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference }, include: { customer: true } });
    expect(job.customer.billingAddress).toMatchObject({ street: "14 Mundaring Weir Road", postcode: "6076" });
    expect(job.customer.abn).toBe("51824753556");
    expect(job.customer.gstRegistered).toBe(true);
    expect(job.siteAddress).toMatchObject({ street: "5 Carrington Street", suburb: "Hilton" });
    expect(job.siteContact).toEqual({ name: "Lena Park", phone: "0400 111 222", email: "lena@idelta.com.au" });
    expect(job.postcode).toBe("6163");
    expect(job.serviceLocation).toMatchObject({ suburb: "Hilton", placeId: "fixture-place-hilton-street" });
  });

  test("site same as billing copies the billing address onto the job", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(mike, body({ billingAddress: KALAMUNDA_STREET, site: { sameAsBilling: true } }));
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference } });
    expect(job.siteAddress).toMatchObject({ street: "14 Mundaring Weir Road", suburb: "Kalamunda" });
  });

  test("none of it is required: a job without it has no addresses and no contact", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await phone(mike, body());
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference } });
    expect(job.siteAddress).toBeNull();
    expect(job.siteContact).toBeNull();
    expect(job.postcode).toBe("6076");
  });

  test("a half-filled contact, a bad ABN or a typed address is a 400 on its own field and nothing is created", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const before = await db.job.count();
    const half = await phone(mike, body({ siteContact: { name: "Lena Park", phone: "" } }));
    expect(half.status).toBe(400);
    expect(half.body).toMatchObject({ field: "siteContactPhone" });
    const abn = await phone(mike, body({ businessName: "Rossi's Cafe", abn: "12345" }));
    expect(abn.status).toBe(400);
    expect(abn.body).toMatchObject({ field: "abn" });
    const typed = await phone(mike, body({ billingAddress: { street: "14 Mundaring Weir Road" } }));
    expect(typed.status).toBe(400);
    expect(typed.body).toMatchObject({ field: "billingAddress" });
    expect(await db.job.count()).toBe(before);
  });
});
