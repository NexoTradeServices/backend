// Feature 6008 -- voiding an invoice
//
// AC8  Mike voids Tom's unpaid invoice with a reason: void, with Mike and the time, the card read
//      shows who / when / why, it leaves Receivables, and Bob's pay on the assignment is unchanged
// AC9  no reason -> 400 "Give a reason for voiding."; a paid, already void or zero-dollar invoice
//      -> 409 and no button (canVoid false); a contractor cannot call it
// AC10 voiding switches the pay link off; with Stripe failing the void still stands and the next
//      daily run switches it off; a payment arriving on the void invoice is kept and the office told
//
// No test reaches Stripe: the pay-link seam is a fake that records the links it was asked to switch off.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { owedInvoice } from "./helpers/owed-invoice.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { receivablesRoutes } from "../src/payments/routes.js";
import { listReceivables } from "../src/payments/receivables.js";
import { recordConfirmedPayment } from "../src/payments/paid.js";
import { DAILY_STEPS, runDailySteps } from "../src/daily/index.js";
import { setPayLinkProvider, type PayLinkProvider } from "../src/invoices/stripe.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-6008v", "email");

interface FakeSeam extends PayLinkProvider {
  switchedOff: string[];
  failWith: string | null;
}

function fakeSeam(): FakeSeam {
  const fake: FakeSeam = {
    switchedOff: [],
    failWith: null,
    createPayLink: (req) => Promise.resolve({ url: `https://pay.test/${req.invoiceReference}`, id: `plink_${req.invoiceReference}` }),
    deactivatePayLink(id) {
      if (fake.failWith !== null) return Promise.reject(new Error(fake.failWith));
      fake.switchedOff.push(id);
      return Promise.resolve();
    },
  };
  return fake;
}

let seam: FakeSeam;

async function signInCookie(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!session) throw new Error(`no session cookie for ${address}`);
  return session.split(";")[0] ?? "";
}

beforeAll(() => {
  db = testClient();
  const auth = buildAuth({ client: db });
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/receivables", receivablesRoutes(db));
  registerProvider(email);
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
  seam = fakeSeam();
  setPayLinkProvider(seam);
});

afterEach(() => {
  setPayLinkProvider(undefined);
  vi.restoreAllMocks();
});

interface JobBody {
  invoice: {
    status: string;
    canVoid: boolean;
    canResend: boolean;
    canCheckPayment: boolean;
    voided: { byName: string; atLabel: string; reason: string } | null;
  };
}

async function voidIt(reference: string, body: unknown, cookie: string): Promise<request.Response> {
  return request(app).post(`/api/jobs/${reference}/invoice/void`).set("Cookie", cookie).send(body as object);
}

describe("AC8 -- Mike voids Tom's invoice", () => {
  test("AC8: void with Mike and the time recorded, who / when / why on the card, gone from Receivables, Bob's pay unchanged", async () => {
    const toms = await owedInvoice(db, { customerCode: "CUS-1052", dueAt: new Date(Date.now() - 10 * 86_400_000) });
    const sarahs = await owedInvoice(db);
    const mike = await signInCookie("mike@idelta.com.au");
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const assignmentBefore = await db.assignment.findFirstOrThrow({ where: { jobId: toms.jobId } });

    const before = await request(app).get(`/api/jobs/${toms.jobReference}`).set("Cookie", mike);
    expect((before.body as JobBody).invoice).toMatchObject({ status: "sent", canVoid: true });

    const res = await voidIt(toms.jobReference, { reason: "  Billed to the wrong customer.  " }, mike);
    expect(res.status).toBe(200);
    const card = (res.body as JobBody).invoice;
    expect(card).toMatchObject({ status: "void", canVoid: false, canResend: false, canCheckPayment: false });
    expect(card.voided?.byName).toBe("Mike");
    expect(card.voided?.reason).toBe("Billed to the wrong customer.");
    expect(card.voided?.atLabel).toMatch(/^\d{1,2} \w{3} \d{4}, \d{1,2}:\d{2}(am|pm)$/);

    const row = await db.invoice.findUniqueOrThrow({ where: { id: toms.invoiceId } });
    expect(row).toMatchObject({ status: "void", voidReason: "Billed to the wrong customer.", voidedByUserId: mikeUser.id });
    expect(row.voidedAt).not.toBeNull();

    const receivables = await listReceivables(db, "Australia/Perth");
    expect(receivables.rows.map((r) => r.invoiceReference)).toEqual([sarahs.invoiceReference]);

    const assignmentAfter = await db.assignment.findFirstOrThrow({ where: { jobId: toms.jobId } });
    expect(assignmentAfter).toEqual(assignmentBefore);
  });
});

describe("AC9 -- refusals and roles", () => {
  test("AC9: no reason (missing, blank, too long) -> 400 'Give a reason for voiding.' and the invoice stays sent", async () => {
    const toms = await owedInvoice(db, { customerCode: "CUS-1052" });
    const mike = await signInCookie("mike@idelta.com.au");
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 7 }, { reason: "x".repeat(501) }]) {
      const res = await voidIt(toms.jobReference, body, mike);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Give a reason for voiding." });
    }
    expect((await db.invoice.findUniqueOrThrow({ where: { id: toms.invoiceId } })).status).toBe("sent");
    expect(seam.switchedOff).toEqual([]);
  });

  test("AC9: a paid, an already void and a zero-dollar invoice are refused 409 with no button", async () => {
    const paid = await owedInvoice(db, { status: "paid" });
    const already = await owedInvoice(db, { status: "void" });
    const zero = await owedInvoice(db, { isZeroDollar: true });
    const mike = await signInCookie("mike@idelta.com.au");

    const cases: [string, string][] = [
      [paid.jobReference, "This invoice is already paid - it can't be voided."],
      [already.jobReference, "This invoice is already void."],
      [zero.jobReference, "A zero-dollar invoice can't be voided."],
    ];
    for (const [reference, words] of cases) {
      const res = await voidIt(reference, { reason: "Dispute" }, mike);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: words });
      const card = ((await request(app).get(`/api/jobs/${reference}`).set("Cookie", mike)).body as JobBody).invoice;
      expect(card.canVoid).toBe(false);
    }
    expect(seam.switchedOff).toEqual([]);
  });

  test("AC9: a contractor cannot call it, the owner can, and an invoice without a pay link can be voided", async () => {
    const waiting = await owedInvoice(db, { customerCode: "CUS-1052", withLink: false });
    const bob = await signInCookie("bob@idelta.com.au");
    expect((await voidIt(waiting.jobReference, { reason: "Dispute" }, bob)).status).toBe(403);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: waiting.invoiceId } })).status).toBe("sent");

    const owner = await signInCookie("owner@idelta.com.au");
    const res = await voidIt(waiting.jobReference, { reason: "Duplicate job" }, owner);
    expect(res.status).toBe(200);
    expect((res.body as JobBody).invoice.voided?.byName).toBe("The owner");
    expect(seam.switchedOff).toEqual([]);
  });
});

describe("AC10 -- the pay link is switched off", () => {
  test("AC10: voiding asks Stripe to switch the invoice's link off", async () => {
    const toms = await owedInvoice(db, { customerCode: "CUS-1052" });
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await voidIt(toms.jobReference, { reason: "Dispute" }, mike)).status).toBe(200);
    expect(seam.switchedOff).toEqual([toms.paymentLinkId]);
  });

  test("AC10: with Stripe failing the void stands, and the next daily run switches the link off", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seam.failWith = "stripe is down";
    const toms = await owedInvoice(db, { customerCode: "CUS-1052" });
    const mike = await signInCookie("mike@idelta.com.au");

    const res = await voidIt(toms.jobReference, { reason: "Dispute" }, mike);
    expect(res.status).toBe(200);
    expect((res.body as JobBody).invoice.status).toBe("void");
    expect(seam.switchedOff).toEqual([]);
    expect(error).toHaveBeenCalled();

    seam.failWith = null;
    await runDailySteps(db, { zone: "Australia/Perth", now: new Date(), steps: DAILY_STEPS });
    expect(seam.switchedOff).toEqual([toms.paymentLinkId]);
  });

  test("AC10: the sweep switches off voids under 7 days old, and not older ones", async () => {
    const recent = await owedInvoice(db, { status: "void" });
    const old = await owedInvoice(db, { status: "void" });
    const now = new Date();
    await db.invoice.update({ where: { id: recent.invoiceId }, data: { voidedAt: new Date(now.getTime() - 6 * 86_400_000), voidReason: "Dispute" } });
    await db.invoice.update({ where: { id: old.invoiceId }, data: { voidedAt: new Date(now.getTime() - 8 * 86_400_000), voidReason: "Dispute" } });

    await runDailySteps(db, { zone: "Australia/Perth", now, steps: DAILY_STEPS });
    expect(seam.switchedOff).toEqual([recent.paymentLinkId]);
  });

  test("AC10: without a Stripe key the switch-off step does nothing and says nothing", async () => {
    setPayLinkProvider(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recent = await owedInvoice(db, { status: "void" });
    await db.invoice.update({ where: { id: recent.invoiceId }, data: { voidedAt: new Date(), voidReason: "Dispute" } });
    const result = await runDailySteps(db, { zone: "Australia/Perth", now: new Date(), steps: DAILY_STEPS });
    expect(result.failed).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("AC10: a payment that arrives on the voided invoice is kept and the office told (closed-invoice notice)", async () => {
    const toms = await owedInvoice(db, { customerCode: "CUS-1052" });
    const mike = await signInCookie("mike@idelta.com.au");
    await voidIt(toms.jobReference, { reason: "Dispute" }, mike);

    const outcome = await recordConfirmedPayment(db, {
      invoiceId: toms.invoiceId,
      paymentIntentId: "pi_tom_after_void",
      amount: 65_500,
      method: "card",
      paidAt: new Date(),
    });
    expect(outcome).toBe("closed_invoice");
    expect((await db.invoice.findUniqueOrThrow({ where: { id: toms.invoiceId } })).status).toBe("void");
    expect(await db.payment.count({ where: { invoiceId: toms.invoiceId, status: "succeeded" } })).toBe(1);
    const notices = await db.notification.findMany({ where: { jobId: toms.jobId, type: "payment_closed_invoice" } });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.recipientType).toBe("ops");
  });
});
