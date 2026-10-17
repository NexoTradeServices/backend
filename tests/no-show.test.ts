// Feature 6004 -- Mark no-show (Ops job actions / Mark no-show)
//
// AC9  scheduled and in-progress only; a contractor gets 403
// AC10 charged: Cancelled / Customer no-show, booking cancelled and block freed, Bob paid the call-out,
//      a call-out invoice, one Missed visit email (invoice attached, pay link) and text, no invoice message
// AC11 waived: the same close and pay, no invoice, the courtesy wording
// AC12 Bob, the site contact and the office inbox are sent nothing
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { pdfText } from "./helpers/agreements.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { payLinkPass } from "../src/invoices/pay-link.js";
import { setPayLinkProvider } from "../src/invoices/stripe.js";
import { acceptJob1042, buildOpsApp, freshWorld, makeNewJob, signIn } from "./helpers/ops-app.js";
import { fakeStripe } from "./helpers/callbacks.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-6004-noshow", "email");
const sms = recordingAdapter("test-sms-6004-noshow", "sms");

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  registerProvider(sms);
  app = buildOpsApp(db);
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

beforeEach(async () => {
  await freshWorld(db, email);
  await setProviders(db, { emailProvider: email.name, smsProvider: sms.name, providerOverrides: null });
  sms.reset();
  // Complete's and Mark no-show's own first try does nothing; each test runs the pass itself.
  setPayLinkProvider(null);
});

afterEach(async () => {
  setPayLinkProvider(undefined);
  await resetReferenceSequences(db);
});

/** Let the accept's own messages go, then start counting from nothing. */
async function settle(): Promise<void> {
  await drainOnce(db);
  email.reset();
  sms.reset();
}

const noShow = (cookie: string, reference: string, body: Record<string, unknown>) =>
  request(app).post(`/api/jobs/${reference}/no-show`).set("Cookie", cookie).send(body);

describe("AC9 -- when it is offered, and to whom", () => {
  test("AC9: scheduled and in progress are allowed; new, assigned and completed are refused with 409; the flag follows the status", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const fresh = await makeNewJob(db);
    expect((await noShow(mike, fresh.reference, { charge: true })).status).toBe(409);
    // JOB-1042 is dispatched and waiting for Bob: no booking is held yet.
    expect((await noShow(mike, "JOB-1042", { charge: true })).status).toBe(409);
    const { jobId } = await acceptJob1042(db, app);
    const read = async () =>
      (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as { canMarkNoShow: boolean };
    expect((await read()).canMarkNoShow).toBe(true);
    await db.job.update({ where: { id: jobId }, data: { status: "completed" } });
    expect((await read()).canMarkNoShow).toBe(false);
    expect((await noShow(mike, "JOB-1042", { charge: true })).status).toBe(409);
    await db.job.update({ where: { id: jobId }, data: { status: "in_progress" } });
    await db.assignment.updateMany({ where: { jobId }, data: { status: "in_progress" } });
    expect((await read()).canMarkNoShow).toBe(true);
    expect((await noShow(mike, "JOB-1042", { charge: false })).status).toBe(200);
  });

  test("AC9: a contractor gets 403 and nothing changes; charge must be true or false", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = await signIn(app, "bob@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    expect((await noShow(bob, "JOB-1042", { charge: true })).status).toBe(403);
    const bad = await noShow(mike, "JOB-1042", {});
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: "charge" });
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("scheduled");
  });
});

describe("AC10 -- charged", () => {
  test("AC10: the job closes, the booking is cancelled and freed, Bob is paid the call-out, and the call-out invoice is issued", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const settings = await db.platformSettings.findFirstOrThrow();

    const res = await noShow(mike, "JOB-1042", { charge: true });
    expect(res.status).toBe(200);
    const body = res.body as { toast: string; job: { status: string; cancelled: { reasonLabel: string; byName: string }; invoice: { lines: { description: string }[] } } };
    expect(body.toast).toBe("Marked JOB-1042 as a no-show.");
    expect(body.job.status).toBe("cancelled");
    expect(body.job.cancelled).toMatchObject({ reasonLabel: "Customer no-show", byName: "Mike" });

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "cancelled", cancelReason: "customer_no_show", cancelledByUserId: mikeUser.id });
    expect(job.cancelledAt).not.toBeNull();
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment).toMatchObject({ status: "cancelled", cancelledByUserId: mikeUser.id, contractorPay: settings.calloutFee });
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(0);

    const invoice = await db.invoice.findFirstOrThrow({ where: { jobId }, include: { lines: true } });
    expect(invoice).toMatchObject({ amount: settings.calloutFee, isZeroDollar: false, status: "sent" });
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]).toMatchObject({ kind: "callout", unitPrice: settings.calloutFee, lineTotal: settings.calloutFee });
    expect(Number(invoice.lines[0]?.qty)).toBe(1);
    expect(invoice.lines[0]?.description).toBe("Call-out fee - no access / customer unavailable");
    expect(body.job.invoice.lines.map((l) => l.description)).toEqual([invoice.lines[0]?.description]);
  });

  test("AC10: the pay-link pass sends one Missed visit email (invoice attached, pay link) and one text, and no invoice message", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    await settle();
    await noShow(mike, "JOB-1042", { charge: true });
    await drainOnce(db);
    expect(email.sent).toHaveLength(0); // nothing goes until the invoice has its link

    const stripe = fakeStripe();
    expect(await payLinkPass(db, { provider: stripe })).toBe(1);
    await drainOnce(db);

    const invoice = await db.invoice.findFirstOrThrow({ where: { jobId } });
    expect(await db.notification.count({ where: { jobId, type: "invoice" } })).toBe(0);
    expect(await db.notification.count({ where: { jobId, type: "missed_visit" } })).toBe(2);
    const mail = email.sent.find((m) => m.to === "sarah@idelta.com.au");
    expect(email.sent).toHaveLength(1);
    expect(mail?.message.subject).toBe("Missed visit - JOB-1042");
    expect(mail?.message.text).toContain(`https://pay.test/${invoice.reference}`);
    expect(mail?.message.text).not.toContain("$");
    expect(mail?.attachments).toHaveLength(1);
    expect(pdfText(mail?.attachments?.[0]?.content ?? new Uint8Array())).toContain(invoice.reference);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.to).not.toBe("");
    expect(sms.sent[0]?.message.text).toContain(`https://pay.test/${invoice.reference}`);

    // A second pass changes nothing.
    expect(await payLinkPass(db, { provider: stripe })).toBe(0);
    expect(await db.notification.count({ where: { jobId, type: "missed_visit" } })).toBe(2);
  });
});

describe("AC11 -- waived", () => {
  test("AC11: the same close and the same pay, no invoice, and the courtesy wording by email and text", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    const settings = await db.platformSettings.findFirstOrThrow();
    await settle();

    expect((await noShow(mike, "JOB-1042", { charge: false })).status).toBe(200);
    expect(await db.invoice.count({ where: { jobId } })).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).cancelReason).toBe("customer_no_show");
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).contractorPay).toBe(settings.calloutFee);

    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "sarah@idelta.com.au");
    expect(email.sent).toHaveLength(1);
    expect(mail?.message.text).toContain("As a courtesy, we've waived the call-out fee.");
    expect(mail?.attachments ?? []).toHaveLength(0);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.message.text).toContain("We've waived the call-out fee.");
  });

  test("AC11: a call-out fee of $0 reads as waived, even when charged was ticked", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    await db.platformSettings.updateMany({ data: { calloutFee: 0 } });
    expect((await noShow(mike, "JOB-1042", { charge: true })).status).toBe(200);
    expect(await db.invoice.count({ where: { jobId } })).toBe(0);
  });
});

describe("AC12 -- nobody else hears", () => {
  test("AC12: Bob, Lena and the office inbox are sent nothing, charged or waived", async () => {
    for (const charge of [true, false]) {
      await freshWorld(db, email);
      await setProviders(db, { emailProvider: email.name, smsProvider: sms.name, providerOverrides: null });
      const mike = await signIn(app, "mike@idelta.com.au");
      const { jobId } = await acceptJob1042(db, app);
      await settle();
      await noShow(mike, "JOB-1042", { charge });
      await payLinkPass(db, { provider: fakeStripe() });
      await drainOnce(db);
      const rows = await db.notification.findMany({ where: { jobId, createdAt: { gte: new Date(Date.now() - 60_000) } } });
      const noShowRows = rows.filter((row) => row.type === "missed_visit");
      expect(noShowRows.every((row) => row.recipientType === "customer")).toBe(true);
      expect(rows.filter((row) => row.type === "job_cancelled" || row.type === "job_cancelled_contractor")).toHaveLength(0);
      const everyone = [...email.sent, ...sms.sent].map((m) => m.to);
      expect(everyone).not.toContain("bob@idelta.com.au");
      expect(everyone).not.toContain("lena@idelta.com.au");
      expect(everyone).not.toContain("ops@idelta.com.au");
    }
  });
});
