// Feature 4004 -- pre-dispatch edit (PUT /api/jobs/:reference/request)
//
// AC1  Sarah's new plumbing job: trade -> Electrical, window -> afternoon, new description; the job reads
//      the new values, carries Electrical's current rates, and keeps her answers to the plumbing questions
// AC3  Karl's new job in Joondalup (no site address): the suburb -> Fremantle moves the postcode, the
//      location and the zone, and the queue's coverage tier follows (out of reach -> covered)
// AC4  a new job WITH a site address refuses a suburb change (409); the other fields still save
// AC5  a dispatched job is refused with the locked words; so is an edit that lost the race to a dispatch
// AC6  a date before today, or an empty description, is refused with the field's error; nothing changes
// AC7  an edit queues no notification
// AC8  only ops and the owner edit: a contractor is 403, logged out is 401
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
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-4004", "email");

const HILTON = { suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const JOONDALUP = { suburb: "Joondalup", state: "WA", country: "AU", postcode: "6027", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" };
const FREMANTLE = { suburb: "Fremantle", state: "WA", country: "AU", postcode: "6160", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" };
const ADELAIDE = { suburb: "Adelaide", state: "SA", country: "AU", postcode: "5000", lat: -34.9285, lng: 138.6007, placeId: "fixture-place-adelaide" };

function tomorrow(): string {
  return new Date(Date.now() + 36 * 60 * 60_000).toISOString().slice(0, 10);
}

async function signIn(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return (cookies.find((c) => c.includes("better-auth.session_token=")) ?? "").split(";")[0] ?? "";
}

async function makeJob(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post("/api/enquiries")
    .send({
      name: "Sarah Chen",
      email: "sarah@idelta.com.au",
      phone: "0400 001 050",
      location: HILTON,
      trade: "Plumbing",
      selectedOptions: ["Where in the property is it?: Kitchen", "What brand is it?: Methven"],
      preferredDate: tomorrow(),
      preferredWindow: "morning",
      description: "Mixer tap leaking.",
      marketingEmail: false,
      marketingSms: false,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return (res.body as { reference: string }).reference;
}

const edit = (cookie: string, reference: string, body: Record<string, unknown>) =>
  request(app).put(`/api/jobs/${reference}/request`).set("Cookie", cookie).send(body);

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
  app.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
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

describe("AC1 -- a new trade brings its rates", () => {
  test("AC1: trade, window and description change; the rates are Electrical's; the plumbing answers stay", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    const electrical = await db.serviceType.findUniqueOrThrow({ where: { trade: "Electrical" } });
    const res = await edit(mike, reference, { trade: "Electrical", preferredWindow: "afternoon", description: "  Lights keep tripping.  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ trade: "Electrical", windowLabel: "afternoon 12:00-17:00", preferredWindow: "afternoon", description: "Lights keep tripping." });
    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(job.serviceTypeId).toBe(electrical.id);
    expect(job.customerCalloutRate).toBe(electrical.customerCalloutRate);
    expect(job.customerStandardRate).toBe(electrical.customerStandardRate);
    expect(job.selectedOptions).toEqual(["Where in the property is it?: Kitchen", "What brand is it?: Methven"]);
    expect((res.body as { answers: string[] }).answers).toHaveLength(2);
  });

  test("only the fields sent change", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    const before = await db.job.findUniqueOrThrow({ where: { reference } });
    expect((await edit(mike, reference, { preferredWindow: "evening" })).status).toBe(200);
    const after = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(after.preferredWindow).toBe("evening");
    expect({ ...after, preferredWindow: before.preferredWindow, updatedAt: before.updatedAt }).toEqual(before);
  });

  test("an unknown trade is 400 on trade", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const res = await edit(mike, await makeJob(), { trade: "Basket weaving" });
    expect(res.status).toBe(400);
    expect((res.body as { field: string }).field).toBe("trade");
  });
});

describe("AC3 -- the suburb", () => {
  test("AC3: Joondalup -> Fremantle moves the postcode, location and zone; the queue's tier follows", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob({ name: "Karl", email: "karl@idelta.com.au", location: JOONDALUP });
    const tier = async () => {
      const res = await request(app).get("/api/jobs").set("Cookie", mike);
      return (res.body as { rows: { reference: string; coverage: { tier: string } | null }[] }).rows.find((r) => r.reference === reference)?.coverage?.tier;
    };
    expect(await tier()).toBe("out_of_reach");

    const res = await edit(mike, reference, { location: FREMANTLE });
    expect(res.status).toBe(200);
    const job = await db.job.findUniqueOrThrow({ where: { reference } });
    expect(job.postcode).toBe("6160");
    expect(job.serviceLocation).toMatchObject({ suburb: "Fremantle", lat: FREMANTLE.lat, lng: FREMANTLE.lng });
    expect(job.timezone).toBe("Australia/Perth");
    expect(await tier()).toBe("covered");
  });

  test("a suburb in another state re-freezes the zone", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    expect((await edit(mike, reference, { location: ADELAIDE })).status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { reference } })).timezone).toBe("Australia/Adelaide");
  });

  test("a { suburbId } pick works too", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const suburb = await db.suburb.create({ data: { name: "Fremantle", slug: "fremantle-6160-wa", postcode: "6160", state: "WA", centroidLat: -32.0569, centroidLng: 115.7439 } });
    const reference = await makeJob();
    expect((await edit(mike, reference, { location: { suburbId: suburb.id } })).status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { reference } })).postcode).toBe("6160");
  });

  test("AC4: with a site address the suburb is refused (409); other fields still save", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    await db.job.update({ where: { reference }, data: { siteAddress: { street: "3 Rennie Crescent", ...HILTON } } });
    const refused = await edit(mike, reference, { location: FREMANTLE });
    expect(refused.status).toBe(409);
    expect((await db.job.findUniqueOrThrow({ where: { reference } })).postcode).toBe("6163");
    expect((await edit(mike, reference, { preferredWindow: "evening" })).status).toBe(200);
  });
});

describe("AC5 -- locked once dispatched", () => {
  test("AC5: JOB-1042 (dispatched) is refused with the locked words and nothing changes", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const before = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    const res = await edit(mike, "JOB-1042", { description: "Changed." });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe("This job has been dispatched - its details are locked.");
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).description).toBe(before.description);
  });

  test("AC5: an edit that lost the race to a dispatch is refused on Save", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    await db.job.update({ where: { reference }, data: { status: "assigned" } });
    expect((await edit(mike, reference, { preferredWindow: "evening" })).status).toBe(409);
  });

  test("an unknown job is 404", async () => {
    const mike = await signIn("mike@idelta.com.au");
    expect((await edit(mike, "JOB-9999999", { description: "x" })).status).toBe(404);
  });
});

describe("AC6/AC7/AC8", () => {
  test("AC6: a date before today and an empty description are refused with the field's error", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    const past = await edit(mike, reference, { preferredDate: "2020-01-01" });
    expect(past.status).toBe(400);
    expect((past.body as { field: string }).field).toBe("preferredDate");
    const empty = await edit(mike, reference, { description: "   " });
    expect(empty.status).toBe(400);
    expect((empty.body as { field: string }).field).toBe("description");
    expect((await db.job.findUniqueOrThrow({ where: { reference } })).description).toBe("Mixer tap leaking.");
    expect((await edit(mike, reference, { preferredDate: tomorrow() })).status).toBe(200);
  });

  test("AC7: an edit queues no notification", async () => {
    const mike = await signIn("mike@idelta.com.au");
    const reference = await makeJob();
    const before = await db.notification.count();
    await edit(mike, reference, { trade: "Electrical", location: FREMANTLE, description: "Different." });
    expect(await db.notification.count()).toBe(before);
  });

  test("AC8: the owner edits; a contractor is 403; logged out is 401", async () => {
    const reference = await makeJob();
    expect((await edit(await signIn("owner@idelta.com.au"), reference, { preferredWindow: "evening" })).status).toBe(200);
    expect((await edit(await signIn("bob@idelta.com.au"), reference, { preferredWindow: "morning" })).status).toBe(403);
    expect((await request(app).put(`/api/jobs/${reference}/request`).send({ preferredWindow: "morning" })).status).toBe(401);
  });
});
