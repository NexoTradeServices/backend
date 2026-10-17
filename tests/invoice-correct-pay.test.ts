// Feature 6007 -- Bob's pay follows the corrected hours (and AC14, AC15, AC12, AC13)
//
// AC7  a visit not yet swept recomputes; a visit on his unapproved draft recomputes and the draft is
//      superseded and resent with a fresh approve link; a visit on an approved or paid week stays as paid
//      and a correction (minus or plus) waits for his next run, worded "Correction - JOB-1042: [reason]"
// AC12 the invoice PDF shows a QR code of its pay link; a $0 invoice has none; the email has none
// AC13 the Payment receipt ends "Questions about this bill? Call us on [accounts phone]", the operator phone when blank
// AC14 Bob's dashboard keeps a completed job with an unpaid invoice as "Completed - awaiting payment"; it leaves once paid
// AC15 Mike's job page carries the newest invoice's status, so the header can show Paid
//
// No test reaches Stripe, Mailjet or ClickSend.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { correctApp, entry, fakePayLinks, fakeRefunds, payInFull, sarahsJob, settle, signIn, untilAllLinked } from "./helpers/correct.js";
import { MONDAY_19_OCT, completedVisit } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { setPayLinkProvider, setRefundProvider } from "../src/invoices/stripe.js";
import { buildInvoicePdf } from "../src/invoices/pdf.js";
import { recordConfirmedPayment } from "../src/payments/paid.js";
import { runWeekly } from "../src/settlements/sweep.js";
import { buildNextPayoutView } from "../src/settlements/invoice-view.js";
import { nextPayout } from "../src/settlements/service.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
let mike: string;
const email = recordingAdapter("test-email-6007p", "email");

beforeAll(() => {
  db = testClient();
  app = correctApp(db);
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
  setPayLinkProvider(fakePayLinks());
  setRefundProvider(fakeRefunds());
  mike = await signIn(app, "mike@idelta.com.au");
});

afterEach(async () => {
  await untilAllLinked(db);
  setPayLinkProvider(undefined);
  setRefundProvider(undefined);
});

const DAY = "2026-10-14";

function correct(reference: string, body: object): request.Test {
  return request(app).post(`/api/jobs/${reference}/correct`).set("Cookie", mike).send(body);
}

async function bob(): Promise<{ id: string }> {
  return db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
}

const RUN_26_OCT = new Date("2026-10-25T22:30:00.000Z");

describe("AC7 -- where the visit sits decides how Bob's pay follows", () => {
  test("AC7: not yet swept - the visit's pay recomputes and the next run picks it up correct", async () => {
    const job = await sarahsJob(db);
    const card = await request(app)
      .post(`/api/jobs/${job.jobReference}/correct/preview`)
      .set("Cookie", mike)
      .send({ timeEntries: [entry(DAY, "08:00", "10:00")] });
    expect((card.body as { contractor: { sentence: string } }).contractor.sentence).toBe("It goes on their next payout.");
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Worked 2h." }).expect(200);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } })).contractorPay).toBe(35_000);
    await runWeekly(db, MONDAY_19_OCT);
    expect((await db.contractorSettlement.findFirstOrThrow()).totalAmount).toBe(35_000);
  });

  test("AC7: on his unapproved draft - recomputed, the draft superseded and a fresh one sent with a fresh approve link", async () => {
    const job = await sarahsJob(db);
    const draft = await settle(db, "draft");
    expect(await db.notification.count({ where: { type: "settlement_draft" } })).toBe(1);

    const card = await request(app)
      .post(`/api/jobs/${job.jobReference}/correct/preview`)
      .set("Cookie", mike)
      .send({ timeEntries: [entry(DAY, "08:00", "10:00")] });
    expect((card.body as { contractor: { from: number; to: number; sentence: string } }).contractor).toMatchObject({
      from: 80_000,
      to: 35_000,
      sentence: "Their draft is rebuilt and sent to them again.",
    });

    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Worked 2h." }).expect(200);
    const old = await db.contractorSettlement.findUniqueOrThrow({ where: { id: draft.id } });
    expect(old.status).toBe("superseded");
    expect(old.supersededByUserId).not.toBeNull();
    const fresh = await db.contractorSettlement.findFirstOrThrow({ where: { status: "draft" } });
    expect(fresh.id).not.toBe(draft.id);
    expect(fresh.totalAmount).toBe(35_000);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } })).settlementId).toBe(fresh.id);
    expect(await db.notification.count({ where: { type: "settlement_draft", relatedId: fresh.id } })).toBe(1);
    // Sent for real, the two drafts carry two different approve links.
    await drainOnce(db);
    const links = email.sent.filter((m) => m.to === "bob@idelta.com.au").map((m) => /\/approve\/[\w-]+/.exec(m.message.text ?? "")?.[0]);
    expect(links).toHaveLength(2);
    expect(new Set(links).size).toBe(2);
  });

  test.each(["approved", "paid"] as const)("AC7: on a %s week - the pay stays as paid and a minus correction waits for the next run", async (status) => {
    const job = await sarahsJob(db);
    await settle(db, status);
    const card = await request(app)
      .post(`/api/jobs/${job.jobReference}/correct/preview`)
      .set("Cookie", mike)
      .send({ timeEntries: [entry(DAY, "08:00", "10:00")] });
    expect((card.body as { contractor: { sentence: string } }).contractor.sentence).toBe(
      "Their week is paid, so -$450.00 comes off their next payout.",
    );

    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Logged 5h, worked 2h." }).expect(200);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } });
    // As paid: neither his pay nor the hours the approved invoice was made on move.
    expect(assignment.contractorPay).toBe(80_000);
    expect(Number(assignment.billedHours)).toBe(5);
    const rows = await db.contractorPayAdjustment.findMany();
    expect(rows).toEqual([
      expect.objectContaining({ kind: "correction", amount: -45_000, jobId: job.jobId, reason: "Logged 5h, worked 2h.", settlementId: null }),
    ]);
    expect(rows[0]?.createdByUserId).toBe((await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } })).id);

    const contractor = await bob();
    const next = await nextPayout(db, contractor.id, MONDAY_19_OCT);
    expect(next).toMatchObject({ adjustments: 1, adjustmentsNet: 0, stillToDeduct: { amount: 45_000, jobReferences: [job.jobReference] } });
    const view = await buildNextPayoutView(db, contractor.id, MONDAY_19_OCT, { periodStart: "2026-10-19", periodEnd: "2026-10-25" });
    expect(view?.stillToDeduct).toEqual({ amount: 45_000, jobReferences: [job.jobReference] });
  });

  test("AC7: the run takes the correction onto his next draft as 'Correction - JOB-xxxx: [reason]', signed", async () => {
    const job = await sarahsJob(db);
    await settle(db, "paid");
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Logged 5h, worked 2h." }).expect(200);
    // A fresh week of work big enough to take the whole deduction.
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-21", hours: 5 });
    await runWeekly(db, RUN_26_OCT);

    const draft = await db.contractorSettlement.findFirstOrThrow({ where: { status: "draft" } });
    expect(draft).toMatchObject({ adjustmentsAmount: -45_000, totalAmount: 80_000 - 45_000 });
    const res = await request(app).get(`/api/settlements/${draft.reference}`).set("Cookie", mike).expect(200);
    const lines = (res.body as { invoice: { adjustments: { label: string; amount: number }[] } }).invoice.adjustments;
    expect(lines).toEqual([{ reason: "Logged 5h, worked 2h.", label: `Correction - ${job.jobReference}: Logged 5h, worked 2h.`, kind: "correction", amount: -45_000, jobReference: job.jobReference }]);
  });

  test("AC7: hours found too low on a paid week make a plus correction", async () => {
    const job = await sarahsJob(db, { hours: 2 });
    await settle(db, "paid");
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "11:00")], reason: "Worked 3h, logged 2h." }).expect(200);
    const row = await db.contractorPayAdjustment.findFirstOrThrow();
    expect(row).toMatchObject({ kind: "correction", amount: 15_000 });
    // The customer's invoice never rises.
    expect(await db.invoice.count()).toBe(1);
  });

  test("AC7: a second correction on a paid week is measured from the pay as corrected so far", async () => {
    const job = await sarahsJob(db);
    await settle(db, "paid");
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "First." }).expect(200);
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "11:00")], reason: "Second." }).expect(200);
    const rows = await db.contractorPayAdjustment.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.amount)).toEqual([-45_000, 15_000]);
  });

  test("AC7: with a draft for a later week open, a correction on a paid week rebuilds that draft with the line", async () => {
    const job = await sarahsJob(db);
    await settle(db, "paid");
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-21", hours: 5 });
    await runWeekly(db, RUN_26_OCT);
    const before = await db.contractorSettlement.findFirstOrThrow({ where: { status: "draft" } });

    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Logged 5h, worked 2h." }).expect(200);
    expect((await db.contractorSettlement.findUniqueOrThrow({ where: { id: before.id } })).status).toBe("superseded");
    const fresh = await db.contractorSettlement.findFirstOrThrow({ where: { status: "draft" } });
    expect(fresh).toMatchObject({ adjustmentsAmount: -45_000, totalAmount: 35_000 });
    expect(await db.notification.count({ where: { type: "settlement_draft", relatedId: fresh.id } })).toBe(1);
  });
});

describe("AC8 -- what Bob reads on his Payouts screen", () => {
  test("a waiting deduction shows as a signed line and 'Still to deduct' on his next payout, and the list carries the figure", async () => {
    const job = await sarahsJob(db);
    await settle(db, "paid");
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Logged 5h, worked 2h." }).expect(200);
    const bobCookie = await signIn(app, "bob@idelta.com.au");

    const next = await request(app).get("/api/contractor/settlements/next").set("Cookie", bobCookie).expect(200);
    const invoice = (next.body as { invoice: { adjustments: unknown[]; stillToDeduct: { amount: number; jobReferences: string[] } | null; total: number } }).invoice;
    expect(invoice.adjustments).toEqual([]);
    expect(invoice.stillToDeduct).toEqual({ amount: 45_000, jobReferences: [job.jobReference] });
    expect(invoice.total).toBe(0);

    const list = await request(app).get("/api/contractor/settlements").set("Cookie", bobCookie).expect(200);
    expect((list.body as { nextPayout: { stillToDeduct: unknown } }).nextPayout.stillToDeduct).toEqual({ amount: 45_000, jobReferences: [job.jobReference] });
  });

  test("a pay adjustment reads 'Pay adjustment - [reason]' on his next payout", async () => {
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    await db.contractorPayAdjustment.create({ data: { contractorId: (await bob()).id, amount: 2500, reason: "Parking", createdByUserId: mikeUser.id } });
    const bobCookie = await signIn(app, "bob@idelta.com.au");
    const next = await request(app).get("/api/contractor/settlements/next").set("Cookie", bobCookie).expect(200);
    expect((next.body as { invoice: { adjustments: { label: string; amount: number }[] } }).invoice.adjustments).toEqual([
      expect.objectContaining({ label: "Pay adjustment - Parking", amount: 2500 }),
    ]);
  });
});

describe("AC12 -- the QR code on the invoice PDF", () => {
  /** How many filled squares the first page draws: a QR code is hundreds of small filled squares, one fill each. */
  async function squaresOf(bytes: Uint8Array): Promise<number> {
    const pdf = await PDFDocument.load(bytes);
    let total = 0;
    for (const page of pdf.getPages()) {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
      for (const stream of streams) {
        if (!(stream instanceof PDFRawStream)) continue;
        const text = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
        total += (text.match(/^f$/gm) ?? []).length;
      }
    }
    return total;
  }

  test("AC12: an invoice with a pay link draws a QR code beside the Pay online line; one without a link draws none", async () => {
    const job = await sarahsJob(db);
    const linked = await buildInvoicePdf(db, job.invoiceId);
    const payLine = await PDFDocument.load(linked.content);
    expect(payLine.getPageCount()).toBe(1);
    const withQr = await squaresOf(linked.content);
    expect(withQr).toBeGreaterThan(200);

    await db.invoice.update({ where: { id: job.invoiceId }, data: { stripePaymentLinkUrl: null } });
    const without = await squaresOf((await buildInvoicePdf(db, job.invoiceId)).content);
    expect(without).toBeLessThan(withQr - 200);
  });

  test("AC12: a $0 invoice (no link) has no QR code, and the invoice email carries no code in its body", async () => {
    const visit = await completedVisit(db, { contractorCode: "CON-030", day: DAY, hours: 1, callbackChargeable: false });
    const invoice = await db.invoice.findFirstOrThrow({ where: { jobId: visit.jobId } });
    expect(invoice.isZeroDollar).toBe(true);
    const free = await squaresOf((await buildInvoicePdf(db, invoice.id)).content);
    const job = await sarahsJob(db);
    const paid = await squaresOf((await buildInvoicePdf(db, job.invoiceId)).content);
    expect(paid - free).toBeGreaterThan(200);

    const { invoiceEmail } = await import("../src/notifications/templates/invoice.email.js");
    const rendered = invoiceEmail.render({ firstName: "Sarah", trade: "plumbing", jobReference: "JOB-1042", invoiceReference: "INV-2042", dueText: "x", payUrl: "https://pay.test/x", officePhone: "1", platformName: "P", gstApplied: false });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.text).not.toContain("QR");
  });
});

describe("AC13 -- the Payment receipt's questions line", () => {
  async function receiptText(): Promise<string> {
    const job = await sarahsJob(db);
    await recordConfirmedPayment(db, { invoiceId: job.invoiceId, paymentIntentId: "pi_6007_receipt", amount: job.amount, method: "card", paidAt: new Date() });
    await drainOnce(db);
    return email.sent.find((m) => (m.message.subject ?? "").startsWith("Payment received"))?.message.text ?? "";
  }

  test("AC13: it reads the Accounts phone when there is one", async () => {
    await db.platformSettings.updateMany({ data: { accountsPhone: "08 9000 1111" } });
    expect(await receiptText()).toContain("Questions about this bill? Call us on 08 9000 1111.");
  });

  test("AC13: it reads the operator phone when the Accounts phone is blank", async () => {
    await db.platformSettings.updateMany({ data: { accountsPhone: null, operatorPhone: "08 9000 2222" } });
    expect(await receiptText()).toContain("Questions about this bill? Call us on 08 9000 2222.");
  });
});

describe("AC14 -- Bob's dashboard keeps a completed job until it is paid", () => {
  interface Card {
    reference: string;
    jobStatus: string;
    opens: boolean;
    awaitingPayment: boolean;
    slotLabel: string | null;
  }

  async function cards(): Promise<Card[]> {
    const cookie = await signIn(app, "bob@idelta.com.au");
    const res = await request(app).get("/api/contractor/dashboard").set("Cookie", cookie).expect(200);
    return (res.body as { jobs: Card[] }).jobs;
  }

  test("AC14: a completed job with a sent invoice shows as awaiting payment, opens, and leaves once paid", async () => {
    const job = await sarahsJob(db);
    const awaiting = (await cards()).filter((card) => card.awaitingPayment);
    expect(awaiting).toEqual([{ reference: job.jobReference, jobStatus: "completed", opens: true, awaitingPayment: true, slotLabel: null, customerName: "Sarah Chen", trade: "Plumbing", suburb: "Hilton" }]);

    await payInFull(db, job);
    expect((await cards()).filter((card) => card.awaitingPayment)).toEqual([]);
  });

  test("AC14: a void or $0 newest invoice does not keep the card; a reissued invoice does", async () => {
    const job = await sarahsJob(db);
    await db.invoice.update({ where: { id: job.invoiceId }, data: { status: "void" } });
    expect((await cards()).filter((card) => card.awaitingPayment)).toEqual([]);

    const free = await completedVisit(db, { contractorCode: "CON-014", day: DAY, hours: 1, callbackChargeable: false });
    expect((await cards()).some((card) => card.reference === free.jobReference)).toBe(false);

    const second = await sarahsJob(db, { day: "2026-10-15" });
    await correct(second.jobReference, { prices: { callout: 20_000 }, reason: "Goodwill." }).expect(200);
    expect((await cards()).filter((card) => card.awaitingPayment).map((card) => card.reference)).toEqual([second.jobReference]);
  });

  test("AC14: another contractor's completed job never shows on Bob's dashboard", async () => {
    await completedVisit(db, { contractorCode: "CON-021", day: DAY, hours: 1 });
    expect((await cards()).filter((card) => card.awaitingPayment)).toEqual([]);
  });
});

describe("AC15 -- the job page carries the invoice's status for the Paid tag", () => {
  test("AC15: sent, then paid", async () => {
    const job = await sarahsJob(db);
    const read = async (): Promise<string> => {
      const res = await request(app).get(`/api/jobs/${job.jobReference}`).set("Cookie", mike).expect(200);
      return (res.body as { invoice: { status: string } }).invoice.status;
    };
    expect(await read()).toBe("sent");
    await payInFull(db, job);
    expect(await read()).toBe("paid");
  });
});
