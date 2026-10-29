// Feature 7004 -- the job-tomorrow reminder: the daily sweep's "job-tomorrow reminders" step
//
// AC1  the morning run on Mon 2 Nov sends Sarah a "Job tomorrow - JOB-1042, 9:00am AWST" email and a text for
//      Bob's Tue 3 Nov 9:00am visit, with the address and "let Bob in", no `$`, no link besides the account offer
// AC2  with Lena as site contact she gets her own email and text; Sarah's copy says the site contact has been
//      reminded too; Lena's carry no account offer
// AC3  runs every few minutes for the rest of that day send nothing more
// AC4  a visit booked for today gets no reminder
// AC5  a visit for tomorrow confirmed at 11:00am today gets none, then or the next morning
// AC6  a visit two days away gets its reminder on the morning before, not this morning
// AC7  a job with two visits gets one reminder per visit, each the day before its own visit
// AC8  a cancelled job, or a visit taken off, gets no reminder for that block
// AC10 the job page's message list names the rows "Job tomorrow"
// (AC9, the Job booked line, is proved in respond.test.ts.)
//
// No test reaches Mailjet or ClickSend: both channels get recording adapters, and the clock is fixed.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, seedCast, setProviders } from "./helpers/notifications.js";
import { dailyTick, DAILY_RUN_AT, runDailySteps } from "../src/daily/index.js";
import { jobTomorrowKey, nextDay, reminderWillCome } from "../src/jobs/job-tomorrow.js";
import { messageName } from "../src/jobs/messages.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { Prisma } from "../src/generated/prisma/client.js";
import type { PrismaClient } from "../src/db/client.js";

const ZONE = "Australia/Perth";
// 9:05am Mon 2 Nov 2026 in Perth
const MORNING = new Date("2026-11-02T01:05:00.000Z");
// 8:55am the same morning
const BEFORE_NINE = new Date("2026-11-02T00:55:00.000Z");
// 9:00am Tue 3 Nov, Perth -- tomorrow's visit
const TOMORROW_9AM = new Date("2026-11-03T01:00:00.000Z");
// 9:00am Mon 2 Nov, 2:00pm Mon 2 Nov, 9:00am Wed 4 Nov, 9:00am Thu 5 Nov
const TODAY_2PM = new Date("2026-11-02T06:00:00.000Z");
const WED_9AM = new Date("2026-11-04T01:00:00.000Z");
const THU_9AM = new Date("2026-11-05T01:00:00.000Z");
// Booked at 4:00pm the day before, 11:00am today
const YESTERDAY_4PM = new Date("2026-11-01T08:00:00.000Z");
const TODAY_11AM = new Date("2026-11-02T03:00:00.000Z");

let db: PrismaClient;
const email = recordingAdapter("test-email-7004", "email");
const sms = recordingAdapter("test-sms-7004", "sms");

beforeAll(() => {
  db = testClient();
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
  await seedCast(db);
  await setProviders(db, { emailProvider: email.name, smsProvider: sms.name, providerOverrides: null });
  email.reset();
  sms.reset();
});

interface Booked {
  jobId: string;
  assignmentId: string;
  blockIds: string[];
}

/** JOB-1042 (Sarah, Hilton, Lena as site contact), accepted by Bob with one calendar block per slot. */
async function book(slots: Date[], acceptedAt: Date = YESTERDAY_4PM): Promise<Booked> {
  const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
  const assignment = await db.assignment.findFirstOrThrow({ where: { jobId: job.id } });
  await db.calendarEvent.deleteMany({ where: { assignmentId: assignment.id } });
  await db.assignment.update({
    where: { id: assignment.id },
    data: { status: "accepted", proposedSlot: slots[0], confirmedSlot: slots[0], acceptedAt },
  });
  await db.job.update({ where: { id: job.id }, data: { status: "scheduled" } });
  const blockIds: string[] = [];
  for (const slot of slots) {
    const block = await db.calendarEvent.create({
      data: {
        contractorId: assignment.contractorId,
        type: "job",
        jobId: job.id,
        assignmentId: assignment.id,
        startTime: slot,
        endTime: new Date(slot.getTime() + 60 * 60_000),
      },
    });
    blockIds.push(block.id);
  }
  return { jobId: job.id, assignmentId: assignment.id, blockIds };
}

async function rowsOf(jobId: string) {
  return db.notification.findMany({ where: { jobId, type: "job_tomorrow" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

const mailTo = (address: string) => email.sent.find((m) => m.to === address && (m.message.subject ?? "").startsWith("Job tomorrow"));

describe("the pure rules", () => {
  test("nextDay and reminderWillCome", () => {
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    const base = { businessZone: ZONE, jobZone: ZONE, runAt: DAILY_RUN_AT };
    expect(reminderWillCome({ ...base, slot: THU_9AM, now: MORNING })).toBe(true);
    expect(reminderWillCome({ ...base, slot: WED_9AM, now: MORNING })).toBe(true);
    expect(reminderWillCome({ ...base, slot: TOMORROW_9AM, now: BEFORE_NINE })).toBe(true);
    expect(reminderWillCome({ ...base, slot: TOMORROW_9AM, now: MORNING })).toBe(false);
    expect(reminderWillCome({ ...base, slot: TODAY_2PM, now: BEFORE_NINE })).toBe(false);
  });
});

describe("AC1 and AC2 -- the reminder, in each person's wording", () => {
  test("AC1: Sarah's email and text for Bob's Tue 3 Nov 9:00am visit, in the design's wording, money-free", async () => {
    const { jobId } = await book([TOMORROW_9AM]);
    const ran = await dailyTick(db, MORNING);
    expect(ran?.failed).toEqual([]);
    expect(ran?.ran).toContain("job-tomorrow reminders");
    await drainOnce(db);

    const mail = mailTo("sarah@idelta.com.au");
    expect(mail?.message.subject).toBe("Job tomorrow - JOB-1042, 9:00am AWST");
    const text = mail?.message.text ?? "";
    const html = mail?.message.html ?? "";
    for (const body of [text, html.replace(/<[^>]+>/g, "")]) {
      expect(body).toContain("Hi Sarah,");
      expect(body).toContain("A reminder: Bob will be at 12 Paget Street, Hilton tomorrow, Tue 3 Nov, at 9:00am AWST for your plumbing job");
      expect(body).toContain("JOB-1042");
      expect(body).toContain("Please make sure someone is there to let Bob in.");
    }
    expect(text).toMatch(/To change anything, please ring the office on \S+/);
    expect(text).toContain("Manage your jobs online");
    const beforeOffer = (text.split("Manage your jobs online")[0] ?? "") + (html.split("Manage your jobs online")[0] ?? "");
    expect(beforeOffer).not.toContain("$");
    expect(beforeOffer).not.toContain("http");

    const customerText = sms.sent.find((m) => m.message.text.includes("JOB-1042") && m.message.text.includes("let Bob in") && m.message.text.includes("someone"));
    expect(customerText).toBeDefined();
    const body = (customerText?.message.text ?? "").split("\n\nSet up your account")[0] ?? "";
    expect(body).toMatch(/: reminder - Bob will be at 12 Paget Street, Hilton tomorrow, Tue 3 Nov, 9:00am AWST for your job JOB-1042\. Please make sure someone can let Bob in\. To change, ring \S+/);
    expect(body).not.toContain("$");
    expect(body).not.toContain("http");

    const rows = await rowsOf(jobId);
    expect(rows.filter((r) => r.recipientType === "customer").map((r) => r.channel).sort()).toEqual(["email", "sms"]);
  });

  test("AC2: Lena gets her own email and text; Sarah's says the site contact was reminded too, and never names Lena; Lena's carry no account offer", async () => {
    const { jobId, assignmentId, blockIds } = await book([TOMORROW_9AM]);
    await dailyTick(db, MORNING);
    await drainOnce(db);

    const sarahs = mailTo("sarah@idelta.com.au");
    expect(sarahs?.message.text).toContain("The site contact has been reminded too.");
    expect(sarahs?.message.html).toContain("The site contact has been reminded too.");
    expect(sarahs?.message.text).not.toContain("Lena");

    const lenas = mailTo("lena@idelta.com.au");
    expect(lenas).toBeDefined();
    const text = lenas?.message.text ?? "";
    expect(text).toContain("Hi Lena,");
    expect(text).toContain("A reminder: Bob will be at 12 Paget Street, Hilton tomorrow, Tue 3 Nov, at 9:00am AWST for a plumbing job (JOB-1042).");
    expect(text).toContain("Please make sure you are there to let Bob in.");
    expect(text).toContain("If that time no longer suits, please ring the office on");
    expect(text).not.toContain("Sarah");
    for (const body of [text, lenas?.message.html ?? ""]) {
      expect(body).not.toContain("Manage your jobs online");
      expect(body).not.toContain("$");
      expect(body).not.toContain("http");
    }
    const lenasText = sms.sent.find((m) => m.to === "0400 002 050" && m.message.text.includes("reminder"));
    expect(lenasText?.message.text).toContain("there to let Bob in");
    expect(lenasText?.message.text).not.toContain("Set up your account");

    const rows = await rowsOf(jobId);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual(
      [
        jobTomorrowKey(assignmentId, blockIds[0] ?? "", "customer", "email"),
        jobTomorrowKey(assignmentId, blockIds[0] ?? "", "customer", "sms"),
        jobTomorrowKey(assignmentId, blockIds[0] ?? "", "site_contact", "email"),
        jobTomorrowKey(assignmentId, blockIds[0] ?? "", "site_contact", "sms"),
      ].sort(),
    );
  });

  test("AC2: a site contact who gave no email gets the text only; a job with none gets no site contact row and no told line", async () => {
    const { jobId } = await book([TOMORROW_9AM]);
    await db.job.update({ where: { id: jobId }, data: { siteContact: { name: "Lena Park", phone: "0400 002 050" } } });
    await dailyTick(db, MORNING);
    expect((await rowsOf(jobId)).filter((r) => r.recipientType === "site_contact").map((r) => r.channel)).toEqual(["sms"]);

    await db.notification.deleteMany({ where: { jobId, type: "job_tomorrow" } });
    await db.job.update({ where: { id: jobId }, data: { siteContact: Prisma.DbNull } });
    await dailyTick(db, MORNING);
    const rows = await rowsOf(jobId);
    expect(rows.map((r) => r.recipientType)).toEqual(["customer", "customer"]);
    await drainOnce(db);
    expect(mailTo("sarah@idelta.com.au")?.message.text).not.toContain("The site contact has been reminded too.");
  });
});

describe("AC3 -- once", () => {
  test("AC3: the step run three times, and later the same day, leaves one row per recipient and channel", async () => {
    const { jobId } = await book([TOMORROW_9AM]);
    await runDailySteps(db, { zone: ZONE, now: MORNING, today: "2026-11-02" });
    await runDailySteps(db, { zone: ZONE, now: new Date(MORNING.getTime() + 5 * 60_000), today: "2026-11-02" });
    await dailyTick(db, new Date(MORNING.getTime() + 6 * 3_600_000));
    expect(await rowsOf(jobId)).toHaveLength(4);
    await drainOnce(db);
    expect(email.sent.filter((m) => (m.message.subject ?? "").startsWith("Job tomorrow"))).toHaveLength(2);
  });

  test("AC3: nothing before 9:00am", async () => {
    const { jobId } = await book([TOMORROW_9AM]);
    expect(await dailyTick(db, BEFORE_NINE)).toBeNull();
    expect(await rowsOf(jobId)).toHaveLength(0);
  });
});

describe("AC4 to AC6 -- which visits", () => {
  test("AC4: a visit booked for today gets no reminder", async () => {
    const { jobId } = await book([TODAY_2PM]);
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(0);
  });

  test("AC5: a visit for tomorrow confirmed at 11:00am today gets none, then or the next morning", async () => {
    const { jobId } = await book([TOMORROW_9AM], TODAY_11AM);
    await dailyTick(db, new Date(TODAY_11AM.getTime() + 60_000));
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(0);
    // The morning after, the visit is today's: still none.
    await dailyTick(db, new Date("2026-11-03T01:05:00.000Z"));
    expect(await rowsOf(jobId)).toHaveLength(0);
  });

  test("AC5: confirmed at 8:59am today, before the run, it is reminded", async () => {
    const { jobId } = await book([TOMORROW_9AM], new Date("2026-11-02T00:59:00.000Z"));
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(4);
  });

  test("AC6: a visit two days away gets its reminder on the morning before, not this morning", async () => {
    const { jobId } = await book([WED_9AM]);
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(0);
    await dailyTick(db, new Date("2026-11-03T01:05:00.000Z"));
    const rows = await rowsOf(jobId);
    expect(rows).toHaveLength(4);
    expect(JSON.stringify(rows[0]?.context)).toContain("Wed 4 Nov");
  });
});

describe("AC7 -- one reminder per visit", () => {
  test("AC7: two visits on one assignment get one each, the day before its own visit", async () => {
    const { jobId } = await book([TOMORROW_9AM, THU_9AM]);
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(4);
    // Wed 4 Nov: the Thursday visit's day before.
    await dailyTick(db, new Date("2026-11-04T01:05:00.000Z"));
    const rows = await rowsOf(jobId);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(8);
  });
});

describe("AC8 -- visits that are off", () => {
  test("AC8: a cancelled job gets no reminder", async () => {
    const { jobId } = await book([TOMORROW_9AM]);
    await db.job.update({ where: { id: jobId }, data: { status: "cancelled" } });
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(0);
  });

  test("AC8: a visit taken off (the assignment cancelled, its block gone) gets no reminder", async () => {
    const { jobId, assignmentId } = await book([TOMORROW_9AM]);
    await db.assignment.update({ where: { id: assignmentId }, data: { status: "cancelled" } });
    await db.calendarEvent.deleteMany({ where: { assignmentId } });
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(0);
  });

  test("AC8: a block rescheduled away from tomorrow is not reminded for tomorrow", async () => {
    const { jobId, blockIds } = await book([TOMORROW_9AM]);
    await db.calendarEvent.update({ where: { id: blockIds[0] }, data: { startTime: THU_9AM, endTime: new Date(THU_9AM.getTime() + 3_600_000) } });
    await dailyTick(db, MORNING);
    expect(await rowsOf(jobId)).toHaveLength(0);
  });
});

describe("AC10 -- the job page names the rows", () => {
  test("AC10: the Messages card calls them Job tomorrow", () => {
    expect(messageName("job_tomorrow")).toBe("Job tomorrow");
  });
});
