// Test helpers -- Feature 6007, correct & reissue and pay adjustments.
//
// One app (ops job routes, ops settlements routes, the contractor's settlement, dashboard and job routes)
// behind the real session middleware, plus the worlds the suites start from: Sarah's completed,
// invoiced job (5h, Bob), the same paid through Stripe, and Bob's week on each settlement state.
// No test reaches Stripe: the pay-link and refund seams are fakes.
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { buildAuth } from "../../src/auth/config.js";
import { attachSession } from "../../src/auth/middleware.js";
import { authRoutes } from "../../src/auth/routes.js";
import { contractorLoginRoutes } from "../../src/auth/login-routes.js";
import { jobRoutes } from "../../src/jobs/routes.js";
import { settlementRoutes } from "../../src/settlements/routes.js";
import { contractorSettlementRoutes } from "../../src/settlements/contractor-routes.js";
import { contractorDashboardRoutes } from "../../src/contractors/dashboard-routes.js";
import { contractorJobRoutes } from "../../src/contractors/job-routes.js";
import { RefundRefusedError, type PayLinkProvider, type RefundProvider, type RefundRequest } from "../../src/invoices/stripe.js";
import { DEV_PASSWORD } from "../../src/db/seed/auth.js";
import type { PrismaClient } from "../../src/db/client.js";
import { MONDAY_19_OCT, completedVisit, type Visit } from "./settlements.js";
import { runWeekly } from "../../src/settlements/sweep.js";

export function correctApp(db: PrismaClient): Express {
  const auth = buildAuth({ client: db });
  const app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/settlements", settlementRoutes(db));
  app.use("/api/contractor/settlements", contractorSettlementRoutes(db));
  app.use("/api/contractor/jobs", contractorJobRoutes(db));
  app.use("/api/contractor", contractorDashboardRoutes(db));
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

export interface FakeSeam extends PayLinkProvider {
  made: string[];
  switchedOff: string[];
}

export function fakePayLinks(): FakeSeam {
  const fake: FakeSeam = {
    made: [],
    switchedOff: [],
    createPayLink(req) {
      fake.made.push(req.invoiceReference);
      return Promise.resolve({ url: `https://pay.test/${req.invoiceReference}`, id: `plink_${req.invoiceReference}` });
    },
    deactivatePayLink(id) {
      fake.switchedOff.push(id);
      return Promise.resolve();
    },
  };
  return fake;
}

export interface FakeRefunds extends RefundProvider {
  calls: RefundRequest[];
  refuse: string | null;
}

export function fakeRefunds(): FakeRefunds {
  const fake: FakeRefunds = {
    calls: [],
    refuse: null,
    createRefund(req) {
      fake.calls.push(req);
      if (fake.refuse !== null) return Promise.reject(new RefundRefusedError(fake.refuse));
      return Promise.resolve({ id: `re_${String(fake.calls.length)}`, status: "succeeded" });
    },
  };
  return fake;
}

/** Wait (up to ~3s) for the fire-and-forget pay link of an invoice to land. */
export async function untilLinked(db: PrismaClient, invoiceId: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const row = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { stripePaymentLinkUrl: true } });
    if (row.stripePaymentLinkUrl !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the new invoice never got its pay link");
}

/** Wait (up to ~3s) until no sent invoice is still waiting for its fire-and-forget pay link -- so the next test's reset never meets it. */
export async function untilAllLinked(db: PrismaClient): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const waiting = await db.invoice.count({ where: { status: "sent", isZeroDollar: false, stripePaymentLinkUrl: null } });
    if (waiting === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The link's two message rows commit with it; give the transaction a beat to release its locks.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export interface SarahsJob extends Visit {
  invoiceId: string;
  invoiceReference: string;
  amount: number;
}

/** Bob's completed 5h Plumbing job for Sarah: an INV with its pay link, not yet swept. */
export async function sarahsJob(db: PrismaClient, options: { hours?: number; day?: string; partCents?: number; testData?: string } = {}): Promise<SarahsJob> {
  const visit = await completedVisit(db, {
    contractorCode: "CON-014",
    day: options.day ?? "2026-10-14",
    hours: options.hours ?? 5,
    ...(options.partCents === undefined ? {} : { partCents: options.partCents }),
    ...(options.testData === undefined ? {} : { testData: options.testData }),
  });
  const invoice = await db.invoice.findFirstOrThrow({ where: { jobId: visit.jobId } });
  await db.invoice.update({
    where: { id: invoice.id },
    data: { stripePaymentLinkUrl: `https://pay.test/${invoice.reference}`, stripePaymentLinkId: `plink_${invoice.reference}` },
  });
  return { ...visit, invoiceId: invoice.id, invoiceReference: invoice.reference, amount: invoice.amount };
}

/** The job paid in full by card through Stripe (a succeeded payment on `pi_<INV>`). */
export async function payInFull(db: PrismaClient, job: SarahsJob): Promise<void> {
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: job.invoiceId } });
  await db.invoice.update({ where: { id: invoice.id }, data: { status: "paid", paidAt: new Date() } });
  await db.payment.create({
    data: {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      stripePaymentIntentId: `pi_${invoice.reference}`,
      amount: invoice.amount,
      status: "succeeded",
      method: "card",
      paidAt: new Date(),
    },
  });
}

/** Bob's week as a draft / approved / paid settlement, made by the Monday run. */
export async function settle(db: PrismaClient, status: "draft" | "approved" | "paid"): Promise<{ id: string; reference: string }> {
  await runWeekly(db, MONDAY_19_OCT);
  const draft = await db.contractorSettlement.findFirstOrThrow({ where: { status: "draft" } });
  if (status === "draft") return { id: draft.id, reference: draft.reference };
  await db.contractorSettlement.update({
    where: { id: draft.id },
    data: {
      status,
      approvedAt: MONDAY_19_OCT,
      contractorGstRegistered: true,
      gstAmount: Math.round((draft.totalAmount - draft.materialsAmount) * 0.1),
      ...(status === "paid" ? { paidAt: MONDAY_19_OCT, paymentReference: draft.reference } : {}),
    },
  });
  return { id: draft.id, reference: draft.reference };
}

/** A visit time entry for the correct endpoint: the job's own date and clock. */
export function entry(day: string, start: string, end: string): { date: string; start: string; end: string } {
  return { date: day, start, end };
}
