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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
    expect((res.body as EnquiryResponseBody).reference).toBe("JOB-1052");

    const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1052" } });
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
    expect(customer.code).toBe("CUS-1054");
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

describe("AC2 -- the weekend auto-bump", () => {
  test("AC2: a Saturday date freezes the weekend multiplier on the job", async () => {
    // 2026-09-12 is a Saturday.
    const res = await request(app)
      .post("/api/enquiries")
      .send(validBody({ preferredDate: "2026-09-12" }));
    expect(res.status).toBe(201);

    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as EnquiryResponseBody).reference } });
    expect(job.customerCalloutRate).toBe(37_500);
    expect(job.customerStandardRate).toBe(27_000);
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
