// Feature 6006 -- Refunds
//
// AC1  Mike refunds $540 on Sarah's paid job: one Stripe refund for 54000 cents on her payment, a
//      Refund row CN-1001 with Mike as approver, Stripe's id and status; the card shows the line
//      and Refund still shows with what is left
// AC2  refused (nothing saved, Stripe not asked) for 0, for more than is left, for a blank reason;
//      not offered with no money received, or once all is refunded
// AC3  refunding what is left turns the payment refunded; the invoice stays paid; Refund is gone
// AC4  Stripe refuses or cannot be reached: nothing saved, no CN number used, no email queued
// AC5  Sarah gets one Refund issued email with the wording and the credit note PDF attached,
//      headed with the legal identity
// AC6  Adjustment note with an "Includes GST" line when the invoice carried GST; Credit note and
//      no GST line when it did not
// AC9  Margaret's paid invoice with a stray second payment: the stray payment can be refunded,
//      the refund comes off the payment with the most left
// AC11 only ops and the owner reach the refund endpoints and the PDF; Bob gets nothing
//
// (AC7 and AC8, Stripe's later news, are in stripe-payment.test.ts.) No test reaches Stripe: the
// refund provider is a fake behind the adapter's seam.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { owedInvoice, type OwedInvoice } from "./helpers/owed-invoice.js";
import { pdfText } from "./helpers/agreements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { refundRoutes } from "../src/refunds/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { RefundRefusedError, setRefundProvider, type RefundProvider, type RefundRequest } from "../src/invoices/stripe.js";
import { makeRefund } from "../src/refunds/service.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-6006", "email");
const sms = recordingAdapter("test-sms-6006", "sms");

interface FakeStripe extends RefundProvider {
  calls: RefundRequest[];
  refuse: string | null;
  status: "pending" | "succeeded";
}

let stripe: FakeStripe;

function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    calls: [],
    refuse: null,
    status: "succeeded",
    createRefund(req) {
      fake.calls.push(req);
      if (fake.refuse !== null) return Promise.reject(new RefundRefusedError(fake.refuse));
      return Promise.resolve({ id: `re_${String(fake.calls.length)}`, status: fake.status });
    },
  };
  return fake;
}

/** A paid invoice with one succeeded card payment of the full amount. */
async function paidInvoice(options: { customerCode?: string; amount?: number; gst?: boolean; intent?: string } = {}): Promise<OwedInvoice> {
  const amount = options.amount ?? 132_000;
  const invoice = await owedInvoice(db, { ...(options.customerCode ? { customerCode: options.customerCode } : {}), amount, status: "paid" });
  await db.invoice.update({
    where: { id: invoice.invoiceId },
    data: options.gst ? { gstApplied: true, gstAmount: Math.round(amount / 11) } : {},
  });
  await payment(invoice, options.intent ?? `pi_${invoice.invoiceReference}`, amount);
  return invoice;
}

async function payment(invoice: OwedInvoice, intent: string, amount: number) {
  return db.payment.create({
    data: {
      invoiceId: invoice.invoiceId,
      customerId: invoice.customerId,
      stripePaymentIntentId: intent,
      amount,
      status: "succeeded",
      method: "card",
      paidAt: new Date("2026-10-14T06:00:00.000Z"),
    },
  });
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  return cookieHeader(res);
}

interface JobBody {
  refundReference?: string;
  invoice: {
    status: string;
    canRefund: boolean;
    refundableLeft: number;
    refunds: { reference: string; dateLabel: string; amount: number; status: string }[];
  };
}

async function refund(reference: string, body: unknown, cookie: string): Promise<request.Response> {
  return request(app).post(`/api/jobs/${reference}/invoice/refund`).set("Cookie", cookie).send(body as object);
}

async function refundRows() {
  return db.refund.findMany({ orderBy: { reference: "asc" } });
}

async function nextCn(): Promise<bigint> {
  const rows = await db.$queryRaw<{ last_value: bigint; is_called: boolean }[]>`SELECT last_value, is_called FROM refund_reference_seq`;
  return rows[0].is_called ? rows[0].last_value + 1n : rows[0].last_value;
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/refunds", refundRoutes(db));
  registerProvider(email);
  registerProvider(sms);
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
  await setProviders(db, { emailProvider: email.name, smsProvider: sms.name, providerOverrides: null });
  email.reset();
  sms.reset();
  stripe = fakeStripe();
  setRefundProvider(stripe);
});

afterEach(() => {
  setRefundProvider(undefined);
  vi.restoreAllMocks();
});

describe("AC1 -- Mike refunds part of Sarah's paid invoice", () => {
  test("AC1: $540 of $1,320 -- one Stripe refund, CN-1001 with Mike and the time, the card shows the line, Refund still shows with $780 left", async () => {
    const sarahs = await paidInvoice({ intent: "pi_sarah" });
    const mike = await signInCookie("mike@idelta.com.au");

    const res = await refund(sarahs.jobReference, { amount: 54_000, reason: "Part of the job was not done" }, mike);
    expect(res.status).toBe(200);
    const body = res.body as { refundReference: string; invoice: JobBody["invoice"] };
    expect(body.refundReference).toBe("CN-1001");

    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({ paymentIntentId: "pi_sarah", amount: 54_000, invoiceId: sarahs.invoiceId });

    const rows = await refundRows();
    expect(rows).toHaveLength(1);
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    expect(rows[0]).toMatchObject({
      reference: "CN-1001",
      invoiceId: sarahs.invoiceId,
      customerId: sarahs.customerId,
      jobId: sarahs.jobId,
      amount: 54_000,
      reason: "Part of the job was not done",
      approvedByUserId: mikeUser.id,
      stripeRefundId: "re_1",
      status: "succeeded",
    });
    expect(rows[0].paymentId).not.toBeNull();
    expect(Math.abs(rows[0].approvedAt.getTime() - Date.now())).toBeLessThan(60_000);

    expect(body.invoice).toMatchObject({ status: "paid", canRefund: true, refundableLeft: 78_000 });
    expect(body.invoice.refunds).toEqual([{ reference: "CN-1001", dateLabel: expect.any(String) as string, amount: 54_000, status: "succeeded" }]);
    const payment = await db.payment.findFirstOrThrow({ where: { invoiceId: sarahs.invoiceId } });
    expect(payment.status).toBe("succeeded");
  });

  test("AC1: a refund Stripe has not finished is kept pending", async () => {
    const sarahs = await paidInvoice();
    stripe.status = "pending";
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await refund(sarahs.jobReference, { amount: 10_000, reason: "Goodwill" }, mike)).status).toBe(200);
    expect((await refundRows())[0].status).toBe("pending");
  });

  test("AC1: a second, later refund gets the next CN number and the two add up", async () => {
    const sarahs = await paidInvoice();
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 54_000, reason: "One" }, mike);
    const second = await refund(sarahs.jobReference, { amount: 20_000, reason: "Two" }, mike);
    expect(second.status).toBe(200);
    expect((second.body as JobBody).refundReference).toBe("CN-1002");
    expect((second.body as JobBody).invoice.refundableLeft).toBe(58_000);
  });
});

describe("AC2 -- what is refused", () => {
  test("AC2: 0, a negative amount, more than is left and a blank reason are refused, nothing saved, Stripe not asked", async () => {
    const sarahs = await paidInvoice();
    const mike = await signInCookie("mike@idelta.com.au");

    const zero = await refund(sarahs.jobReference, { amount: 0, reason: "x" }, mike);
    expect(zero.status).toBe(400);
    expect(zero.body).toMatchObject({ field: "amount", error: "Enter an amount more than $0." });
    expect((await refund(sarahs.jobReference, { amount: -5, reason: "x" }, mike)).status).toBe(400);

    const over = await refund(sarahs.jobReference, { amount: 132_001, reason: "x" }, mike);
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ field: "amount", error: "That is more than is left to refund ($1,320)." });

    const blank = await refund(sarahs.jobReference, { amount: 1_000, reason: "   " }, mike);
    expect(blank.status).toBe(400);
    expect(blank.body).toMatchObject({ field: "reason", error: "Give a reason for the refund." });

    expect(stripe.calls).toHaveLength(0);
    expect(await refundRows()).toHaveLength(0);
    expect(await nextCn()).toBe(1001n);
  });

  test("AC2: an invoice with no money received offers no Refund and refuses one", async () => {
    const unpaid = await owedInvoice(db);
    const mike = await signInCookie("mike@idelta.com.au");
    const detail = await request(app).get(`/api/jobs/${unpaid.jobReference}`).set("Cookie", mike);
    expect((detail.body as JobBody).invoice).toMatchObject({ canRefund: false, refundableLeft: 0, refunds: [] });
    const res = await refund(unpaid.jobReference, { amount: 1_000, reason: "x" }, mike);
    expect(res.status).toBe(409);
    expect(stripe.calls).toHaveLength(0);
  });
});

describe("AC3 -- refunding what is left", () => {
  test("AC3: the payment turns refunded, the invoice stays paid, Refund is no longer offered, and another is refused", async () => {
    const sarahs = await paidInvoice();
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 54_000, reason: "First" }, mike);
    const rest = await refund(sarahs.jobReference, { amount: 78_000, reason: "The rest" }, mike);
    expect(rest.status).toBe(200);
    expect((rest.body as JobBody).invoice).toMatchObject({ status: "paid", canRefund: false, refundableLeft: 0 });

    expect((await db.payment.findFirstOrThrow({ where: { invoiceId: sarahs.invoiceId } })).status).toBe("refunded");
    expect((await db.invoice.findUniqueOrThrow({ where: { id: sarahs.invoiceId } })).status).toBe("paid");

    const again = await refund(sarahs.jobReference, { amount: 100, reason: "More" }, mike);
    expect(again.status).toBe(409);
    expect(stripe.calls).toHaveLength(2);
  });
});

describe("AC4 -- Stripe says no", () => {
  test("AC4: refused -- nothing saved, no CN number used, no email queued, the dialog gets Stripe's reason", async () => {
    const sarahs = await paidInvoice();
    stripe.refuse = "The charge is already fully refunded";
    const mike = await signInCookie("mike@idelta.com.au");

    const res = await refund(sarahs.jobReference, { amount: 54_000, reason: "Part not done" }, mike);
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe("Stripe did not make the refund: The charge is already fully refunded. Nothing was changed.");

    expect(await refundRows()).toHaveLength(0);
    expect(await nextCn()).toBe(1001n);
    expect(await db.notification.count({ where: { type: "refund_issued" } })).toBe(0);
    expect((await db.payment.findFirstOrThrow({ where: { invoiceId: sarahs.invoiceId } })).status).toBe("succeeded");
  });

  test("AC4: Stripe unreachable is the same, and the next try works with CN-1001", async () => {
    const sarahs = await paidInvoice();
    stripe.refuse = "Stripe could not be reached";
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await refund(sarahs.jobReference, { amount: 1_000, reason: "x" }, mike)).status).toBe(502);
    stripe.refuse = null;
    const ok = await refund(sarahs.jobReference, { amount: 1_000, reason: "x" }, mike);
    expect((ok.body as JobBody).refundReference).toBe("CN-1001");
  });
});

describe("AC5 -- Sarah's email and the credit note", () => {
  test("AC5: one Refund issued email, the wording, the PDF headed with the legal identity", async () => {
    const sarahs = await paidInvoice();
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 54_000, reason: "Part of the job was not done" }, mike);

    const queued = await db.notification.findMany({ where: { type: "refund_issued" } });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ channel: "email", recipientType: "customer", relatedType: "refund", jobId: sarahs.jobId });

    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "sarah@idelta.com.au");
    expect(mail).toBeDefined();
    expect(mail?.message.subject).toBe(`Refund issued - CN-1001, against invoice ${sarahs.invoiceReference}`);
    const text = mail?.message.text ?? "";
    expect(text).toContain("Hi Sarah,");
    expect(text).toContain(`We've refunded $540 against invoice ${sarahs.invoiceReference} (${sarahs.jobReference}), which you paid $1,320 by card.`);
    expect(text).toContain("Why: Part of the job was not done");
    expect(text).toContain("It goes back to your card. A card refund can take 5 to 10 business days to show on your statement.");
    expect(text).toContain("The credit note is attached.");
    expect(mail?.attachments).toHaveLength(1);
    expect(mail?.attachments?.[0]).toMatchObject({ fileName: "CN-1001.pdf", contentType: "application/pdf" });
    const pdf = pdfText(mail?.attachments?.[0]?.content ?? new Uint8Array());
    expect(pdf).toContain("Trade Services");
    expect(pdf).toContain("ABN 123456789");
    expect(pdf).toContain("1 Hay Street");
    expect(pdf).not.toContain("Perth Trades");
    expect(pdf).toContain("CN-1001");
    expect(pdf).toContain(sarahs.invoiceReference);
    expect(pdf).toContain("Part of the job was not done");
    expect(pdf).toContain("$540.00");
  });

  test("AC5: a method that is not a card says it goes back to the account she paid from, with no timing line", async () => {
    const sarahs = await paidInvoice();
    await db.payment.updateMany({ where: { invoiceId: sarahs.invoiceId }, data: { method: "payto" } });
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 54_000, reason: "x" }, mike);
    await drainOnce(db);
    const text = email.sent.find((m) => m.to === "sarah@idelta.com.au")?.message.text ?? "";
    expect(text).toContain("by PayTo.");
    expect(text).toContain("It goes back to the account you paid from.");
    expect(text).not.toContain("business days");
  });
});

describe("AC6 -- the note's title and GST line", () => {
  test("AC6: an invoice that carried GST gets an Adjustment note with Includes GST of one eleventh", async () => {
    const margarets = await paidInvoice({ customerCode: "CUS-1053", amount: 66_000, gst: true });
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(margarets.jobReference, { amount: 33_000, reason: "Half back" }, mike);
    const row = (await refundRows())[0];
    const res = await request(app).get(`/api/refunds/${row.reference}/credit-note`).set("Cookie", mike).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const text = pdfText(new Uint8Array(res.body as Buffer));
    expect(text).toContain("Adjustment note");
    expect(text).toContain("Includes GST of $30.00");
    expect(text).toContain("$330.00");
  });

  test("AC6: an invoice without GST gets a Credit note and no GST line", async () => {
    const sarahs = await paidInvoice();
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 54_000, reason: "x" }, mike);
    const res = await request(app).get("/api/refunds/CN-1001/credit-note").set("Cookie", mike).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const text = pdfText(new Uint8Array(res.body as Buffer));
    expect(text).toContain("Credit note");
    expect(text).not.toContain("Adjustment note");
    expect(text).not.toContain("Includes GST");
  });
});

describe("AC9 -- the stray second payment", () => {
  test("AC9: Margaret paid twice -- the refund comes off the payment with the most left, and an amount no single payment can take is refused", async () => {
    const margarets = await paidInvoice({ customerCode: "CUS-1053", amount: 50_000, intent: "pi_first" });
    await payment(margarets, "pi_stray", 20_000);
    const mike = await signInCookie("mike@idelta.com.au");

    const detail = await request(app).get(`/api/jobs/${margarets.jobReference}`).set("Cookie", mike);
    expect((detail.body as JobBody).invoice).toMatchObject({ canRefund: true, refundableLeft: 70_000 });

    const tooMuch = await refund(margarets.jobReference, { amount: 60_000, reason: "x" }, mike);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body).toMatchObject({ field: "amount", left: 50_000 });
    expect(stripe.calls).toHaveLength(0);

    // The stray $200 comes off the first payment (the most left); it is the refund Mike meant.
    const stray = await refund(margarets.jobReference, { amount: 20_000, reason: "Paid twice" }, mike);
    expect(stray.status).toBe(200);
    expect(stripe.calls[0]).toMatchObject({ paymentIntentId: "pi_first", amount: 20_000 });
    expect((stray.body as JobBody).invoice.refundableLeft).toBe(50_000);
  });
});

describe("AC11 -- who may", () => {
  test("AC11: the owner may; Bob and a signed-out caller get nothing", async () => {
    const sarahs = await paidInvoice();
    const bob = await signInCookie("bob@idelta.com.au");
    const owner = await signInCookie("owner@idelta.com.au");

    expect((await refund(sarahs.jobReference, { amount: 1_000, reason: "x" }, bob)).status).toBe(403);
    expect((await request(app).post(`/api/jobs/${sarahs.jobReference}/invoice/refund`).send({ amount: 1_000, reason: "x" })).status).toBe(401);
    expect(await refundRows()).toHaveLength(0);

    expect((await refund(sarahs.jobReference, { amount: 1_000, reason: "x" }, owner)).status).toBe(200);
    expect((await request(app).get("/api/refunds").set("Cookie", bob)).status).toBe(403);
    expect((await request(app).get("/api/refunds/CN-1001/credit-note").set("Cookie", bob)).status).toBe(403);
    expect((await request(app).get("/api/refunds/CN-1001/credit-note")).status).toBe(401);
    expect((await request(app).get("/api/refunds/CN-1001/credit-note").set("Cookie", owner)).status).toBe(200);
    expect((await request(app).get("/api/refunds/CN-9999/credit-note").set("Cookie", owner)).status).toBe(404);
  });
});

describe("The list, and two refunds at once", () => {
  test("AC10: the list is newest first, with the columns, 50 a page", async () => {
    const sarahs = await paidInvoice();
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 1_000, reason: "a" }, mike);
    await refund(sarahs.jobReference, { amount: 2_000, reason: "b" }, mike);
    const res = await request(app).get("/api/refunds").set("Cookie", mike);
    expect(res.status).toBe(200);
    const list = res.body as { rows: { reference: string; customerName: string; jobReference: string; invoiceReference: string; amount: number; status: string; madeBy: string }[]; total: number; page: number; pageCount: number; from: number; to: number };
    expect(list.rows.map((r) => r.reference)).toEqual(["CN-1002", "CN-1001"]);
    expect(list.rows[0]).toMatchObject({ customerName: "Sarah Chen", jobReference: sarahs.jobReference, invoiceReference: sarahs.invoiceReference, amount: 2_000, status: "succeeded", madeBy: "Mike" });
    expect(list).toMatchObject({ total: 2, page: 1, pageCount: 1, from: 1, to: 2 });
  });

  test("two refunds made at the same moment never give back more than was paid", async () => {
    const sarahs = await paidInvoice({ amount: 10_000 });
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const results = await Promise.all([
      makeRefund(db, { invoiceId: sarahs.invoiceId, amount: 7_000, reason: "a", byUserId: mike.id }),
      makeRefund(db, { invoiceId: sarahs.invoiceId, amount: 7_000, reason: "b", byUserId: mike.id }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(stripe.calls).toHaveLength(1);
  });
});
