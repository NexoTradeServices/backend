// Feature 9002 -- test data hygiene
//
// AC1  a record created during a request carrying `ts-test-run=e2e` is
//      labelled `e2e`; the same request without the cookie is unlabelled
// AC2  nested creates are labelled (a contractor with its specialties, a
//      connectOrCreate, a createMany, an upsert); a test sign-in under the
//      signal labels its session
// AC3  with NODE_ENV=production the cookie is ignored, POST
//      /api/test-data/sweep answers 404, and the sweep function, the label
//      and the command refuse (AC3b is in recaptcha.test.ts)
// AC4  the sweep removes every `e2e` row and every row pointing at one (even an
//      unlabelled child), removes nothing unlabelled that does not point at a
//      labelled row, leaves the seeded cast exactly as it was, and refuses a
//      database whose name does not end in _dev or _test
// AC5  sweeping `uat-9002` touches no `e2e` row, and the reverse
// AC6  a UAT data script run with make labels everything it creates
//      `uat-<id>`; clear removes all of it and nothing else
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { managedTableNames, testClient, testDatabaseUrl, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { DEV_PASSWORD, seedAuthFixtures } from "../src/db/seed/auth.js";
import { buildAuth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { runWithLabel, testRunSignal } from "../src/test-data/label.js";
import { mountTestDataRoutes } from "../src/test-data/routes.js";
import { sweepTestData } from "../src/test-data/sweep.js";
import { clearUatData, makeUatData, type UatScript } from "../src/db/uat/pattern.js";
import { make as make9002 } from "../src/db/uat/9002-test-data-hygiene.js";
import { nextReference } from "../src/db/reference.js";
import type { PrismaClient } from "../src/db/client.js";

const TSX_BIN = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const BACKEND_ROOT = new URL("../", import.meta.url).pathname;

let db: PrismaClient;

/** The same stack index.ts mounts, in the same order -- built under whatever NODE_ENV is set now. */
function buildApp(): Express {
  const auth = buildAuth({ client: db });
  const app = express();
  app.use(testRunSignal);
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  mountTestDataRoutes(app, db);
  app.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
  return app;
}

function enquiryBody(email: string): Record<string, unknown> {
  return {
    name: "Karl",
    email,
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
    preferredDate: "2026-09-09",
    preferredWindow: "morning",
    description: "Kitchen tap won't stop dripping.",
    marketingEmail: false,
    marketingSms: false,
    recaptchaToken: "fixture-token",
  };
}

async function labelOf(table: "customer" | "job" | "session" | "user" | "contractor" | "contractorSpecialty" | "contractorServedPostcode" | "notification", where: Record<string, unknown>): Promise<(string | null)[]> {
  const rows = await (db[table] as unknown as { findMany(args: unknown): Promise<{ testData: string | null }[]> }).findMany({ where });
  return rows.map((row) => row.testData);
}

async function jobFor(customerId: string, reference: string): Promise<{ id: string }> {
  const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  return db.job.create({
    data: {
      reference,
      customerId,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.07, lng: 115.78, placeId: "x" },
      timezone: "Australia/Perth",
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date(),
    },
  });
}

/** Every row of every table, as JSON, ordered by id -- the cast as it stands. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of await managedTableNames(db)) {
    out[table] = await db.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY t.id`);
  }
  return out;
}

async function countLabelled(label: string): Promise<number> {
  let total = 0;
  for (const table of await managedTableNames(db)) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE "testData" = $1`, label);
    total += Number(rows[0]?.n ?? 0);
  }
  return total;
}

beforeAll(() => {
  db = testClient();
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AC1 -- the test-run cookie labels what a request creates", () => {
  test("AC1: an enquiry carrying ts-test-run=e2e labels its customer, job and notifications; without it nothing is labelled", async () => {
    const app = buildApp();

    const labelled = await request(app).post("/api/enquiries").set("Cookie", "ts-test-run=e2e").send(enquiryBody("e2e-karl@idelta.com.au"));
    expect(labelled.status).toBe(201);
    const reference = (labelled.body as { reference: string }).reference;

    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(job.testData).toBe("e2e");
    expect(await labelOf("customer", { email: "e2e-karl@idelta.com.au" })).toEqual(["e2e"]);
    const notices = await labelOf("notification", { jobId: job.id });
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((label) => label === "e2e")).toBe(true);

    const plain = await request(app).post("/api/enquiries").send(enquiryBody("plain-karl@idelta.com.au"));
    expect(plain.status).toBe(201);
    const plainJob = await db.job.findUniqueOrThrow({ where: { reference: (plain.body as { reference: string }).reference } });
    expect(plainJob.testData).toBeNull();
    expect(await labelOf("customer", { email: "plain-karl@idelta.com.au" })).toEqual([null]);
  });

  test("AC1: the cookie is found among other cookies, and a label that is not a label is ignored", async () => {
    const app = buildApp();
    const found = await request(app).post("/api/enquiries").set("Cookie", "a=1; ts-test-run=e2e; b=2").send(enquiryBody("among@idelta.com.au"));
    expect(found.status).toBe(201);
    expect(await labelOf("customer", { email: "among@idelta.com.au" })).toEqual(["e2e"]);

    const junk = await request(app).post("/api/enquiries").set("Cookie", "ts-test-run=Not%20A%20Label!").send(enquiryBody("junk@idelta.com.au"));
    expect(junk.status).toBe(201);
    expect(await labelOf("customer", { email: "junk@idelta.com.au" })).toEqual([null]);
  });
});

describe("AC2 -- nested creates and sign-ins are labelled", () => {
  test("AC2: a contractor created with its specialties and login under the label has every row labelled", async () => {
    const contractor = await runWithLabel("e2e", () =>
      db.contractor.create({
        data: {
          code: "CON-9001",
          name: "E2E Plumber",
          abn: "51000000000",
          phone: "0400 000 001",
          email: "e2e-plumber@idelta.com.au",
          address: "Perth WA 6000",
          coreLocation: { suburb: "Perth", state: "WA", postcode: "6000", lat: -31.95, lng: 115.86 },
          user: { create: { name: "E2E Plumber", email: "e2e-plumber@idelta.com.au", role: "contractor" } },
          specialties: {
            create: [
              { trade: "Plumbing", contractorCalloutRate: 10_000, contractorStandardRate: 8_000, licenceNumber: "PL-1", licenceExpiry: new Date("2030-01-01") },
              { trade: "Electrical", contractorCalloutRate: 10_000, contractorStandardRate: 8_000, licenceNumber: "EL-1", licenceExpiry: new Date("2030-01-01") },
            ],
          },
          servedPostcodes: { createMany: { data: [{ postcode: "6000" }, { postcode: "6001" }] } },
        },
      }),
    );

    expect(contractor.testData).toBe("e2e");
    expect(await labelOf("user", { email: "e2e-plumber@idelta.com.au" })).toEqual(["e2e"]);
    expect(await labelOf("contractorSpecialty", { contractorId: contractor.id })).toEqual(["e2e", "e2e"]);
    expect(await labelOf("contractorServedPostcode", { contractorId: contractor.id })).toEqual(["e2e", "e2e"]);
  });

  test("AC2: connectOrCreate and upsert label their create half, and leave an existing row alone", async () => {
    await runWithLabel("e2e", async () => {
      await db.customer.upsert({
        where: { email: "upsert@idelta.com.au" },
        create: { code: "CUS-9001", name: "Upsert", email: "upsert@idelta.com.au" },
        update: {},
      });
      // The cast's Sarah exists: the update half changes nothing and the label never lands on her.
      await db.customer.upsert({
        where: { email: "sarah@idelta.com.au" },
        create: { code: "CUS-9002", name: "Never", email: "sarah@idelta.com.au" },
        update: {},
      });
      await db.contractor.create({
        data: {
          code: "CON-9002",
          name: "Connect",
          abn: "51000000000",
          phone: "0400 000 002",
          email: "connect@idelta.com.au",
          address: "Perth WA 6000",
          coreLocation: { suburb: "Perth", state: "WA", postcode: "6000", lat: -31.95, lng: 115.86 },
          user: {
            connectOrCreate: {
              where: { email: "connect@idelta.com.au" },
              create: { name: "Connect", email: "connect@idelta.com.au", role: "contractor" },
            },
          },
        },
      });
    });
    expect(await labelOf("customer", { email: "upsert@idelta.com.au" })).toEqual(["e2e"]);
    expect(await labelOf("customer", { email: "sarah@idelta.com.au" })).toEqual([null]);
    expect(await labelOf("user", { email: "connect@idelta.com.au" })).toEqual(["e2e"]);
  });

  test("AC2: a sign-in under the signal labels the session it creates; without it the session is unlabelled", async () => {
    const app = buildApp();
    const signedIn = await request(app).post("/api/auth/sign-in/email").set("Cookie", "ts-test-run=e2e").send({ email: "mike@idelta.com.au", password: DEV_PASSWORD });
    expect(signedIn.status).toBe(200);
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    expect(await labelOf("session", { userId: mike.id })).toEqual(["e2e"]);
    expect(mike.testData).toBeNull();

    const plain = await request(app).post("/api/auth/sign-in/email").send({ email: "bob@idelta.com.au", password: DEV_PASSWORD });
    expect(plain.status).toBe(200);
    const bob = await db.user.findUniqueOrThrow({ where: { email: "bob@idelta.com.au" } });
    expect(await labelOf("session", { userId: bob.id })).toEqual([null]);
  });
});

describe("AC3 -- production ignores the signal and never sweeps", () => {
  test("AC3: with NODE_ENV=production the cookie is ignored, the sweep route is absent, and the sweep, the label and the command refuse", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = buildApp();

    const res = await request(app).post("/api/enquiries").set("Cookie", "ts-test-run=e2e").send(enquiryBody("prod-karl@idelta.com.au"));
    expect(res.status).toBe(201);
    expect(await labelOf("customer", { email: "prod-karl@idelta.com.au" })).toEqual([null]);

    const route = await request(app).post("/api/test-data/sweep").send({ label: "e2e" });
    expect(route.status).toBe(404);

    await expect(sweepTestData(db, "e2e")).rejects.toThrow(/NODE_ENV=production/);
    expect(() => runWithLabel("e2e", () => 1)).toThrow(/NODE_ENV=production/);

    expect(() =>
      execFileSync(TSX_BIN, ["src/test-data/sweep-cli.ts", "e2e"], {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl(), NODE_ENV: "production" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow(/NODE_ENV=production/);
  });

  test("AC3: outside production the sweep route is there, and refuses a label that is not a label", async () => {
    const app = buildApp();
    const bad = await request(app).post("/api/test-data/sweep").send({ label: "" });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/api/test-data/sweep").send({ label: "e2e" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ label: "e2e", total: 0 });
  });
});

describe("AC4 -- the sweep", () => {
  test("AC4: removes every e2e row and every row pointing at one, nothing else, and leaves the cast exactly as it was", async () => {
    const before = await snapshot();

    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const plumbing = bob.specialties.find((s) => s.trade === "Plumbing");
    if (plumbing === undefined) throw new Error("fixture Bob has no Plumbing specialty");

    // A browser test's job for the cast's Sarah, and its login's session -- labelled.
    const job = await runWithLabel("e2e", async () => {
      const made = await jobFor(sarah.id, await nextReference("JOB", db));
      await db.session.create({
        data: { token: "e2e-token", userId: bob.userId, expiresAt: new Date(Date.now() + 60_000) },
      });
      return made;
    });
    // Children the labelling missed: unlabelled rows pointing at the labelled job.
    const assignment = await db.assignment.create({ data: { jobId: job.id, contractorId: bob.id, specialtyId: plumbing.id } });
    await db.calendarEvent.create({
      data: { contractorId: bob.id, startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), type: "job", jobId: job.id, assignmentId: assignment.id },
    });
    await db.attachment.create({
      data: { jobId: job.id, assignmentId: assignment.id, uploadedByRole: "customer", storageKey: "k", fileName: "f.jpg" },
    });
    // An unlabelled row that points at nothing labelled: it must stay.
    const stray = await db.customer.create({ data: { code: "CUS-9100", name: "Stray", email: "stray@idelta.com.au" } });

    const result = await sweepTestData(db, "e2e");

    expect(result.removed).toMatchObject({ Job: 1, Assignment: 1, CalendarEvent: 1, Attachment: 1, Session: 1 });
    expect(await db.job.count({ where: { id: job.id } })).toBe(0);
    expect(await db.assignment.count({ where: { id: assignment.id } })).toBe(0);
    expect(await db.customer.count({ where: { id: stray.id } })).toBe(1);

    // The whole database is the cast plus the stray, as before -- row for row.
    const after = await snapshot();
    const { Customer: customersAfter, ...restAfter } = after;
    const { Customer: customersBefore, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(customersAfter).toHaveLength((customersBefore ?? []).length + 1);
    expect(await countLabelled("e2e")).toBe(0);
  });

  test("AC4: an invoice and its assignment point at each other (Feature 6001) -- the sweep breaks the loop and clears both, with the invoice's lines and messages", async () => {
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const plumbing = bob.specialties.find((s) => s.trade === "Plumbing");
    if (plumbing === undefined) throw new Error("fixture Bob has no Plumbing specialty");
    const job = await runWithLabel("uat-6001", async () => jobFor(sarah.id, await nextReference("JOB", db)));
    const assignment = await db.assignment.create({ data: { jobId: job.id, contractorId: bob.id, specialtyId: plumbing.id, status: "completed" } });
    const invoice = await db.invoice.create({
      data: {
        reference: await nextReference("INV", db),
        jobId: job.id,
        assignmentId: assignment.id,
        customerId: sarah.id,
        amount: 25_000,
        labourAmount: 25_000,
        materialsAmount: 0,
        gstApplied: false,
        dueAt: new Date(),
        billedTo: { name: "Sarah Chen" },
        lines: { create: [{ kind: "labour", description: "Call-out", qty: 1, unitPrice: 25_000, lineTotal: 25_000 }] },
      },
    });
    await db.assignment.update({ where: { id: assignment.id }, data: { invoiceId: invoice.id } });
    await db.notification.create({
      data: { recipientType: "customer", recipientId: sarah.id, channel: "email", type: "invoice", category: "transactional", relatedType: "invoice", relatedId: invoice.id, jobId: job.id, idempotencyKey: `invoice:invoice:${invoice.id}:email` },
    });

    const result = await sweepTestData(db, "uat-6001");

    expect(result.removed).toMatchObject({ Job: 1, Assignment: 1, Invoice: 1, InvoiceLine: 1, Notification: 1 });
    expect(await db.invoice.count()).toBe(0);
    expect(await db.assignment.count({ where: { id: assignment.id } })).toBe(0);
    expect(await db.customer.count({ where: { id: sarah.id } })).toBe(1);
  });

  test("AC4: refuses a database whose name does not end in _dev or _test, touching nothing", async () => {
    const calls: string[] = [];
    const elsewhere = {
      $queryRaw: () => {
        calls.push("queryRaw");
        return Promise.resolve([{ name: "tradeservice" }]);
      },
      $transaction: () => {
        calls.push("transaction");
        return Promise.resolve();
      },
    } as unknown as PrismaClient;
    await expect(sweepTestData(elsewhere, "e2e")).rejects.toThrow(/must end in _dev or _test/);
    expect(calls).toEqual(["queryRaw"]);
  });
});

describe("AC5 -- labels are kept apart", () => {
  test("AC5: sweeping uat-9002 touches no e2e row, and the reverse", async () => {
    await runWithLabel("e2e", () => db.customer.create({ data: { code: "CUS-9201", name: "E2E", email: "e2e@idelta.com.au" } }));
    await runWithLabel("uat-9002", () => db.customer.create({ data: { code: "CUS-9202", name: "UAT", email: "uat@idelta.com.au" } }));

    await sweepTestData(db, "uat-9002");
    expect(await labelOf("customer", { email: "e2e@idelta.com.au" })).toEqual(["e2e"]);
    expect(await labelOf("customer", { email: "uat@idelta.com.au" })).toEqual([]);

    await runWithLabel("uat-9002", () => db.customer.create({ data: { code: "CUS-9203", name: "UAT", email: "uat@idelta.com.au" } }));
    await sweepTestData(db, "e2e");
    expect(await labelOf("customer", { email: "e2e@idelta.com.au" })).toEqual([]);
    expect(await labelOf("customer", { email: "uat@idelta.com.au" })).toEqual(["uat-9002"]);
  });
});

describe("AC6 -- the UAT data script pattern", () => {
  test("AC6: make labels everything it creates uat-<id>; clear removes it and what hung off it, and puts the cast back", async () => {
    const sarahBefore = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const plumbing = bob.specialties.find((s) => s.trade === "Plumbing");
    if (plumbing === undefined) throw new Error("fixture Bob has no Plumbing specialty");
    const restoreCast = vi.fn(async (client: PrismaClient) => {
      await client.customer.update({ where: { code: "CUS-1050" }, data: { phone: sarahBefore.phone } });
    });
    const sample: UatScript = {
      async make(client) {
        await client.customer.update({ where: { code: "CUS-1050" }, data: { phone: "0400 999 999" } });
        return make9002(client);
      },
      restoreCast,
    };

    const lines = await makeUatData(db, "9002-test-data-hygiene", sample);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^JOB-\d+ - Sarah's leaking-tap job in Hilton$/);
    const reference = (lines[0] ?? "").split(" ")[0] ?? "";
    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(job.testData).toBe("uat-9002");

    // What the owner does during the check: dispatch it to Bob (an unlabelled assignment), edit nothing else.
    await db.assignment.create({ data: { jobId: job.id, contractorId: bob.id, specialtyId: plumbing.id } });
    // An unrelated, unlabelled record stays.
    await db.customer.create({ data: { code: "CUS-9300", name: "Unrelated", email: "unrelated@idelta.com.au" } });
    expect((await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).phone).toBe("0400 999 999");

    const result = await clearUatData(db, "9002-test-data-hygiene", sample);
    expect(result.removed).toMatchObject({ Job: 1, Assignment: 1 });
    expect(await db.job.count({ where: { reference } })).toBe(0);
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
    expect(await countLabelled("uat-9002")).toBe(0);
    expect(restoreCast).toHaveBeenCalledTimes(1);
    expect((await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).phone).toBe(sarahBefore.phone);
    expect(await db.customer.count({ where: { code: "CUS-9300" } })).toBe(1);
  });

  test("AC6: a name that is not <id>-<slug> is refused", async () => {
    await expect(makeUatData(db, "../etc/passwd", { make: () => Promise.resolve([]) })).rejects.toThrow(/not a UAT script name/);
  });

  test("AC6: `npm run uat -- 9002-test-data-hygiene make|clear` runs the feature's script", () => {
    const run = (mode: string): string =>
      execFileSync(TSX_BIN, ["src/db/uat/run.ts", "9002-test-data-hygiene", mode], {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    expect(run("make")).toMatch(/made 1 record\(s\) labelled "uat-9002"/);
    // make twice never doubles up
    expect(run("make")).toMatch(/made 1 record\(s\)/);
    expect(run("clear")).toMatch(/cleared "uat-9002": 1 rows removed/);
  });
});
