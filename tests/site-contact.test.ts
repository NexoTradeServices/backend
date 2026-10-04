// Feature 4008 -- site contact
//
// AC1  the migration: Job.siteContact empty on every existing job, `site_contact` accepted, the seed runs clean
// AC2  Lena saved on JOB-1042; Sarah's Customer row unchanged
// AC3  a name with no phone is refused naming the phone; nothing saved, an address change included
// AC4  a phone with no name is refused naming the name; nothing saved
// AC5  an email "lena@" is refused naming the email; nothing saved
// AC6  no email -> stored with no email key
// AC7  all three cleared -> empty again
// AC8  save, change and clear create no Notification row
// AC9  after dispatch (assigned, site locked) the phone can change
// AC10 completed and cancelled jobs refuse a change; the stored value stays
// AC11 Bob's email and text carry "Site contact: Lena Park, 0400 002 050"
// AC12 with none, both carry "Site contact: Sarah Chen"
// AC13 the job page lists every Notification of the job, newest first, none of another job's
// AC14 each message names its recipient per type
// AC15 each message reads its status in the four words; a failed one carries its error
// AC16 each message shows its channel, its business-clock time and its plain name; an unnamed type falls back
// AC19 the seed gives JOB-1042 Lena when it has none; a second run changes nothing
// AC20 a completed job's read says closed and carries the values
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
import { devTextsRoutes } from "../src/notifications/dev-texts-routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { nextReference } from "../src/db/reference.js";
import { Prisma } from "../src/generated/prisma/client.js";
import type { JobStatus } from "../src/generated/prisma/enums.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

// SMS gets no provider here (the console adapter), so Bob's text is read back
// through the interim /dev/texts page -- same as 4002's tests.
const email = recordingAdapter("test-email-4008", "email");

const LENA = { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" };
const HILTON = { suburb: "Hilton", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE = {
  street: "14 Marine Terrace",
  suburb: "Fremantle",
  state: "WA",
  country: "AU",
  postcode: "6160",
  lat: -32.0569,
  lng: 115.7439,
  placeId: "test-place-14-marine-terrace",
};

interface MessageBody {
  id: string;
  to: string;
  channel: string;
  whenLabel: string;
  what: string;
  status: string;
  statusLabel: string;
  error: string | null;
}
interface DetailBody {
  reference: string;
  status: JobStatus;
  siteContact: { name: string; phone: string; email: string | null } | null;
  closed: boolean;
  messages: MessageBody[];
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function mike(): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: "mike@idelta.com.au", password: DEV_PASSWORD });
  return cookieHeader(res);
}

function saveAddresses(cookie: string, reference: string, body: unknown) {
  return request(app).put(`/api/jobs/${reference}/addresses`).set("Cookie", cookie).send(body as object);
}

async function detail(cookie: string, reference: string): Promise<DetailBody> {
  const res = await request(app).get(`/api/jobs/${reference}`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as DetailBody;
}

async function storedContact(reference: string): Promise<unknown> {
  return (await db.job.findUniqueOrThrow({ where: { reference } })).siteContact;
}

/** A test's own job for Sarah (CUS-1050), on top of the seeded cast. */
async function makeJob(opts: { status?: JobStatus; siteContact?: Record<string, string> } = {}): Promise<{ id: string; reference: string }> {
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const job = await db.job.create({
    data: {
      reference: await nextReference("JOB", db),
      customerId: sarah.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: HILTON.postcode,
      serviceLocation: { suburb: HILTON.suburb, state: "WA", country: "AU", lat: HILTON.lat, lng: HILTON.lng, placeId: HILTON.placeId },
      timezone: "Australia/Perth",
      description: "A test job.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date("2027-03-15T00:00:00.000Z"),
      status: opts.status ?? "new",
      ...(opts.siteContact ? { siteContact: opts.siteContact } : {}),
    },
  });
  return { id: job.id, reference: job.reference };
}

function dispatch(cookie: string, reference: string) {
  return request(app)
    .post(`/api/jobs/${reference}/dispatch`)
    .set("Cookie", cookie)
    .send({ contractorCode: "CON-014", date: "2027-03-15", startMinutes: 420, holdMinutes: 60, emergency: false });
}

async function bobsText(reference: string): Promise<string | undefined> {
  const res = await request(app).get("/api/dev/texts");
  const blocks = (res.body as { blocks: { jobReference: string; texts: { recipientBadge: string; text: string }[] }[] }).blocks;
  return blocks.find((b) => b.jobReference === reference)?.texts.find((t) => t.recipientBadge === "CONTRACTOR SMS")?.text;
}

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
  app.use("/api/dev", devTextsRoutes(db));
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

describe("AC1 -- the migration", () => {
  test("AC1: Job.siteContact exists and is empty on every job but the seeded JOB-1042; site_contact is an accepted recipient type; the seed runs clean on top", async () => {
    const columns = await db.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'Job' AND column_name = 'siteContact'`;
    expect(columns).toEqual([{ column_name: "siteContact", is_nullable: "YES" }]);

    const others = await db.job.findMany({ where: { reference: { not: "JOB-1042" } }, select: { siteContact: true } });
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((job) => job.siteContact === null)).toBe(true);

    const job = await makeJob();
    const row = await db.notification.create({
      data: {
        recipientType: "site_contact",
        recipientId: job.id,
        channel: "sms",
        type: "job_dispatched",
        category: "transactional",
        idempotencyKey: "ac1-site-contact",
      },
    });
    expect(row.recipientType).toBe("site_contact");

    await expect(seedFixtures(db)).resolves.toBeDefined();
  });
});

describe("AC2-AC7 -- what the save takes and refuses", () => {
  test("AC2: Mike saves Lena on JOB-1042 -- Job.siteContact holds all three and Sarah's Customer row is unchanged", async () => {
    await db.job.update({ where: { reference: "JOB-1042" }, data: { siteContact: { name: "Someone Else", phone: "1" } } });
    const before = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const res = await saveAddresses(await mike(), "JOB-1042", { siteContact: LENA });
    expect(res.status).toBe(200);
    expect(await storedContact("JOB-1042")).toEqual(LENA);
    expect(await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).toEqual(before);
  });

  test("AC3: a name with no phone is refused naming the phone, and an address change sent with it is not saved either", async () => {
    const job = await makeJob();
    const before = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const res = await saveAddresses(await mike(), job.reference, {
      billingAddress: FREMANTLE,
      siteContact: { name: "Lena Park", phone: "", email: "" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "siteContactPhone", error: "Required." });
    expect(await storedContact(job.reference)).toBeNull();
    expect(await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).toEqual(before);
  });

  test("AC4: a phone with no name is refused naming the name; nothing saved", async () => {
    const job = await makeJob();
    const res = await saveAddresses(await mike(), job.reference, { siteContact: { name: "  ", phone: "0400 002 050" } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "siteContactName", error: "Required." });
    expect(await storedContact(job.reference)).toBeNull();
  });

  test("AC5: the email \"lena@\" is refused naming the email; nothing saved", async () => {
    const job = await makeJob();
    const res = await saveAddresses(await mike(), job.reference, {
      siteContact: { name: "Lena Park", phone: "0400 002 050", email: "lena@" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "siteContactEmail" });
    expect(await storedContact(job.reference)).toBeNull();
  });

  test("AC6: name and phone with no email are stored, trimmed, with no email key", async () => {
    const job = await makeJob();
    const res = await saveAddresses(await mike(), job.reference, {
      siteContact: { name: " Lena Park ", phone: " 0400 002 050", email: "   " },
    });
    expect(res.status).toBe(200);
    const stored = await storedContact(job.reference);
    expect(stored).toEqual({ name: "Lena Park", phone: "0400 002 050" });
    expect(Object.keys(stored as object)).not.toContain("email");
  });

  test("AC7: clearing all three on a job that had Lena leaves it empty again", async () => {
    const job = await makeJob({ siteContact: LENA });
    const res = await saveAddresses(await mike(), job.reference, { siteContact: { name: "", phone: "", email: "" } });
    expect(res.status).toBe(200);
    expect(await storedContact(job.reference)).toBeNull();
    expect((res.body as { job: DetailBody }).job.siteContact).toBeNull();
  });
});

describe("AC8 -- a change sends nothing", () => {
  test("AC8: saving, changing and clearing a site contact creates no Notification row", async () => {
    const job = await makeJob();
    const cookie = await mike();
    const before = await db.notification.count();
    await saveAddresses(cookie, job.reference, { siteContact: LENA });
    await saveAddresses(cookie, job.reference, { siteContact: { ...LENA, phone: "0400 002 051" } });
    await saveAddresses(cookie, job.reference, { siteContact: { name: "", phone: "", email: "" } });
    await drainOnce(db);
    expect(await db.notification.count()).toBe(before);
    expect(email.sent).toHaveLength(0);
  });
});

describe("AC9-AC10 -- until the job closes", () => {
  test("AC9: on JOB-1042 after dispatch (assigned, site locked) Mike changes Lena's phone -- saved", async () => {
    const before = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    expect(before.status).toBe("assigned");
    const res = await saveAddresses(await mike(), "JOB-1042", { siteContact: { ...LENA, phone: "0400 002 099" } });
    expect(res.status).toBe(200);
    expect(await storedContact("JOB-1042")).toEqual({ ...LENA, phone: "0400 002 099" });
  });

  test.each(["completed", "cancelled"] as const)("AC10: on a %s job a site contact change is refused and the stored value stays", async (status) => {
    const job = await makeJob({ status, siteContact: LENA });
    const res = await saveAddresses(await mike(), job.reference, { siteContact: { ...LENA, phone: "0400 002 099" } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ field: "siteContact" });
    expect(await storedContact(job.reference)).toEqual(LENA);
    const cleared = await saveAddresses(await mike(), job.reference, { siteContact: { name: "", phone: "", email: "" } });
    expect(cleared.status).toBe(409);
    expect(await storedContact(job.reference)).toEqual(LENA);
  });
});

describe("AC11-AC12 -- Bob's line", () => {
  test("AC11: dispatching with Lena as site contact -- Bob's email and text both carry \"Site contact: Lena Park, 0400 002 050\"", async () => {
    const job = await makeJob({ siteContact: LENA });
    const res = await dispatch(await mike(), job.reference);
    expect(res.status).toBe(201);
    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "bob@idelta.com.au");
    expect(mail?.message.text).toContain("Site contact: Lena Park, 0400 002 050");
    expect(mail?.message.html).toContain("Site contact: Lena Park, 0400 002 050");
    expect(await bobsText(job.reference)).toContain("Site contact: Lena Park, 0400 002 050");
  });

  test("AC12: dispatching with no site contact -- both carry \"Site contact: Sarah Chen\"", async () => {
    const job = await makeJob();
    const res = await dispatch(await mike(), job.reference);
    expect(res.status).toBe(201);
    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "bob@idelta.com.au");
    expect(mail?.message.text).toContain("Site contact: Sarah Chen");
    expect(mail?.message.text).not.toContain("0400");
    expect(await bobsText(job.reference)).toContain("Site contact: Sarah Chen");
  });
});

describe("AC13-AC16 -- the Messages list", () => {
  // The queued site-contact row is "on_my_way": a visit message no feature has
  // named yet, so AC16's fallback to the type's own words stays provable
  // (it was slot_confirmed until 4003 gave that one a plain name).
  async function seedMessages(): Promise<void> {
    const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    const other = await makeJob();
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.notification.deleteMany({});
    const base = { category: "transactional", jobId: job.id } as const;
    await db.notification.createMany({
      data: [
        { ...base, idempotencyKey: "m1", recipientType: "customer", recipientId: sarah.id, channel: "email", type: "enquiry_confirmation", status: "delivered", sentAt: new Date("2026-09-29T01:00:00Z") },
        { ...base, idempotencyKey: "m2", recipientType: "ops", recipientId: job.id, channel: "email", type: "new_job_request", status: "sent", sentAt: new Date("2026-09-29T01:05:00Z") },
        { ...base, idempotencyKey: "m3", recipientType: "contractor", recipientId: bob.id, channel: "sms", type: "job_dispatched", status: "failed", error: "ClickSend: number unreachable", sentAt: new Date("2026-09-29T02:14:00Z") },
        { ...base, idempotencyKey: "m4", recipientType: "site_contact", recipientId: job.id, channel: "sms", type: "on_my_way", status: "queued", context: { recipientName: "Lena Park" }, createdAt: new Date("2026-09-29T03:00:00Z") },
        { category: "transactional", jobId: other.id, idempotencyKey: "m5", recipientType: "ops", recipientId: other.id, channel: "email", type: "new_job_request", status: "sent", sentAt: new Date("2026-09-29T04:00:00Z") },
      ],
    });
  }

  test("AC13: JOB-1042's read lists every Notification with its jobId, newest first, none of another job's", async () => {
    await seedMessages();
    const { messages } = await detail(await mike(), "JOB-1042");
    expect(messages.map((m) => m.what)).toEqual(["on my way", "Job dispatched", "New job request", "Enquiry received"]);
  });

  test("AC14: each message names its recipient -- Sarah Chen, Bob Reilly, Office inbox, the site contact's recorded name", async () => {
    await seedMessages();
    const { messages } = await detail(await mike(), "JOB-1042");
    expect(messages.map((m) => m.to)).toEqual(["Lena Park", "Bob Reilly", "Office inbox", "Sarah Chen"]);
  });

  test("AC15: each message reads its status in the four words, and a failed one carries its error", async () => {
    await seedMessages();
    const { messages } = await detail(await mike(), "JOB-1042");
    expect(messages.map((m) => m.statusLabel)).toEqual(["Waiting to send", "Failed", "Sent", "Delivered"]);
    expect(messages.map((m) => m.error)).toEqual([null, "ClickSend: number unreachable", null, null]);
  });

  test("AC16: each message shows its channel, its business-clock time and its plain name; an unnamed type falls back to its own words", async () => {
    await seedMessages();
    const { messages } = await detail(await mike(), "JOB-1042");
    expect(messages.map((m) => m.channel)).toEqual(["Text", "Text", "Email", "Email"]);
    // sentAt 02:14 UTC is 10:14am in Perth; the queued row shows createdAt, 03:00 UTC = 11:00am.
    expect(messages.map((m) => m.whenLabel)).toEqual(["29/09/26 11:00am", "29/09/26 10:14am", "29/09/26 9:05am", "29/09/26 9:00am"]);
    expect(messages.map((m) => m.what)).toEqual(["on my way", "Job dispatched", "New job request", "Enquiry received"]);
  });
});

describe("AC19 -- the fixture seed", () => {
  test("AC19: JOB-1042 gets Lena when it has none; a second run changes nothing", async () => {
    expect(await storedContact("JOB-1042")).toEqual(LENA);
    await db.job.update({ where: { reference: "JOB-1042" }, data: { siteContact: Prisma.JsonNull } });
    expect(await storedContact("JOB-1042")).toBeNull();
    await seedFixtures(db);
    expect(await storedContact("JOB-1042")).toEqual(LENA);
    const stamp = (await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).updatedAt;
    await seedFixtures(db);
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).updatedAt).toEqual(stamp);
  });
});

describe("AC20 -- read-only on a closed job", () => {
  test("AC20: a completed job's read says closed and carries the values; an open job's says not closed", async () => {
    const done = await makeJob({ status: "completed", siteContact: LENA });
    const cookie = await mike();
    expect(await detail(cookie, done.reference)).toMatchObject({ closed: true, siteContact: LENA });
    expect(await detail(cookie, "JOB-1042")).toMatchObject({ closed: false });
  });
});
