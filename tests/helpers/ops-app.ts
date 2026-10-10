// Test helpers -- Feature 4006, reschedule / take off / cancel.
//
// One app with the ops job routes, the respond routes and the Texts sent page, over the fixture
// seed; plus the two states every 4006 suite starts from: JOB-1042 waiting on Bob's answer
// (assigned) and JOB-1042 accepted (scheduled, Lena the site contact).
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { buildAuth } from "../../src/auth/config.js";
import { attachSession } from "../../src/auth/middleware.js";
import { authRoutes } from "../../src/auth/routes.js";
import { contractorLoginRoutes } from "../../src/auth/login-routes.js";
import { jobRoutes } from "../../src/jobs/routes.js";
import { contractorRoutes } from "../../src/contractors/routes.js";
import { respondRoutes } from "../../src/respond/routes.js";
import { devTextsRoutes } from "../../src/notifications/dev-texts-routes.js";
import { seedBase } from "../../src/db/seed/base.js";
import { seedFixtures } from "../../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../../src/db/seed/auth.js";
import { CapabilityTokenType, mintCapabilityLink } from "../../src/capability-tokens/index.js";
import { nextReference } from "../../src/db/reference.js";
import { resetReferenceSequences, truncateAll } from "./database.js";
import { setProviders, type RecordingAdapter } from "./notifications.js";
import type { PrismaClient } from "../../src/db/client.js";

export function buildOpsApp(db: PrismaClient): Express {
  const auth = buildAuth({ client: db });
  const app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/contractors", contractorRoutes(db, auth));
  app.use("/api/respond", respondRoutes(db));
  app.use("/api/dev", devTextsRoutes(db));
  return app;
}

export async function signIn(app: Express, address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!session) throw new Error(`no session cookie for ${address}`);
  return session.split(";")[0] ?? "";
}

export async function freshWorld(db: PrismaClient, email: RecordingAdapter): Promise<void> {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  email.reset();
}

/** A raw respond token for an assignment -- the way a message carries one. */
export async function respondToken(db: PrismaClient, assignmentId: string): Promise<string> {
  const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
  const minted = await mintCapabilityLink(db, {
    type: CapabilityTokenType.respond,
    assignmentId,
    expiresAt: (assignment.proposedSlot as Date).toISOString(),
  });
  return minted.url.split("/a/")[1] ?? "";
}

export async function activeAssignment(db: PrismaClient, reference: string) {
  const job = await db.job.findUniqueOrThrow({ where: { reference } });
  return db.assignment.findFirstOrThrow({
    where: { jobId: job.id, status: { in: ["assigned", "accepted"] } },
    orderBy: { dispatchedAt: "desc" },
  });
}

/** JOB-1042 accepted by Bob: scheduled, Lena Park the site contact, Sarah and Lena told. */
export async function acceptJob1042(db: PrismaClient, app: Express): Promise<{ jobId: string; assignmentId: string }> {
  const assignment = await activeAssignment(db, "JOB-1042");
  const token = await respondToken(db, assignment.id);
  const res = await request(app).post(`/api/respond/${token}/accept`).send({});
  if (res.status !== 200) throw new Error(`accept failed: ${String(res.status)}`);
  return { jobId: assignment.jobId, assignmentId: assignment.id };
}

/** A new Plumbing job for Sarah in Hilton, no contractor (the fixture seed has none spare). */
export async function makeNewJob(db: PrismaClient, customerCode = "CUS-1050"): Promise<{ id: string; reference: string }> {
  const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const customer = await db.customer.findUniqueOrThrow({ where: { code: customerCode } });
  const job = await db.job.create({
    data: {
      reference: await nextReference("JOB", db),
      customerId: customer.id,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      siteAddress: { street: "12 Paget Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      timezone: "Australia/Perth",
      description: "A test job.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date("2027-03-15T00:00:00.000Z"),
      status: "new",
    },
  });
  return { id: job.id, reference: job.reference };
}

export const MONDAY = "2027-03-15";
export const SATURDAY = "2027-03-20";

/** Every message row asked about a job, by type. */
export async function rowsOf(db: PrismaClient, jobId: string, type: string) {
  return db.notification.findMany({ where: { jobId, type }, orderBy: { createdAt: "asc" } });
}
