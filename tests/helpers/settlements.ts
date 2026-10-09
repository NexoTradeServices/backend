// Visits with money on them -- Feature 6003, settlement run.
//
// Written straight into the tables, but priced by the SAME completion step Complete uses
// (issueInvoice), so a visit's pay is exactly what the platform would have frozen: Bob at
// $200 call-out / $150 an hour is $500 for 3.0h, $275 for 1.5h, and $300 for 1.0h on a Saturday
// at time and a half. The settlement tests start from "the work is done" and look at what the
// sweep, approval and payout do with it.
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import type { PrismaClient } from "../../src/db/client.js";
import { buildAuth } from "../../src/auth/config.js";
import { attachSession } from "../../src/auth/middleware.js";
import { authRoutes } from "../../src/auth/routes.js";
import { contractorLoginRoutes } from "../../src/auth/login-routes.js";
import { DEV_PASSWORD } from "../../src/db/seed/auth.js";
import { approveRoutes } from "../../src/approve/routes.js";
import { settlementRoutes } from "../../src/settlements/routes.js";
import { contractorSettlementRoutes } from "../../src/settlements/contractor-routes.js";
import { nextReference } from "../../src/db/reference.js";
import { issueInvoice } from "../../src/invoices/issue.js";
import { zonedDateTimeToUtc } from "../../src/time/index.js";

const ZONE = "Australia/Perth";

export interface VisitOptions {
  /** CON-014 Bob, CON-021 Dave, CON-030 Priya */
  contractorCode: string;
  /** the visit's day in Perth, YYYY-MM-DD; it starts at 8:00am */
  day: string;
  hours: number;
  trade?: string;
  customerCode?: string;
  /** a part the contractor bought, in cents (a $45 Caroma cartridge is 4500) */
  partCents?: number;
  /** when it was completed; defaults to the end of the visit */
  completedAt?: Date;
  testData?: string;
}

export interface Visit {
  assignmentId: string;
  jobId: string;
  jobReference: string;
  pay: number;
}

/** A completed, invoiced visit by a cast contractor for a cast customer. */
export async function completedVisit(db: PrismaClient, options: VisitOptions): Promise<Visit> {
  const trade = options.trade ?? (options.contractorCode === "CON-021" ? "Electrical" : options.contractorCode === "CON-030" ? "Electrical" : "Plumbing");
  const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade } });
  const contractor = await db.contractor.findUniqueOrThrow({ where: { code: options.contractorCode }, include: { specialties: true } });
  const specialty = contractor.specialties.find((s) => s.trade === trade);
  if (!specialty) throw new Error(`${options.contractorCode} has no ${trade} specialty`);
  const customer = await db.customer.findUniqueOrThrow({ where: { code: options.customerCode ?? "CUS-1050" } });
  const label = options.testData === undefined ? {} : { testData: options.testData };

  const start = zonedDateTimeToUtc(ZONE, options.day, 8, 0);
  const end = new Date(start.getTime() + options.hours * 60 * 60_000);
  const completedAt = options.completedAt ?? end;
  const job = await db.job.create({
    data: {
      ...label,
      reference: await nextReference("JOB", db),
      customerId: customer.id,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      siteAddress: { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      serviceLevel: "normal",
      timezone: ZONE,
      description: "A settlement test job.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date(`${options.day}T00:00:00.000Z`),
      status: "scheduled",
    },
  });
  const assignment = await db.assignment.create({
    data: {
      ...label,
      jobId: job.id,
      contractorId: contractor.id,
      specialtyId: specialty.id,
      status: "accepted",
      proposedSlot: start,
      confirmedSlot: start,
      acceptedAt: start,
    },
  });
  await db.assignmentTimeLog.create({ data: { ...label, assignmentId: assignment.id, startedAt: start, endedAt: end, note: null } });
  if (options.partCents !== undefined) {
    const receipt = await db.attachment.create({
      data: { ...label, jobId: job.id, assignmentId: assignment.id, uploadedByRole: "contractor", storageKey: "tradeservice/receipts/settlement-test", fileName: "receipt.jpg" },
    });
    await db.assignmentPart.create({
      data: { ...label, assignmentId: assignment.id, suppliedBy: "contractor", name: "Caroma cartridge", qty: 1, unitPrice: options.partCents, lineTotal: options.partCents, receiptAttachmentId: receipt.id },
    });
  }
  await db.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { completionNotes: "Done.", billedHours: options.hours, completedAt, status: "completed" },
    });
    await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
    await issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [start], billedHours: options.hours, now: completedAt });
  });
  const done = await db.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
  return { assignmentId: assignment.id, jobId: job.id, jobReference: job.reference, pay: done.contractorPay ?? 0 };
}

/** A no-show call-out: the attendance was cancelled, and the contractor is still paid the call-out. */
export async function noShowCallout(
  db: PrismaClient,
  options: { contractorCode: string; cancelledAt: Date; pay?: number; testData?: string },
): Promise<Visit> {
  const visit = await completedVisit(db, { contractorCode: options.contractorCode, day: "2026-10-12", hours: 1, ...(options.testData === undefined ? {} : { testData: options.testData }) });
  await db.assignment.update({
    where: { id: visit.assignmentId },
    data: { status: "cancelled", cancelledAt: options.cancelledAt, completedAt: null, billedHours: null, contractorPay: options.pay ?? 15_000, materialsReimbursement: null },
  });
  return { ...visit, pay: options.pay ?? 15_000 };
}

/** A Monday-after-the-week `now`: 6:30am Perth on Monday 19 Oct 2026, so the run covers 12-18 Oct. */
export const MONDAY_19_OCT = new Date("2026-10-18T22:30:00.000Z");
/** The Monday before it, for the earlier week (5-11 Oct). */
export const MONDAY_12_OCT = new Date("2026-10-11T22:30:00.000Z");

// ---------------------------------------------------------------------------
// The API, signed in
// ---------------------------------------------------------------------------

/** The settlement routes behind the real session middleware, as index.ts mounts them. */
export function settlementApp(db: PrismaClient): Express {
  const auth = buildAuth({ client: db });
  const app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/settlements", settlementRoutes(db));
  app.use("/api/contractor/settlements", contractorSettlementRoutes(db));
  app.use("/api/approve", approveRoutes(db));
  return app;
}

/** The session cookie for a cast login (the dev password). */
export async function signIn(app: Express, address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((cookie) => cookie.includes("better-auth.session_token="));
  if (!session) throw new Error(`no session cookie signing in as ${address}: ${JSON.stringify(cookies)}`);
  return session.split(";")[0] ?? "";
}
