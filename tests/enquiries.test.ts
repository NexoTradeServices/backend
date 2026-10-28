// Feature 3001 -- enquiry form to job created
//
// AC1  Karl's enquiry creates a guest Customer (next free CUS- code) and a
//      Job (next free JOB- reference), source=web, status=new, the suburb
//      pick, selectedOptions matching the labels shown, timezone frozen
//      from the state, and the customer rate snapshot at the NORMAL
//      multiplier
// AC2  a Saturday enquiry freezes the WEEKEND multiplier on the job
// AC3  a repeat enquiry from a known email attaches to the existing
//      Customer row -- no second Customer, no overwrite of name/phone
// AC5  the confirmation email quotes the rates frozen on the job
// AC6  the new-job-request notice is addressed from operatorEmail; unset,
//      that one row fails on its own, the customer's job/confirmation
//      unaffected
// AC7  a confirmed-bot verdict creates no Customer/Job and shows the
//      operator phone; an unreachable check lets the submission through
//      exactly like a verified human
// AC9  PreferredWindow carries no `specific` value and preferredDate is
//      NOT NULL, proven against the migrated schema and the seeded fixtures
// AC11 an empty prefilledFields trade saves with selectedOptions empty
//
// Feature 1017 -- business customers (the enquiry endpoint's half)
// 1017 AC2  a new customer is created with the business name; an existing
//           customer (found by email) is left as it is; empty becomes null
// 1017 AC4  Customer.abn exists and the enquiry never writes it
// 1017 AC5  the evening window reads 17:00-19:00 in the enquiry's text
//
// Feature 3003 -- enquiry photos (the enquiry endpoint's half)
// 3003 AC1  an enquiry with two photos writes two customer Attachment rows
// 3003 AC2  an enquiry with no photos writes no Attachment rows
// 3003 AC3  six photos, a foreign folder, or a missing file name -> 400
//           field "photos", no job
//
// Feature 3002 -- coverage tiers (the endpoint's half; the check itself is tests/coverage.test.ts)
// 3002 AC3  an out-of-reach enquiry (Karl, Joondalup) submits as a normal new job, nothing about
//           the tier stored on it
//
// Feature 3006 -- the enquiry form safe when Google is missing (the endpoint's half)
// 3006 AC1  live site, no reCAPTCHA secret: 503 + operator phone, no rows;
//           form-data says takingEnquiries false
// 3006 AC2  not the live site, no secret: accepted as before; form-data true
// 3006 AC5  a { suburbId } pick stores the Suburb row's values, no placeId
// 3006 AC6  a postcode shared by several suburbs: the picked row is the one stored
// 3006 AC7  an unknown suburbId -> 400 on the field "location", no job
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import type { RecaptchaVerdict } from "../src/enquiries/recaptcha.js";
import type { PrismaClient } from "../src/db/client.js";

interface EnquiryResponseBody {
  reference?: string;
  field?: string;
  operatorPhone?: string;
}

interface FormDataResponseBody {
  operatorPhone: string;
  takingEnquiries: boolean;
  serviceTypes: { trade: string; prefilledFields: string[]; customerCalloutRate: number }[];
}

let db: PrismaClient;
let app: Express;
let verdict: RecaptchaVerdict;

const email = recordingAdapter("test-email", "email");

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Karl",
    email: "karl@idelta.com.au",
    phone: "0400 000 999",
    location: {
      suburb: "Joondalup",
      state: "WA",
      country: "AU",
      postcode: "6027",
      lat: -31.7448,
      lng: 115.7661,
      placeId: "fixture-place-joondalup",
    },
    trade: "Plumbing",
    selectedOptions: ["Where in the property is it?: Kitchen"],
    // A fixed Wednesday -- never a weekend, so AC1's normal-rate case is
    // never flaky against the day this suite happens to run.
    preferredDate: "2026-09-09",
    preferredWindow: "morning",
    description: "Kitchen tap won't stop dripping.",
    marketingEmail: false,
    marketingSms: false,
    recaptchaToken: "fixture-token",
    ...overrides,
  };
}

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  app = express();
  app.use(express.json());
  app.use(
    "/api/enquiries",
    enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve(verdict) }),
  );
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  verdict = "human";
  email.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  email.reset();
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

describe("AC1 -- Karl's enquiry, never contacted before", () => {
  test("AC1: a fresh guest Customer and Job are created, next free codes, source=web, normal rates", async () => {
    const res = await request(app).post("/api/enquiries").send(validBody());
    expect(res.status).toBe(201);
    // The next free code is 1052 on a quiet database; a burnt sequence number (a retry
    // on a cold CI runner) may push it up, so the test checks "at or past 1052" and
    // reads the row by the reference it was given.
    const reference = (res.body as EnquiryResponseBody).reference ?? "";
    expect(Number(reference.replace("JOB-", ""))).toBeGreaterThanOrEqual(1052);

    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(job.source).toBe("web");
    expect(job.status).toBe("new");
    expect(job.postcode).toBe("6027");
    expect(job.serviceLocation).toMatchObject({
      suburb: "Joondalup",
      state: "WA",
      country: "AU",
      lat: -31.7448,
      lng: 115.7661,
    });
    expect(job.selectedOptions).toEqual(["Where in the property is it?: Kitchen"]);
    expect(job.timezone).toBe("Australia/Perth");
    expect(job.customerCalloutRate).toBe(25_000);
    expect(job.customerStandardRate).toBe(18_000);

    const customer = await db.customer.findUniqueOrThrow({ where: { id: job.customerId } });
    expect(Number(customer.code.replace("CUS-", ""))).toBeGreaterThanOrEqual(1054);
    expect(customer.userId).toBeNull();
    expect(customer.name).toBe("Karl");
    expect(customer.email).toBe("karl@idelta.com.au");
  });

  test("AC1: every field is validated -- a missing description is refused with a field error", async () => {
    const res = await request(app).post("/api/enquiries").send(validBody({ description: "" }));
    expect(res.status).toBe(400);
    expect((res.body as EnquiryResponseBody).field).toBe("description");
    expect(await db.job.count()).toBe(3); // only the fixture seed's three
  });
});

describe("AC2 -- a Saturday date never bumps the job's own rate card (BKLG-020, superseded 4002-AC38)", () => {
  test("AC2: a Saturday enquiry stores the base rates unmultiplied -- the level and its multiplier are Feature 4002's, at dispatch", async () => {
    // 2026-09-12 is a Saturday.
    const res = await request(app)
      .post("/api/enquiries")
      .send(validBody({ preferredDate: "2026-09-12" }));
    expect(res.status).toBe(201);

    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference } });
    expect(job.customerCalloutRate).toBe(25_000);
    expect(job.customerStandardRate).toBe(18_000);
  });
});

describe("AC3 -- a known email attaches to the existing Customer", () => {
  test("AC3: Sarah's repeat enquiry reuses CUS-1050 and never overwrites her name/phone", async () => {
    const before = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const customerCountBefore = await db.customer.count();

    const res = await request(app).post("/api/enquiries").send(
      validBody({
        name: "Someone Else",
        email: "sarah@idelta.com.au",
        phone: "0400 999 999",
      }),
    );
    expect(res.status).toBe(201);

    expect(await db.customer.count()).toBe(customerCountBefore);
    const after = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(after.name).toBe(before.name);
    expect(after.phone).toBe(before.phone);

    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference } });
    expect(job.customerId).toBe(before.id);
  });
});

describe("AC5 -- the confirmation email quotes the frozen rates", () => {
  test("AC5: 'first hour (includes call-out) $250, then $180/h' for a weekday plumbing job", async () => {
    const res = await request(app).post("/api/enquiries").send(validBody());
    expect(res.status).toBe(201);

    await drainOnce(db);
    const confirmation = email.sent.find((m) => m.message.subject === "We've got your request");
    expect(confirmation).toBeDefined();
    expect(confirmation?.to).toBe("karl@idelta.com.au");
    expect(confirmation?.message.text).toContain("$250");
    expect(confirmation?.message.text).toContain("$180/h");
    expect(confirmation?.message.text).toContain((res.body as EnquiryResponseBody).reference);
  });
});

describe("AC6 -- the ops notice, addressed from operatorEmail", () => {
  test("AC6: the new-job-request notice reaches operatorEmail with reference, trade, suburb, date and window", async () => {
    const res = await request(app).post("/api/enquiries").send(validBody());
    expect(res.status).toBe(201);

    await drainOnce(db);
    const settings = await db.platformSettings.findFirstOrThrow();
    const notice = email.sent.find((m) => m.to === settings.operatorEmail);
    expect(notice).toBeDefined();
    expect(notice?.message.text).toContain((res.body as EnquiryResponseBody).reference);
    expect(notice?.message.text).toContain("Plumbing");
    expect(notice?.message.text).toContain("Joondalup");
    expect(notice?.message.text).toContain("Morning");
  });

  test("AC6: with operatorEmail unset, that row fails naming the missing setting -- the customer's own job and confirmation are untouched", async () => {
    const settings = await db.platformSettings.findFirstOrThrow();
    await db.platformSettings.update({ where: { id: settings.id }, data: { operatorEmail: "" } });

    const res = await request(app).post("/api/enquiries").send(validBody());
    expect(res.status).toBe(201);

    await drainOnce(db);
    const confirmation = email.sent.find((m) => m.message.subject === "We've got your request");
    expect(confirmation).toBeDefined(); // untouched

    const noticeRow = await db.notification.findFirstOrThrow({ where: { type: "new_job_request" } });
    expect(noticeRow.status).toBe("failed");
    expect(noticeRow.error).toMatch(/operatorEmail/);

    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference } });
    expect(job.status).toBe("new"); // the job itself exists, untouched
  });
});

describe("AC7 -- reCAPTCHA gate", () => {
  test("AC7: a confirmed bot creates no Customer and no Job, and the response carries the operator phone", async () => {
    verdict = "bot";
    const jobCountBefore = await db.job.count();
    const customerCountBefore = await db.customer.count();

    const res = await request(app).post("/api/enquiries").send(validBody({ email: "bot@idelta.com.au" }));
    expect(res.status).toBe(403);
    const settings = await db.platformSettings.findFirstOrThrow();
    expect((res.body as EnquiryResponseBody).operatorPhone).toBe(settings.operatorPhone);

    expect(await db.job.count()).toBe(jobCountBefore);
    expect(await db.customer.count()).toBe(customerCountBefore);
  });

  test("AC7: an unreachable check lets the submission through exactly like a verified human", async () => {
    verdict = "unreachable";
    const res = await request(app).post("/api/enquiries").send(validBody({ email: "unreachable@idelta.com.au" }));
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference } });
    expect(job.status).toBe("new");
  });
});

describe("AC9 -- the job shelf corrections", () => {
  test("AC9: PreferredWindow no longer carries 'specific'", async () => {
    const labels = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT enumlabel FROM pg_enum
       WHERE enumtypid = 'public."PreferredWindow"'::regtype
    `;
    expect(labels.map((l) => l.enumlabel).sort()).toEqual(["afternoon", "evening", "morning"]);
  });

  test("AC9: Job.preferredDate is NOT NULL at the database", async () => {
    const columns = await db.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Job' AND column_name = 'preferredDate'
    `;
    expect(columns[0]?.is_nullable).toBe("NO");
  });

  test("AC9: the seed's own three jobs carry real dates", async () => {
    for (const reference of ["JOB-1042", "JOB-1051", "JOB-1039"]) {
      const job = await db.job.findUniqueOrThrow({ where: { reference } });
      expect(job.preferredDate).not.toBeNull();
      expect(job.source).toBe("web");
    }
  });
});

describe("AC11 -- an empty prefilledFields trade", () => {
  test("AC11: the job saves with selectedOptions empty", async () => {
    const res = await request(app)
      .post("/api/enquiries")
      .send(
        validBody({
          email: "karl-electrical@idelta.com.au",
          trade: "Electrical",
          selectedOptions: [],
        }),
      );
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference } });
    expect(job.selectedOptions).toEqual([]);
  });
});

describe("GET /api/enquiries/form-data", () => {
  test("returns the operator phone and every trade with its prefilled options and rates", async () => {
    const res = await request(app).get("/api/enquiries/form-data");
    expect(res.status).toBe(200);
    const settings = await db.platformSettings.findFirstOrThrow();
    const body = res.body as FormDataResponseBody;
    expect(body.operatorPhone).toBe(settings.operatorPhone);
    const plumbing = body.serviceTypes.find((s) => s.trade === "Plumbing");
    expect(plumbing?.prefilledFields).toEqual([
      "Where in the property is it?",
      "What brand is it, if you know?",
      "Roughly how old is it?",
      "Is water leaking right now?",
      "Can you turn the water off at the mains?",
      "Is the hot water gas or electric?",
    ]);
    expect(plumbing?.customerCalloutRate).toBe(25_000);
  });
});

describe("Feature 3003 -- enquiry photos", () => {
  const KEY_ONE = "tradeservice/enquiry-photos/leaking-tap-aaa111";
  const KEY_TWO = "tradeservice/enquiry-photos/under-the-sink-bbb222";

  test("3003 AC1: two photos write two Attachment rows -- customer, no assignment, public id and file name", async () => {
    const res = await request(app)
      .post("/api/enquiries")
      .send(
        validBody({
          name: "Sarah Chen",
          email: "sarah@idelta.com.au",
          photos: [
            { storageKey: KEY_ONE, fileName: "IMG_2041 leaking mixer tap.heic" },
            { storageKey: KEY_TWO, fileName: "under-the-sink.jpg" },
          ],
        }),
      );
    expect(res.status).toBe(201);
    const reference = (res.body as EnquiryResponseBody).reference as string;

    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    const rows = await db.attachment.findMany({ where: { jobId: job.id }, orderBy: { storageKey: "asc" } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.uploadedByRole).toBe("customer");
      expect(row.assignmentId).toBeNull();
    }
    expect(rows.map((row) => [row.storageKey, row.fileName])).toEqual([
      [KEY_ONE, "IMG_2041 leaking mixer tap.heic"],
      [KEY_TWO, "under-the-sink.jpg"],
    ]);
  });

  test("3003 AC2: an enquiry with no photos writes no Attachment rows, with the key absent or empty", async () => {
    const without = await request(app).post("/api/enquiries").send(validBody());
    expect(without.status).toBe(201);
    const empty = await request(app)
      .post("/api/enquiries")
      .send(validBody({ email: "karl2@idelta.com.au", photos: [] }));
    expect(empty.status).toBe(201);
    expect(await db.attachment.count()).toBe(0);
  });

  test("3003 AC3: six photos is refused with field photos and no job is created", async () => {
    const jobsBefore = await db.job.count();
    const photos = Array.from({ length: 6 }, (_, i) => ({
      storageKey: `tradeservice/enquiry-photos/p${String(i)}`,
      fileName: `p${String(i)}.jpg`,
    }));
    const res = await request(app).post("/api/enquiries").send(validBody({ photos }));
    expect(res.status).toBe(400);
    expect((res.body as EnquiryResponseBody).field).toBe("photos");
    expect(await db.job.count()).toBe(jobsBefore);
    expect(await db.attachment.count()).toBe(0);
  });

  test.each([
    ["outside the enquiry-photos folder", { storageKey: "someone-else/folder/tap", fileName: "tap.jpg" }],
    ["the folder itself, no file", { storageKey: "tradeservice/enquiry-photos/", fileName: "tap.jpg" }],
    ["climbing out of the folder", { storageKey: "tradeservice/enquiry-photos/../work-photos/tap", fileName: "tap.jpg" }],
    ["no file name", { storageKey: KEY_ONE }],
    ["a blank file name", { storageKey: KEY_ONE, fileName: "   " }],
  ])("3003 AC3: a photo %s is refused with field photos and no job is created", async (_label, photo) => {
    const jobsBefore = await db.job.count();
    const res = await request(app).post("/api/enquiries").send(validBody({ photos: [photo] }));
    expect(res.status).toBe(400);
    expect((res.body as EnquiryResponseBody).field).toBe("photos");
    expect(await db.job.count()).toBe(jobsBefore);
    expect(await db.attachment.count()).toBe(0);
  });
});

describe("1017 -- business customers", () => {
  test("1017 AC2: Nina Rossi, a new email, submits with Rossi's Cafe -- her new customer holds it, trimmed", async () => {
    const res = await request(app)
      .post("/api/enquiries")
      .send(validBody({ name: "Nina Rossi", email: "nina@idelta.com.au", businessName: "  Rossi's Cafe  " }));
    expect(res.status).toBe(201);

    const nina = await db.customer.findUniqueOrThrow({ where: { email: "nina@idelta.com.au" } });
    expect(nina.businessName).toBe("Rossi's Cafe");
    expect(nina.abn).toBeNull(); // 1017 AC4: nothing writes the ABN
  });

  test("1017 AC2: Sarah, on file with no business name, submits with one typed -- her record is unchanged", async () => {
    const before = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(before.businessName).toBeNull();

    const res = await request(app)
      .post("/api/enquiries")
      .send(validBody({ name: "Sarah Chen", email: "sarah@idelta.com.au", businessName: "Chen Interiors" }));
    expect(res.status).toBe(201);

    const after = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(after.businessName).toBeNull();
    expect(after.abn).toBeNull();
  });

  test("1017 AC2: an empty, blank or missing business name becomes null; a non-text one is refused", async () => {
    const blank = await request(app).post("/api/enquiries").send(validBody({ email: "karl@idelta.com.au", businessName: "   " }));
    expect(blank.status).toBe(201);
    expect((await db.customer.findUniqueOrThrow({ where: { email: "karl@idelta.com.au" } })).businessName).toBeNull();

    const missing = await request(app).post("/api/enquiries").send(validBody({ email: "nina@idelta.com.au" }));
    expect(missing.status).toBe(201);
    expect((await db.customer.findUniqueOrThrow({ where: { email: "nina@idelta.com.au" } })).businessName).toBeNull();

    const refused = await request(app).post("/api/enquiries").send(validBody({ email: "karl2@idelta.com.au", businessName: 42 }));
    expect(refused.status).toBe(400);
    expect((refused.body as EnquiryResponseBody).field).toBe("businessName");
  });

  test("1017 AC5: an evening enquiry's ops notice says Evening (17:00-19:00)", async () => {
    const res = await request(app).post("/api/enquiries").send(validBody({ preferredWindow: "evening" }));
    expect(res.status).toBe(201);

    await drainOnce(db);
    const settings = await db.platformSettings.findFirstOrThrow();
    const notice = email.sent.find((m) => m.to === settings.operatorEmail);
    expect(notice?.message.text).toContain("Evening (17:00-19:00)");
    expect(notice?.message.text).not.toContain("20:00");
  });
});

describe("3006 AC1 / AC2 -- reCAPTCHA is a gate on the live site only", () => {
  test("AC1: live site, no secret -> 503 with the operator phone, no Customer, no Job; form-data says closed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "");
    const customers = await db.customer.count();
    const jobs = await db.job.count();

    const res = await request(app).post("/api/enquiries").send(validBody({ email: "gate@idelta.com.au" }));
    expect(res.status).toBe(503);
    const body = res.body as EnquiryResponseBody & { error?: string };
    expect(body.error).toBe("enquiries are not taken online right now");
    expect(body.operatorPhone).toBeTruthy();
    expect(await db.customer.count()).toBe(customers);
    expect(await db.job.count()).toBe(jobs);

    const formData = await request(app).get("/api/enquiries/form-data");
    expect((formData.body as FormDataResponseBody).takingEnquiries).toBe(false);
  });

  test("AC1: live site WITH a secret -> the form is open as before", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "a-secret");
    const formData = await request(app).get("/api/enquiries/form-data");
    expect((formData.body as FormDataResponseBody).takingEnquiries).toBe(true);
  });

  test("AC2: not the live site, no secret -> accepted exactly as before; form-data says open", async () => {
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "");
    const res = await request(app).post("/api/enquiries").send(validBody({ email: "dev@idelta.com.au" }));
    expect(res.status).toBe(201);
    const formData = await request(app).get("/api/enquiries/form-data");
    expect((formData.body as FormDataResponseBody).takingEnquiries).toBe(true);
  });
});

describe("3006 AC5 / AC6 / AC7 -- a suburb picked from our own list", () => {
  async function ownSuburbs(): Promise<{ hilton: string; ardross: string; applecross: string }> {
    const make = (name: string, slug: string, postcode: string, lat: number, lng: number) =>
      db.suburb.create({ data: { name, slug, postcode, state: "WA", centroidLat: lat, centroidLng: lng } });
    const hilton = await make("Hilton", "hilton-wa-6163", "6163", -32.0731, 115.7797);
    const ardross = await make("Ardross", "ardross-wa-6153", "6153", -32.0201, 115.8394);
    const applecross = await make("Applecross", "applecross-wa-6153", "6153", -32.0125, 115.8419);
    return { hilton: hilton.id, ardross: ardross.id, applecross: applecross.id };
  }

  test("AC5: the job stores the row's suburb, postcode, state, country AU and centroid, with no placeId", async () => {
    const ids = await ownSuburbs();
    const res = await request(app)
      .post("/api/enquiries")
      .send(validBody({ name: "Sarah Chen", email: "sarah@idelta.com.au", location: { suburbId: ids.hilton } }));
    expect(res.status).toBe(201);

    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference ?? "" } });
    expect(job.postcode).toBe("6163");
    expect(job.serviceLocation).toEqual({ suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797 });
    expect(job.serviceLocation).not.toHaveProperty("placeId");
  });

  test("AC6: one postcode, many suburbs -- the picked row is the one stored", async () => {
    const ids = await ownSuburbs();
    const res = await request(app)
      .post("/api/enquiries")
      .send(validBody({ email: "margaret@idelta.com.au", location: { suburbId: ids.ardross } }));
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference ?? "" } });
    expect(job.postcode).toBe("6153");
    expect(job.serviceLocation).toMatchObject({ suburb: "Ardross" });
  });

  test("AC7: an unknown suburbId -> 400 on the field location, and no job", async () => {
    const jobs = await db.job.count();
    const res = await request(app).post("/api/enquiries").send(validBody({ location: { suburbId: "no-such-suburb" } }));
    expect(res.status).toBe(400);
    expect((res.body as EnquiryResponseBody).field).toBe("location");
    expect(await db.job.count()).toBe(jobs);
  });

  test("AC8: a Places pick still needs its placeId", async () => {
    const res = await request(app).post("/api/enquiries").send(
      validBody({ location: { suburb: "Joondalup", state: "WA", country: "AU", postcode: "6027", lat: -31.7, lng: 115.7 } }),
    );
    expect(res.status).toBe(400);
    expect((res.body as EnquiryResponseBody).field).toBe("location");
  });
});

describe("3002 AC3 -- an out-of-reach enquiry is a normal new job", () => {
  test("3002 AC3: Karl's Joondalup enquiry is accepted as status new and stores nothing about coverage", async () => {
    const res = await request(app).post("/api/enquiries").send(validBody());
    expect(res.status).toBe(201);
    const reference = (res.body as EnquiryResponseBody).reference ?? "";
    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(job.status).toBe("new");
    expect(Object.keys(job).filter((key) => /coverage|tier|reach/i.test(key))).toEqual([]);
    expect(JSON.stringify(job.serviceLocation)).not.toMatch(/tier|coverage|reach/i);
  });
});
