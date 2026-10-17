// Feature 6007 -- Correct & reissue
//
// AC1  Mike corrects Sarah's unpaid 5h job to 2h: the old invoice is voided (reason holding old -> new),
//      a new one is issued with replacesInvoiceId, the same gstApplied, lines worded as at issue, and a
//      `correction` note is written; the What happens card says so
// AC2  Sarah gets the Updated invoice email and text (no "corrected", no amounts), PDF attached; the old
//      invoice sends no more reminders
// AC3  a price above the replaced invoice's is refused; the reason is required; a contractor is turned away
// AC4  the new invoice gets its own pay link and the old one is switched off
// AC5  a paid invoice stays paid and the overcharge goes back as a refund, less refunds already made,
//      never more than is left
// AC6  hours up: Sarah's invoice is unchanged; with prices lowered too, the new prices on the hours first billed
// AC9  a no-show call-out invoice corrects only by its Call-out fee; a $0 follow-up takes only time changes
//
// (Bob's pay, AC7 and AC8, is in invoice-correct-pay.test.ts and settlements-sweep.test.ts.)
// No test reaches Stripe, Mailjet or ClickSend: the pay-link and refund seams are fakes, mail goes to a recorder.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { correctApp, entry, fakePayLinks, fakeRefunds, payInFull, sarahsJob, signIn, untilAllLinked, untilLinked, type FakeRefunds, type FakeSeam } from "./helpers/correct.js";
import { completedVisit } from "./helpers/settlements.js";
import { pdfText } from "./helpers/agreements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { setPayLinkProvider, setRefundProvider } from "../src/invoices/stripe.js";
import { runInvoiceReminders } from "../src/invoices/reminders.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
let mike: string;
let seam: FakeSeam;
let stripe: FakeRefunds;
const email = recordingAdapter("test-email-6007", "email");
const sms = recordingAdapter("test-sms-6007", "sms");

beforeAll(() => {
  db = testClient();
  app = correctApp(db);
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
  seam = fakePayLinks();
  stripe = fakeRefunds();
  setPayLinkProvider(seam);
  setRefundProvider(stripe);
  mike = await signIn(app, "mike@idelta.com.au");
});

afterEach(async () => {
  await untilAllLinked(db);
  setPayLinkProvider(undefined);
  setRefundProvider(undefined);
});

const DAY = "2026-10-14";

function correct(reference: string, body: object, cookie = mike): request.Test {
  return request(app).post(`/api/jobs/${reference}/correct`).set("Cookie", cookie).send(body);
}

function preview(reference: string, body: object, cookie = mike): request.Test {
  return request(app).post(`/api/jobs/${reference}/correct/preview`).set("Cookie", cookie).send(body);
}

interface Form {
  kind: string;
  invoice: { reference: string; status: string; amount: number };
  timeEntries: { date: string; start: string; end: string }[] | null;
  prices: {
    callout: { label: string; was: number } | null;
    hourly: { label: string; was: number } | null;
    parts: { id: string; label: string; was: number }[];
  } | null;
  contractor: { firstName: string; pay: number; place: string };
}

describe("the page's starting figures", () => {
  test("a 5h invoice offers its time entries and each price with what it was", async () => {
    const job = await sarahsJob(db, { partCents: 4500 });
    const res = await request(app).get(`/api/jobs/${job.jobReference}/correct`).set("Cookie", mike);
    expect(res.status).toBe(200);
    const form = res.body as Form;
    expect(form.kind).toBe("visit");
    expect(form.invoice).toMatchObject({ reference: job.invoiceReference, status: "sent", amount: 97_000 + 4500 });
    expect(form.timeEntries).toEqual([{ date: DAY, start: "08:00", end: "13:00", note: "" }]);
    expect(form.prices?.callout).toEqual({ label: "Call-out + first hour", was: 25_000 });
    expect(form.prices?.hourly).toEqual({ label: "Hourly rate after", was: 18_000 });
    expect(form.prices?.parts).toEqual([expect.objectContaining({ label: "Caroma cartridge", was: 4500 })]);
    expect(form.contractor).toEqual({ firstName: "Bob", pay: 80_000, place: "unswept" });
  });

  test("a job still open cannot be corrected", async () => {
    const job = await sarahsJob(db);
    await db.job.update({ where: { id: job.jobId }, data: { status: "in_progress" } });
    const res = await request(app).get(`/api/jobs/${job.jobReference}/correct`).set("Cookie", mike);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe("Only a completed job can be corrected.");
  });
});

describe("AC1 -- an unpaid invoice is voided and reissued", () => {
  test("AC1: 5h -> 2h with a reason: the card shows the invoice falling, the void-and-email sentence, and Bob's pay falling", async () => {
    const job = await sarahsJob(db);
    const res = await preview(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      customer: {
        label: "Sarah's invoice",
        from: 97_000,
        to: 43_000,
        action: "reissue",
        sentence: `${job.invoiceReference} is voided and a new invoice is emailed to Sarah.`,
      },
      contractor: { label: "Bob's pay", from: 80_000, to: 35_000, sentence: "It goes on their next payout." },
    });
    // The preview saves nothing.
    expect(await db.invoice.count()).toBe(1);
  });

  test("AC1: it voids the old invoice (old -> new in the reason), issues the new one, and writes a correction note", async () => {
    const job = await sarahsJob(db);
    const oldInvoice = await db.invoice.findUniqueOrThrow({ where: { id: job.invoiceId }, include: { lines: true } });
    await db.invoice.update({ where: { id: job.invoiceId }, data: { gstApplied: true, gstAmount: 8818 } });

    const res = await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Bob logged 5h, he worked 2h." });
    expect(res.status).toBe(200);
    const body = res.body as { toast: string; newInvoiceReference: string };
    expect(body.toast).toBe(`Corrected - ${body.newInvoiceReference} sent.`);

    const old = await db.invoice.findUniqueOrThrow({ where: { id: job.invoiceId } });
    expect(old.status).toBe("void");
    expect(old.voidReason).toContain("hours 5.0h -> 2.0h");
    expect(old.voidReason).toContain("$970.00 -> $430.00");
    expect(old.voidReason).toContain("Bob logged 5h, he worked 2h.");
    expect(old.voidedByUserId).not.toBeNull();
    expect(old.voidedAt).not.toBeNull();

    const fresh = await db.invoice.findFirstOrThrow({ where: { replacesInvoiceId: old.id }, include: { lines: { orderBy: { id: "asc" } } } });
    expect(fresh.reference).toBe(body.newInvoiceReference);
    expect(fresh).toMatchObject({ status: "sent", amount: 43_000, labourAmount: 43_000, gstApplied: true, customerId: old.customerId, jobId: old.jobId });
    // GST recomputed from the amended figure; the treatment copied from the voided document.
    expect(fresh.gstAmount).toBe(Math.round((43_000 * 10) / 110));
    expect(fresh.lines.map((line) => [line.description, Number(line.qty), line.unitPrice, line.lineTotal])).toEqual([
      [oldInvoice.lines[0]?.description, 1, 25_000, 25_000],
      ["Additional 1.0h @ $180/h", 1, 18_000, 18_000],
    ]);

    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } });
    expect(assignment).toMatchObject({ invoiceId: fresh.id, contractorPay: 35_000 });
    expect(Number(assignment.billedHours)).toBe(2);
    const logs = await db.assignmentTimeLog.findMany({ where: { assignmentId: job.assignmentId } });
    expect(logs).toHaveLength(1);

    const jobRow = await db.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(jobRow.operatorNotes).toEqual([expect.objectContaining({ type: "correction", note: "Bob logged 5h, he worked 2h.", assignmentId: job.assignmentId })]);
  });

  test("AC1: lowering only a price leaves Bob's pay and hours alone", async () => {
    const job = await sarahsJob(db);
    const res = await correct(job.jobReference, { prices: { callout: 20_000 }, reason: "Goodwill on the call-out." });
    expect(res.status).toBe(200);
    const fresh = await db.invoice.findFirstOrThrow({ where: { replacesInvoiceId: job.invoiceId } });
    expect(fresh.amount).toBe(92_000);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } });
    expect(assignment.contractorPay).toBe(80_000);
    expect(Number(assignment.billedHours)).toBe(5);
    // The card says nothing about Bob's pay when no hour changed.
    const card = await preview(job.jobReference, { prices: { callout: 20_000 } });
    expect((card.body as { contractor: unknown }).contractor).toBeNull();
  });

  test("a second correction is measured from the invoice that replaced the first: it can never undo the first discount", async () => {
    const job = await sarahsJob(db);
    await correct(job.jobReference, { prices: { callout: 20_000 }, reason: "First." }).expect(200);
    const second = await correct(job.jobReference, { prices: { callout: 22_000 }, reason: "Second." });
    expect(second.status).toBe(400);
    expect((second.body as { error: string }).error).toBe("Can only go down - the most is $200.00.");
  });

  test("it refuses when nothing changed", async () => {
    const job = await sarahsJob(db);
    const res = await correct(job.jobReference, { prices: { callout: 25_000 }, reason: "Nothing." });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("Nothing to correct - change the time or a price.");
  });
});

describe("AC2 -- Sarah's Updated invoice message", () => {
  test("AC2: one Updated invoice email (PDF attached) and one text, no 'corrected', no amounts; the Invoice message is not sent", async () => {
    const job = await sarahsJob(db);
    const res = await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Logged 5h, worked 2h." });
    const { newInvoiceReference } = res.body as { newInvoiceReference: string };
    const fresh = await db.invoice.findFirstOrThrow({ where: { reference: newInvoiceReference } });
    await untilLinked(db, fresh.id);
    await drainOnce(db);

    const mail = email.sent.find((m) => m.to === "sarah@idelta.com.au");
    expect(mail?.message.subject).toBe(`Invoice ${newInvoiceReference} - ${job.jobReference}`);
    const text = mail?.message.text ?? "";
    expect(text).toContain("Hi Sarah,");
    expect(text).toContain(`Attached is the updated invoice for your plumbing job ${job.jobReference}.`);
    expect(text).toContain(`Invoice ${newInvoiceReference} replaces ${job.invoiceReference}.`);
    expect(text).toContain(`Pay now: https://pay.test/${newInvoiceReference}`);
    expect(text).toContain("Questions about this bill? Call us on");
    expect(text.toLowerCase()).not.toContain("corrected");
    expect(text).not.toContain("$");
    expect(mail?.attachments).toHaveLength(1);
    expect(pdfText(mail?.attachments?.[0]?.content as Uint8Array)).toContain(newInvoiceReference);

    const text2 = sms.sent[0]?.message.text ?? "";
    expect(text2).toContain(`updated invoice ${newInvoiceReference} for ${job.jobReference}, replaces ${job.invoiceReference}`);
    expect(text2.toLowerCase()).not.toContain("corrected");
    expect(text2).not.toContain("$");

    const types = (await db.notification.findMany({ where: { jobId: job.jobId } })).map((row) => row.type);
    expect(types.filter((type) => type === "invoice_updated")).toHaveLength(2);
    expect(types).not.toContain("invoice");
  });

  test("AC2: the old invoice sends no more reminders once voided", async () => {
    const job = await sarahsJob(db);
    await db.invoice.update({ where: { id: job.invoiceId }, data: { dueAt: new Date(Date.now() - 10 * 86_400_000) } });
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Fix." }).expect(200);
    const run = await runInvoiceReminders(db, { zone: "Australia/Perth" });
    expect(run.first).toBe(0);
    expect(await db.notification.count({ where: { type: "invoice_reminder_1", relatedId: job.invoiceId } })).toBe(0);
  });
});

describe("AC3 -- the refusals", () => {
  test("AC3: a price above the replaced invoice's is refused with the most it can be", async () => {
    const job = await sarahsJob(db);
    const res = await correct(job.jobReference, { prices: { callout: 25_001 }, reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Can only go down - the most is $250.00.", field: "prices.callout" });
    const hourly = await correct(job.jobReference, { prices: { hourly: 18_001 }, reason: "x" });
    expect((hourly.body as { error: string }).error).toBe("Can only go down - the most is $180.00.");
    expect(await db.invoice.count()).toBe(1);
  });

  test("AC3: the reason is required", async () => {
    const job = await sarahsJob(db);
    const res = await correct(job.jobReference, { prices: { callout: 20_000 }, reason: "   " });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Required.", field: "reason" });
  });

  test("AC3: the preview reports a too-high price as a field error, not a crash", async () => {
    const job = await sarahsJob(db);
    const res = await preview(job.jobReference, { prices: { callout: 30_000 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ errors: [{ field: "prices.callout", error: "Can only go down - the most is $250.00." }] });
  });

  test("AC3: a contractor cannot reach the page or the endpoints; nor a signed-out visitor", async () => {
    const job = await sarahsJob(db);
    const bob = await signIn(app, "bob@idelta.com.au");
    await request(app).get(`/api/jobs/${job.jobReference}/correct`).set("Cookie", bob).expect(403);
    await preview(job.jobReference, {}, bob).expect(403);
    await correct(job.jobReference, { prices: { callout: 20_000 }, reason: "x" }, bob).expect(403);
    await request(app).get(`/api/jobs/${job.jobReference}/correct`).expect(401);
    expect(await db.invoice.count()).toBe(1);
  });
});

describe("AC4 -- the fresh pay link", () => {
  test("AC4: the new invoice gets its own link; the old link is switched off", async () => {
    const job = await sarahsJob(db);
    const res = await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "10:00")], reason: "Fix." });
    const { newInvoiceReference } = res.body as { newInvoiceReference: string };
    const fresh = await db.invoice.findFirstOrThrow({ where: { reference: newInvoiceReference } });
    await untilLinked(db, fresh.id);
    expect(seam.made).toEqual([newInvoiceReference]);
    expect(seam.switchedOff).toEqual([`plink_${job.invoiceReference}`]);
    const linked = await db.invoice.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(linked.stripePaymentLinkUrl).toBe(`https://pay.test/${newInvoiceReference}`);
  });
});

describe("AC5 -- a paid invoice is refunded, never voided", () => {
  test("AC5: lowering the call-out on a paid invoice leaves it Paid and refunds the difference; Sarah gets the refund email", async () => {
    const job = await sarahsJob(db);
    await payInFull(db, job);
    const res = await correct(job.jobReference, { prices: { callout: 20_000 }, reason: "Goodwill on the call-out." });
    expect(res.status).toBe(200);
    const body = res.body as { toast: string; refundReference: string; newInvoiceReference: string | null };
    expect(body.toast).toBe(`Corrected - refund ${body.refundReference} made.`);
    expect(body.newInvoiceReference).toBeNull();

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: job.invoiceId } });
    expect(invoice.status).toBe("paid");
    expect(await db.invoice.count()).toBe(1);
    expect(stripe.calls).toEqual([expect.objectContaining({ amount: 5000, paymentIntentId: `pi_${job.invoiceReference}` })]);
    const refund = await db.refund.findFirstOrThrow({ where: { invoiceId: job.invoiceId } });
    expect(refund).toMatchObject({ amount: 5000, status: "succeeded", reason: "Goodwill on the call-out.", reference: body.refundReference });
    expect(refund.approvedByUserId).not.toBeNull();

    await drainOnce(db);
    expect(email.sent.some((m) => (m.message.subject ?? "").startsWith(`Refund ${body.refundReference}`))).toBe(true);
  });

  test("AC5: the refund is the new difference less what was already given back", async () => {
    const job = await sarahsJob(db);
    await payInFull(db, job);
    const { makeRefund } = await import("../src/refunds/service.js");
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    await makeRefund(db, { invoiceId: job.invoiceId, amount: 3000, reason: "Earlier", byUserId: mikeUser.id });
    await correct(job.jobReference, { prices: { callout: 20_000 }, reason: "More." }).expect(200);
    const refunds = await db.refund.findMany({ where: { invoiceId: job.invoiceId }, orderBy: { createdAt: "asc" } });
    expect(refunds.map((refund) => refund.amount)).toEqual([3000, 2000]);

    const card = await preview(job.jobReference, { prices: { callout: 20_000 } });
    expect((card.body as { customer: { action: string } }).customer.action).toBe("none");
  });

  test("AC5: the preview says how much goes back; Stripe saying no saves nothing", async () => {
    const job = await sarahsJob(db);
    await payInFull(db, job);
    const card = await preview(job.jobReference, { prices: { callout: 20_000 } });
    expect((card.body as { customer: { sentence: string } }).customer.sentence).toBe("$50.00 goes back to Sarah as a refund.");

    stripe.refuse = "card closed";
    const res = await correct(job.jobReference, { prices: { callout: 20_000 }, reason: "Goodwill." });
    expect(res.status).toBe(502);
    expect(await db.refund.count()).toBe(0);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.jobId } }).then((row) => row.operatorNotes)).toBeNull();
  });
});

describe("AC6 -- hours up never raise the invoice", () => {
  test("AC6: 2h -> 3h leaves Sarah's invoice as it is and pays Bob the extra hour", async () => {
    const job = await sarahsJob(db, { hours: 2 });
    const card = await preview(job.jobReference, { timeEntries: [entry(DAY, "08:00", "11:00")] });
    expect(card.body).toEqual({
      ok: true,
      customer: { label: "Sarah's invoice", from: 43_000, to: 43_000, action: "none", sentence: "Sarah's invoice stays as it is." },
      contractor: { label: "Bob's pay", from: 35_000, to: 50_000, sentence: "It goes on their next payout." },
    });
    const res = await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "11:00")], reason: "Worked 3h, logged 2h." });
    expect(res.status).toBe(200);
    expect((res.body as { toast: string }).toast).toBe("Corrected.");
    expect(await db.invoice.count()).toBe(1);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: job.invoiceId } })).status).toBe("sent");
    expect((await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } })).contractorPay).toBe(50_000);
  });

  test("AC6: hours up and a price down together: the new price on the hours first billed", async () => {
    const job = await sarahsJob(db, { hours: 2 });
    await correct(job.jobReference, { timeEntries: [entry(DAY, "08:00", "11:00")], prices: { hourly: 15_000 }, reason: "Goodwill, and a missed hour." }).expect(200);
    const fresh = await db.invoice.findFirstOrThrow({ where: { replacesInvoiceId: job.invoiceId }, include: { lines: { orderBy: { id: "asc" } } } });
    expect(fresh.amount).toBe(25_000 + 15_000); // 2.0h billed, not 3
    expect(fresh.lines.map((line) => line.description)).toEqual([expect.stringContaining("Call-out + first hour"), "Additional 1.0h @ $150/h"]);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } })).contractorPay).toBe(50_000);
  });
});

describe("AC9 -- a no-show call-out and a $0 follow-up", () => {
  async function noShowInvoice(): Promise<{ jobReference: string; invoiceId: string; assignmentId: string; jobId: string }> {
    const visit = await completedVisit(db, { contractorCode: "CON-014", day: DAY, hours: 1 });
    await db.job.update({ where: { id: visit.jobId }, data: { status: "cancelled", cancelReason: "customer_no_show" } });
    await db.assignment.update({
      where: { id: visit.assignmentId },
      data: { status: "cancelled", cancelledAt: new Date(), completedAt: null, billedHours: null, contractorPay: 15_000, materialsReimbursement: null },
    });
    await db.assignmentTimeLog.deleteMany({ where: { assignmentId: visit.assignmentId } });
    const invoice = await db.invoice.findFirstOrThrow({ where: { jobId: visit.jobId } });
    await db.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } });
    await db.invoiceLine.create({
      data: { invoiceId: invoice.id, kind: "callout", description: "Call-out fee - no access / customer unavailable", qty: 1, unitPrice: 12_000, lineTotal: 12_000 },
    });
    await db.invoice.update({
      where: { id: invoice.id },
      data: { amount: 12_000, labourAmount: 12_000, stripePaymentLinkUrl: "https://pay.test/x", stripePaymentLinkId: "plink_x" },
    });
    return { jobReference: visit.jobReference, invoiceId: invoice.id, assignmentId: visit.assignmentId, jobId: visit.jobId };
  }

  test("AC9: the no-show page offers only the Call-out fee, and no time", async () => {
    const job = await noShowInvoice();
    const form = (await request(app).get(`/api/jobs/${job.jobReference}/correct`).set("Cookie", mike)).body as Form;
    expect(form.kind).toBe("no_show");
    expect(form.timeEntries).toBeNull();
    expect(form.prices).toEqual({ callout: { label: "Call-out fee", was: 12_000 }, hourly: null, parts: [] });
  });

  test("AC9: lowering the call-out fee voids and reissues; Bob's call-out pay does not change", async () => {
    const job = await noShowInvoice();
    const res = await correct(job.jobReference, { prices: { callout: 6000 }, reason: "Goodwill." });
    expect(res.status).toBe(200);
    const fresh = await db.invoice.findFirstOrThrow({ where: { replacesInvoiceId: job.invoiceId }, include: { lines: true } });
    expect(fresh.amount).toBe(6000);
    expect(fresh.lines).toEqual([expect.objectContaining({ kind: "callout", unitPrice: 6000, lineTotal: 6000 })]);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: job.assignmentId } })).contractorPay).toBe(15_000);
    const over = await correct(job.jobReference, { prices: { callout: 7000 }, reason: "x" });
    expect((over.body as { error: string }).error).toBe("Can only go down - the most is $60.00.");
  });

  test("AC9: a $0 follow-up takes only a time change; its invoice stays as it is", async () => {
    const visit = await completedVisit(db, { contractorCode: "CON-030", day: DAY, hours: 1, callbackChargeable: false });
    await db.assignment.update({ where: { id: visit.assignmentId }, data: { contractorPay: 0 } });
    const form = (await request(app).get(`/api/jobs/${visit.jobReference}/correct`).set("Cookie", mike)).body as Form;
    expect(form.kind).toBe("zero");
    expect(form.prices).toBeNull();

    const res = await correct(visit.jobReference, { timeEntries: [entry(DAY, "08:00", "09:30")], prices: { callout: 0 }, reason: "Stayed 90 minutes." });
    expect(res.status).toBe(200);
    expect(await db.invoice.count()).toBe(1);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: visit.assignmentId } });
    // His own earlier work: still nothing.
    expect(assignment.contractorPay).toBe(0);
    expect(Number(assignment.billedHours)).toBe(1.5);
  });
});
