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
    expect(mail?.message.subject).toBe(`Refund CN-1001 - ${sarahs.jobReference}`);
    const text = mail?.message.text ?? "";
    expect(text).toContain("Hi Sarah,");
    expect(text).toContain(`We have refunded part of your invoice ${sarahs.invoiceReference} for your plumbing job ${sarahs.jobReference}.`);
    expect(text).toContain("Your refund receipt CN-1001 is attached.");
    // 6015: no money, no reason, no card-days line.
    expect(text).not.toContain("$");
    expect(text).not.toContain("Part of the job was not done");
    expect(text).not.toContain("business days");
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

  test("AC5: whatever method she paid by, the email carries no timing line and no method", async () => {
    const sarahs = await paidInvoice();
    await db.payment.updateMany({ where: { invoiceId: sarahs.invoiceId }, data: { method: "payto" } });
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 54_000, reason: "x" }, mike);
    await drainOnce(db);
    const text = email.sent.find((m) => m.to === "sarah@idelta.com.au")?.message.text ?? "";
    expect(text).not.toContain("PayTo");
    expect(text).not.toContain("account you paid from");
    expect(text).not.toContain("business days");
  });
});

describe("AC6 -- the note's title and GST line", () => {
  test("AC6: a home customer's refund on a GST invoice is still a Refund (B1), with GST included of one eleventh", async () => {
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
    expect(text).toContain("REFUND");
    expect(text).not.toContain("ADJUSTMENT NOTE");
    expect(text).toContain("TOTAL REFUNDED (INCLUDES GST)");
    expect(text).toContain("GST INCLUDED");
    expect(text).not.toContain("GST: Not applicable");
    expect(text).toContain("$30.00");
    expect(text).toContain("$330.00");
  });

  test("AC6: an invoice without GST gets a Refund and no GST line", async () => {
    const sarahs = await paidInvoice();
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(sarahs.jobReference, { amount: 54_000, reason: "x" }, mike);
    const res = await request(app).get("/api/refunds/CN-1001/credit-note").set("Cookie", mike).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const text = pdfText(new Uint8Array(res.body as Buffer));
    expect(text).toContain("REFUND");
    expect(text).toContain("TOTAL REFUNDED");
    expect(text).not.toContain("ADJUSTMENT NOTE");
    expect(text).not.toContain("INCLUDES GST");
    expect(text).toContain("GST: Not applicable - this business is not registered for GST.");
  });
});

async function creditNoteText(reference: string, cookie: string): Promise<string> {
  const res = await request(app).get(`/api/refunds/${reference}/credit-note`).set("Cookie", cookie).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  expect(res.status).toBe(200);
  return pdfText(new Uint8Array(res.body as Buffer));
}

const ABN = "51824753556";

async function makeBusiness(customerId: string, withAbn: boolean) {
  await db.customer.update({
    where: { id: customerId },
    data: { businessName: "Rossi's Cafe", gstRegistered: true, ...(withAbn ? { abn: ABN } : {}) },
  });
}

describe("6015 AC7 -- the refund freezes the customer's details", () => {
  test("AC7: the receipt carries what is on file when the refund is made, and later changes change nothing", async () => {
    const invoice = await paidInvoice({ customerCode: "CUS-1053", amount: 66_000 });
    await makeBusiness(invoice.customerId, true);
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(invoice.jobReference, { amount: 10_000, reason: "first" }, mike);
    const first = (await refundRows())[0];
    expect(first.billedTo).toMatchObject({ businessName: "Rossi's Cafe", abn: ABN });

    await db.customer.update({ where: { id: invoice.customerId }, data: { businessName: null, abn: null, gstRegistered: null } });
    await refund(invoice.jobReference, { amount: 10_000, reason: "second" }, mike);
    const rows = await refundRows();
    expect(rows[0].billedTo).toMatchObject({ businessName: "Rossi's Cafe", abn: ABN });
    expect(rows[1].billedTo).not.toHaveProperty("businessName");
    expect(rows[1].billedTo).not.toHaveProperty("abn");
  });

  test("AC7: the migration back-fill copies each invoice's billedTo onto its refunds", async () => {
    const invoice = await paidInvoice({ customerCode: "CUS-1053", amount: 66_000 });
    const mike = await signInCookie("mike@idelta.com.au");
    await refund(invoice.jobReference, { amount: 10_000, reason: "old" }, mike);
    await db.invoice.update({ where: { id: invoice.invoiceId }, data: { billedTo: { name: "Margaret", businessName: "Old Co" } } });
    // The statement the migration ran, on the one refund.
    await db.$executeRawUnsafe(
      `UPDATE "Refund" SET "billedTo" = "Invoice"."billedTo" FROM "Invoice" WHERE "Refund"."invoiceId" = "Invoice"."id"`,
    );
    expect((await refundRows())[0].billedTo).toMatchObject({ name: "Margaret", businessName: "Old Co" });
  });
});

describe("6015 AC8 -- the four refund receipts", () => {
  test("AC8: A1 and A2 (not GST) are titled REFUND with TOTAL REFUNDED and the GST note; A2 names the business, Attn and ABN", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const home = await paidInvoice();
    await refund(home.jobReference, { amount: 10_000, reason: "home" }, mike);
    const a1 = await creditNoteText("CN-1001", mike);
    expect(a1).toContain("REFUND TO");
    expect(a1).not.toContain("Attn:");
    expect(a1).toContain("Refund against invoice " + home.invoiceReference);
    expect(a1).toContain("TOTAL REFUNDED");
    expect(a1).toContain("GST: Not applicable - this business is not registered for GST.");

    const biz = await paidInvoice({ customerCode: "CUS-1053", amount: 66_000 });
    await makeBusiness(biz.customerId, true);
    await refund(biz.jobReference, { amount: 10_000, reason: "biz" }, mike);
    const a2 = await creditNoteText("CN-1002", mike);
    expect(a2).toContain("REFUND");
    expect(a2).not.toContain("ADJUSTMENT NOTE");
    expect(a2).toContain("Rossi's Cafe");
    expect(a2).toContain("Attn: Margaret");
    expect(a2).toContain("ABN 51 824 753 556");
    expect(a2).toContain("GST: Not applicable");
  });

  test("AC8: B2 (a business on a tax invoice) is an ADJUSTMENT NOTE against the tax invoice, with GST INCLUDED", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const biz = await paidInvoice({ customerCode: "CUS-1053", amount: 66_000, gst: true });
    await makeBusiness(biz.customerId, false);
    await refund(biz.jobReference, { amount: 33_000, reason: "half" }, mike);
    const b2 = await creditNoteText("CN-1001", mike);
    expect(b2).toContain("ADJUSTMENT NOTE");
    expect(b2).toContain("Refund against tax invoice " + biz.invoiceReference);
    expect(b2).toContain("TOTAL REFUNDED (INCLUDES GST)");
    expect(b2).toContain("GST INCLUDED");
    expect(b2).toContain("$30.00");
    expect(b2).not.toContain("GST: Not applicable");
    expect(b2).not.toContain("ABN 51"); // none on file at the time: the line is absent
  });
});

describe("6015 AC10 -- the Refund issued email", () => {
  test("AC10: partial says 'part of', full says 'your invoice'; adjustment note only on B2; no money, no reason", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const biz = await paidInvoice({ customerCode: "CUS-1053", amount: 66_000, gst: true });
    await makeBusiness(biz.customerId, true);
    await refund(biz.jobReference, { amount: 30_000, reason: "secret reason" }, mike);
    await refund(biz.jobReference, { amount: 36_000, reason: "rest" }, mike);
    await drainOnce(db);
    const mails = email.sent.filter((m) => (m.message.subject ?? "").startsWith("Refund CN-"));
    expect(mails).toHaveLength(2);
    const [partial, full] = mails;
    expect(partial.message.text).toContain(`We have refunded part of your invoice ${biz.invoiceReference} for your`);
    expect(full.message.text).toContain(`We have refunded your invoice ${biz.invoiceReference} for your`);
    expect(partial.message.text).toContain("Your adjustment note CN-1001 is attached.");
    for (const mail of mails) {
      expect(mail.message.subject).toMatch(/^Refund CN-100\d - JOB-/);
      expect(mail.message.text).not.toContain("$");
      expect(mail.message.html).not.toContain("$");
      expect(mail.message.text).not.toContain("secret reason");
      expect(mail.attachments).toHaveLength(1);
    }
  });
});

describe("6015 AC11 -- the accounts phone on the receipt and the email", () => {
  test("AC11: the accounts phone shows when set; the operator phone stands in when blank", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const settings = await db.platformSettings.findFirstOrThrow();
    const home = await paidInvoice();
    await refund(home.jobReference, { amount: 10_000, reason: "a" }, mike);
    expect(await creditNoteText("CN-1001", mike)).toContain(`Call ${settings.operatorPhone}`);

    await db.platformSettings.updateMany({ data: { accountsPhone: "08 9111 2222" } });
    expect(await creditNoteText("CN-1001", mike)).toContain("Call 08 9111 2222");
    await refund(home.jobReference, { amount: 10_000, reason: "b" }, mike);
    await drainOnce(db);
    const second = email.sent.filter((m) => (m.message.subject ?? "").startsWith("Refund CN-")).at(-1);
    expect(second?.message.text).toContain("Call us on 08 9111 2222");
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
