// Test helpers -- Feature 6004, callbacks and no-shows.
//
// One app with the ops job routes and Bob's job routes behind the real session middleware, a fake
// Stripe behind the pay-link seam, and the states every 6004 suite starts from: an original job
// Bob completed, and a callback Bob has accepted.
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { buildAuth } from "../../src/auth/config.js";
import { attachSession } from "../../src/auth/middleware.js";
import { authRoutes } from "../../src/auth/routes.js";
import { contractorLoginRoutes } from "../../src/auth/login-routes.js";
import { contractorJobRoutes } from "../../src/contractors/job-routes.js";
import { jobRoutes } from "../../src/jobs/routes.js";
import type { PayLinkProvider, PayLinkRequest } from "../../src/invoices/stripe.js";
import type { PrismaClient } from "../../src/db/client.js";
import { completedVisit } from "./settlements.js";

export function buildCallbackApp(db: PrismaClient): Express {
  const auth = buildAuth({ client: db });
  const app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/contractor/jobs", contractorJobRoutes(db));
  return app;
}

export interface FakeStripe extends PayLinkProvider {
  calls: PayLinkRequest[];
}

export function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    calls: [],
    createPayLink(req) {
      fake.calls.push(req);
      return Promise.resolve({ url: `https://pay.test/${req.invoiceReference}`, id: `plink_${req.invoiceReference}` });
    },
    deactivatePayLink: () => Promise.resolve(),
  };
  return fake;
}

/** Sarah's leaking-tap job, completed by `contractorCode` (Bob by default) with an invoice, notes and one part. */
export async function completedOriginal(
  db: PrismaClient,
  contractorCode = "CON-014",
): Promise<{ jobId: string; reference: string; assignmentId: string }> {
  const trade = contractorCode === "CON-014" ? "Plumbing" : "Electrical";
  const visit = await completedVisit(db, { contractorCode, day: "2026-10-05", hours: 2, trade, partCents: 4500 });
  await db.assignment.update({
    where: { id: visit.assignmentId },
    data: { completionNotes: "Replaced the cartridge.\nTested for leaks." },
  });
  await db.job.update({ where: { id: visit.jobId }, data: { description: "The mixer tap in the kitchen leaks." } });
  return { jobId: visit.jobId, reference: visit.jobReference, assignmentId: visit.assignmentId };
}

/** Mike raises a callback on `reference`; returns the new job's reference. */
export async function raise(app: Express, mike: string, reference: string, description = "The tap drips again."): Promise<string> {
  const res = await request(app).post(`/api/jobs/${reference}/callback`).set("Cookie", mike).send({ description });
  if (res.status !== 201) throw new Error(`raise failed: ${String(res.status)} ${JSON.stringify(res.body)}`);
  return (res.body as { jobReference: string }).jobReference;
}

/** The callback dispatched to `contractorCode` and accepted: scheduled, a booking Bob can work. */
export async function acceptCallback(
  db: PrismaClient,
  reference: string,
  contractorCode = "CON-014",
): Promise<{ jobId: string; assignmentId: string }> {
  const job = await db.job.findUniqueOrThrow({ where: { reference }, include: { serviceType: true } });
  const contractor = await db.contractor.findUniqueOrThrow({ where: { code: contractorCode }, include: { specialties: true } });
  const specialty = contractor.specialties.find((s) => s.trade === job.serviceType.trade);
  if (!specialty) throw new Error(`${contractorCode} has no ${job.serviceType.trade} specialty`);
  const slot = new Date("2026-10-07T00:00:00.000Z");
  const assignment = await db.assignment.create({
    data: {
      jobId: job.id,
      contractorId: contractor.id,
      specialtyId: specialty.id,
      status: "accepted",
      proposedSlot: slot,
      confirmedSlot: slot,
      acceptedAt: new Date(),
    },
  });
  await db.job.update({ where: { id: job.id }, data: { status: "scheduled", serviceLevel: "normal" } });
  return { jobId: job.id, assignmentId: assignment.id };
}

export async function receiptFor(db: PrismaClient, assignmentId: string, jobId: string): Promise<string> {
  const row = await db.attachment.create({
    data: { jobId, assignmentId, uploadedByRole: "contractor", storageKey: "tradeservice/receipts/abc123", fileName: "receipt.jpg" },
  });
  return row.id;
}

/** Bob completes a callback (3.0h on 7 Oct 2026, a $45 part), with the pick in the body when given. */
export async function completeCallback(
  db: PrismaClient,
  app: Express,
  bob: string,
  made: { jobId: string; assignmentId: string },
  reference: string,
  pick?: boolean | null,
): Promise<request.Response> {
  return request(app)
    .post(`/api/contractor/jobs/${reference}/complete`)
    .set("Cookie", bob)
    .send({
      timeEntries: [{ date: "2026-10-07", start: "08:00", end: "11:00", note: "" }],
      completionNotes: "Reseated the cartridge.",
      parts: [
        {
          name: "Tap cartridge",
          description: "Ceramic",
          qty: 1,
          unitPrice: 4500,
          receiptAttachmentId: await receiptFor(db, made.assignmentId, made.jobId),
        },
      ],
      ...(pick === undefined ? {} : { callbackChargeable: pick }),
    });
}
