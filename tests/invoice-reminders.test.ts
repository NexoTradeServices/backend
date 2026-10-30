// Feature 6008 -- invoice reminders: the daily sweep
//
// AC1  at or after 9:00am the sweep sends Sarah one "Invoice due today - INV-xxxx" email for an
//      invoice due today; a second run, or a restart, sends nothing more
// AC2  an invoice due in the past with no reminder gets reminder 1 on the next run; one still
//      waiting for its pay link gets none
// AC3  seven business days after reminder 1 the "Invoice overdue" email, with the days overdue;
//      never before, never twice, never both on one morning
// AC4  a paid, void or zero-dollar invoice gets none; the site contact never gets one
// AC5  neither carries an amount or "contractor"; both carry the references, a Pay now button to
//      the pay link, the office number and the "just paid" line
// AC6  before 9:00am the sweep sends nothing; one failing step does not stop the other
//
// No test reaches Mailjet or Stripe: the email adapter records, and the pay-link seam is a fake.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { owedInvoice } from "./helpers/owed-invoice.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { DAILY_STEPS, dailyTick, runDailySteps, type DailyStep } from "../src/daily/index.js";
import { runInvoiceReminders } from "../src/invoices/reminders.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

const ZONE = "Australia/Perth";
// 9:05am Wed 14 Oct 2026 in Perth
const MORNING = new Date("2026-10-14T01:05:00.000Z");
// 8:59am the same morning
const BEFORE_NINE = new Date("2026-10-14T00:59:00.000Z");
// Noon Wed 14 Oct, Perth
const DUE_TODAY = new Date("2026-10-14T04:00:00.000Z");
const DAY = 86_400_000;

let db: PrismaClient;
const email = recordingAdapter("test-email-6008", "email");

beforeAll(() => {
  db = testClient();
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function remindersOf(jobId: string, type?: string) {
  return db.notification.findMany({
    where: { jobId, type: type ?? { in: ["invoice_reminder_1", "invoice_reminder_2"] } },
    orderBy: { createdAt: "asc" },
  });
}

describe("AC1 -- reminder 1 on the due date", () => {
  test("AC1: Sarah's invoice due today gets one 'Invoice due today' email at 9:05am; a second run and a restart send nothing more", async () => {
    const sarahs = await owedInvoice(db, { dueAt: DUE_TODAY });

    const first = await dailyTick(db, MORNING);
    expect(first?.failed).toEqual([]);
    const rows = await remindersOf(sarahs.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "invoice_reminder_1",
      channel: "email",
      recipientType: "customer",
      recipientId: sarahs.customerId,
      relatedType: "invoice",
      relatedId: sarahs.invoiceId,
      jobId: sarahs.jobId,
      idempotencyKey: `invoice_reminder_1:invoice:${sarahs.invoiceId}:email`,
    });

    await dailyTick(db, new Date(MORNING.getTime() + 5 * 60_000));
    await dailyTick(db, new Date(MORNING.getTime() + 6 * 3_600_000)); // later that day -- a restart
    expect(await remindersOf(sarahs.jobId)).toHaveLength(1);

    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("sarah@idelta.com.au");
    expect(email.sent[0]?.message.subject).toBe(`Invoice due today - ${sarahs.invoiceReference}`);
  });

  test("AC1: an invoice due tomorrow gets nothing today", async () => {
    const sarahs = await owedInvoice(db, { dueAt: new Date(DUE_TODAY.getTime() + DAY) });
    await dailyTick(db, MORNING);
    expect(await remindersOf(sarahs.jobId)).toHaveLength(0);
  });
});

describe("AC2 -- a missed morning, and a late pay link", () => {
  test("AC2: due 10 days ago with no reminder gets reminder 1 on the next run; Margaret, still waiting for her link, gets none until it exists", async () => {
    const toms = await owedInvoice(db, { customerCode: "CUS-1052", dueAt: new Date(DUE_TODAY.getTime() - 10 * DAY) });
    const waiting = await owedInvoice(db, { dueAt: new Date(DUE_TODAY.getTime() - 3 * DAY), withLink: false });

    await dailyTick(db, MORNING);
    expect((await remindersOf(toms.jobId)).map((r) => r.type)).toEqual(["invoice_reminder_1"]);
    expect(await remindersOf(waiting.jobId)).toHaveLength(0);

    // The link arrives; the next run sends it.
    await db.invoice.update({
      where: { id: waiting.invoiceId },
      data: { stripePaymentLinkUrl: "https://pay.test/late", stripePaymentLinkId: "plink_late" },
    });
    await dailyTick(db, new Date(MORNING.getTime() + 5 * 60_000));
    expect((await remindersOf(waiting.jobId)).map((r) => r.type)).toEqual(["invoice_reminder_1"]);
  });
});

describe("AC3 -- reminder 2, seven days after the first", () => {
  async function withReminder1On(day: string) {
    const nina = await owedInvoice(db, {
      customer: { name: "Nina Rossi", email: "nina@idelta.com.au", businessName: "Rossi's Cafe" },
      dueAt: new Date("2026-10-06T04:00:00.000Z"),
    });
    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-07" });
    await db.notification.updateMany({ where: { jobId: nina.jobId }, data: { createdAt: new Date(`${day}T04:00:00.000Z`) } });
    return nina;
  }

  test("AC3: not at 6 days, sent at 7 with the days overdue, never twice", async () => {
    const nina = await withReminder1On("2026-10-07");

    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-13" });
    expect((await remindersOf(nina.jobId)).map((r) => r.type)).toEqual(["invoice_reminder_1"]);

    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-14" });
    const rows = await remindersOf(nina.jobId);
    expect(rows.map((r) => r.type)).toEqual(["invoice_reminder_1", "invoice_reminder_2"]);
    expect(rows[1]).toMatchObject({ idempotencyKey: `invoice_reminder_2:invoice:${nina.invoiceId}:email`, recipientType: "customer" });
    expect((rows[1]?.context as Record<string, unknown>)["daysOverdueText"]).toBe("8 days");

    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-14" });
    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-30" });
    expect(await remindersOf(nina.jobId)).toHaveLength(2);
  });

  test("AC3: an invoice with no reminder yet, however overdue, gets only reminder 1 that morning -- never both", async () => {
    const toms = await owedInvoice(db, { customerCode: "CUS-1052", dueAt: new Date(DUE_TODAY.getTime() - 20 * DAY) });
    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-14" });
    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-14" });
    expect((await remindersOf(toms.jobId)).map((r) => r.type)).toEqual(["invoice_reminder_1"]);
  });
});

describe("AC4 -- who gets none", () => {
  test("AC4: a paid, a void and a zero-dollar invoice get no reminder", async () => {
    const past = new Date(DUE_TODAY.getTime() - 5 * DAY);
    const paid = await owedInvoice(db, { status: "paid", dueAt: past });
    const voided = await owedInvoice(db, { status: "void", dueAt: past });
    const zero = await owedInvoice(db, { isZeroDollar: true, dueAt: past });
    await dailyTick(db, MORNING);
    for (const invoice of [paid, voided, zero]) {
      expect(await remindersOf(invoice.jobId)).toHaveLength(0);
    }
    expect(await db.notification.count()).toBe(0);
  });

  test("AC4: the site contact never gets one -- Sarah's job with Lena as site contact sends Sarah's reminder only", async () => {
    const sarahs = await owedInvoice(db, { dueAt: DUE_TODAY });
    await db.job.update({
      where: { id: sarahs.jobId },
      data: { siteContact: { name: "Lena Park", email: "lena@idelta.com.au", phone: "0400 001 051" } },
    });
    await dailyTick(db, MORNING);
    await drainOnce(db);
    expect(email.sent.map((m) => m.to)).toEqual(["sarah@idelta.com.au"]);
    expect((await remindersOf(sarahs.jobId)).every((r) => r.recipientType === "customer")).toBe(true);
  });
});

describe("AC5 -- the wording", () => {
  test("AC5: both reminders are money-free and carry the references, the Pay now link, the office number and the ignore line", async () => {
    const sarahs = await owedInvoice(db, { dueAt: new Date("2026-10-06T04:00:00.000Z"), amount: 65_500 });
    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-07" });
    await db.notification.updateMany({ where: { jobId: sarahs.jobId }, data: { createdAt: new Date("2026-10-07T04:00:00.000Z") } });
    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-14" });
    await drainOnce(db);

    expect(email.sent).toHaveLength(2);
    const [one, two] = email.sent.map((m) => m.message);
    expect(one?.subject).toBe(`Invoice due today - ${sarahs.invoiceReference}`);
    expect(two?.subject).toBe(`Invoice overdue - ${sarahs.invoiceReference}`);
    expect(one?.text).toContain(`Your invoice ${sarahs.invoiceReference} for your plumbing job ${sarahs.jobReference} is due today.`);
    expect(two?.text).toContain(`Your invoice ${sarahs.invoiceReference} for ${sarahs.jobReference} is now 8 days overdue.`);
    expect(two?.text).toContain("We'll be in touch.");
    for (const message of [one, two]) {
      const everything = `${message?.subject ?? ""}\n${message?.text ?? ""}\n${message?.html ?? ""}`;
      expect(everything).not.toMatch(/\$|655|contractor/i);
      expect(message?.text).toContain(`https://pay.test/${sarahs.invoiceReference}`);
      expect(message?.html).toContain(`href="https://pay.test/${sarahs.invoiceReference}"`);
      expect(message?.html).toContain("Pay now");
      expect(message?.text).toContain("08 0000 0000");
      expect(message?.text).toContain("If you've just paid, please ignore this.");
    }
  });
});

describe("6015 AC11 -- the accounts phone on the reminders", () => {
  test("AC11: the reminder shows the accounts phone when set, the operator phone when blank", async () => {
    await db.platformSettings.updateMany({ data: { accountsPhone: "08 9111 2222" } });
    await owedInvoice(db, { dueAt: new Date("2026-10-06T04:00:00.000Z"), amount: 65_500 });
    await runInvoiceReminders(db, { zone: ZONE, today: "2026-10-07" });
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.message.text).toContain("08 9111 2222");
    expect(email.sent[0]?.message.text).not.toContain("08 0000 0000");
  });
});

describe("AC6 -- the hour, and a failing step", () => {
  test("AC6: at 8:59am the sweep sends nothing; at 9:00am it runs", async () => {
    const sarahs = await owedInvoice(db, { dueAt: DUE_TODAY });
    expect(await dailyTick(db, BEFORE_NINE)).toBeNull();
    expect(await remindersOf(sarahs.jobId)).toHaveLength(0);

    const result = await dailyTick(db, new Date("2026-10-14T01:00:00.000Z"));
    expect(result?.ran).toEqual(["invoice reminders", "pay-link switch-off", "licence and insurance alerts", "job-tomorrow reminders"]);
    expect(await remindersOf(sarahs.jobId)).toHaveLength(1);
  });

  test("AC6: a step that throws is logged, and the other steps still do their work", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sarahs = await owedInvoice(db, { dueAt: DUE_TODAY });
    const boom: DailyStep = { name: "boom", run: () => Promise.reject(new Error("a step failed")) };
    const result = await runDailySteps(db, { zone: ZONE, now: MORNING, steps: [boom, ...DAILY_STEPS] });
    expect(result.failed).toEqual(["boom"]);
    expect(result.ran).toEqual(["invoice reminders", "pay-link switch-off", "licence and insurance alerts", "job-tomorrow reminders"]);
    expect(await remindersOf(sarahs.jobId)).toHaveLength(1);
  });
});
