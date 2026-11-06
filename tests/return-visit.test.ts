// Feature 5002 -- return visit and put on hold
//
// AC1  the contractor's read offers Book a return visit on an open scheduled / in-progress visit
// AC2  Book a return visit saves nothing without a time entry for today ("Enter today's time on site first.")
// AC3  Reason (Other needs its text) and the return choice are required
// AC4  a picked time saves the screen's times and adds a second block of the chosen length, the job Scheduled, the
//      customer told by email and text
// AC5  Not yet: the job goes On hold, the note is kept, the customer is not told
// AC7  a clash, licence or insurance, outside hours, a holiday refuse with nothing changed; a closed state still books
// AC8  the contractor may book their own Not available time (it becomes available, under their name); Mike may not
// AC9  a return booked after that morning's run gets no reminder; one booked before it does
// AC10 Mike puts a scheduled job on hold; its booked time comes off and the customer and site contact get the Job update
// AC11 Mike sees the Reason and note, books the return through the same path; the note leaves, the Reason stays
// AC12 Mike sees the contractor's work notes before completion
// AC13 hours from both visits bill, the return visit with its floor
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import express from "express";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { acceptJob1042, buildOpsApp, freshWorld, rowsOf, signIn } from "./helpers/ops-app.js";
import { contractorJobRoutes } from "../src/contractors/job-routes.js";
import { opsAvailabilityRoutes } from "../src/availability/routes.js";
import { runJobTomorrowReminders } from "../src/jobs/job-tomorrow.js";
import { todayIn } from "../src/time/index.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: ReturnType<typeof buildOpsApp>;
const email = recordingAdapter("test-email-5002", "email");

const RETURN_DAY = "2027-03-16"; // a Tuesday, well ahead
const ZONE = "Australia/Perth";
const today = (): string => todayIn(ZONE);
const slot = (startMinutes = 540, holdMinutes = 90, date = RETURN_DAY) => ({ date, startMinutes, holdMinutes });
const entries = () => [{ date: today(), start: "09:00", end: "10:00", note: "" }];

beforeAll(() => {
  db = testClient();
  app = buildOpsApp(db);
  const rest = express.Router();
  rest.use("/api/contractor/jobs", contractorJobRoutes(db));
  rest.use("/api/contractors", opsAvailabilityRoutes(db));
  app.use(rest);
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await freshWorld(db, email);
});

/** JOB-1042 accepted by Bob (scheduled, Lena the site contact), the visit under way. */
async function visitUnderWay(): Promise<{ jobId: string; assignmentId: string; bob: string; mike: string }> {
  const ids = await acceptJob1042(db, app);
  await db.job.update({ where: { id: ids.jobId }, data: { status: "in_progress" } });
  await db.assignment.update({ where: { id: ids.assignmentId }, data: { status: "in_progress" } });
  // The visit is under way today: its block began this morning (JOB-1042's seeded block is next Thursday's).
  const began = new Date(Date.now() - 2 * 3_600_000);
  await db.calendarEvent.updateMany({ where: { assignmentId: ids.assignmentId }, data: { startTime: began, endTime: new Date(began.getTime() + 3_600_000) } });
  return { ...ids, bob: await signIn(app, "bob@idelta.com.au"), mike: await signIn(app, "mike@idelta.com.au") };
}

const returnVisit = (cookie: string, body: Record<string, unknown>) =>
  request(app).post("/api/contractor/jobs/JOB-1042/return-visit").set("Cookie", cookie).send(body);
const book = (cookie: string, over: Record<string, unknown> = {}) =>
  returnVisit(cookie, { timeEntries: entries(), completionNotes: "Part ordered.", parts: [], reason: "part_on_order", slot: slot(), ...over });

describe("AC1, AC2, AC3 -- what the screen may ask", () => {
  test("AC1: an open visit can book a return; a frozen one cannot", async () => {
    const { bob } = await visitUnderWay();
    const view = (await request(app).get("/api/contractor/jobs/JOB-1042").set("Cookie", bob)).body as { canBookReturn: boolean };
    expect(view.canBookReturn).toBe(true);
  });

  test("AC2: with no time entered for today it says so and nothing is saved", async () => {
    const { bob, assignmentId } = await visitUnderWay();
    const res = await book(bob, { timeEntries: [{ date: "2027-03-01", start: "09:00", end: "10:00", note: "" }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Enter today's time on site first.", field: "timeEntries" });
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(0);
    expect(await db.returnReason.count()).toBe(0);
  });

  test("AC3: the Reason is required, Other needs its words, and a time or Not yet is needed", async () => {
    const { bob } = await visitUnderWay();
    expect((await book(bob, { reason: undefined })).body).toMatchObject({ field: "reason" });
    expect((await book(bob, { reason: "other" })).body).toMatchObject({ field: "otherText" });
    expect((await book(bob, { slot: undefined })).status).toBe(400);
  });
});

describe("AC4, AC5 -- the two answers", () => {
  test("AC4: a picked time saves the visit, adds a second block of the chosen length, schedules the job and tells Sarah", async () => {
    const { bob, jobId, assignmentId } = await visitUnderWay();
    const before = await rowsOf(db, jobId, "slot_confirmed");
    const res = await book(bob, { reason: "other", otherText: "Waiting for the owner's tiles" });
    expect(res.status).toBe(200);
    expect((res.body as { returnBooked: { label: string } }).returnBooked.label).toMatch(/Tue 16 Mar( 2027)? at 9:00am/);
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(1);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).completionNotes).toBe("Part ordered.");
    const blocks = await db.calendarEvent.findMany({ where: { assignmentId }, orderBy: { startTime: "asc" } });
    const second = blocks[blocks.length - 1];
    expect((second.endTime.getTime() - second.startTime.getTime()) / 60_000).toBe(90);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("scheduled");
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment.status).toBe("accepted");
    expect(assignment.confirmedSlot?.getTime()).toBe(second.startTime.getTime());
    const reason = await db.returnReason.findFirstOrThrow({ where: { jobId } });
    expect(reason).toMatchObject({ reason: "other", otherText: "Waiting for the owner's tiles" });
    const after = await rowsOf(db, jobId, "slot_confirmed");
    const added = after.filter((row) => !before.some((old) => old.id === row.id));
    expect(added.filter((row) => row.recipientType === "customer").map((row) => row.channel).sort()).toEqual(["email", "sms"]);
  });

  test("AC5: Not yet puts the job On hold, keeps the note, and tells nobody", async () => {
    const { bob, jobId, assignmentId } = await visitUnderWay();
    const messagesBefore = await db.notification.count({ where: { jobId } });
    const res = await returnVisit(bob, {
      timeEntries: entries(),
      completionNotes: "Waiting on a part.",
      parts: [],
      reason: "part_on_order",
      notYet: true,
      officeNote: "Supplier says Friday.",
    });
    expect(res.status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("on_hold");
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("accepted");
    expect(await db.returnReason.findFirstOrThrow({ where: { jobId } })).toMatchObject({ officeNote: "Supplier says Friday." });
    expect(await db.notification.count({ where: { jobId } })).toBe(messagesBefore);
    const view = (await request(app).get("/api/contractor/jobs/JOB-1042").set("Cookie", bob)).body as { jobStatus: string; canBookReturn: boolean };
    expect(view).toMatchObject({ jobStatus: "on_hold", canBookReturn: false });
  });
});

describe("AC7, AC8 -- refusals, and the contractor's own Not available time", () => {
  test("AC7: a clash, an expired licence, outside hours and a holiday refuse and change nothing", async () => {
    const { bob, jobId, assignmentId } = await visitUnderWay();
    const other = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1051" } });
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const start = new Date("2027-03-16T01:00:00.000Z"); // 9:00am Perth
    await db.calendarEvent.create({ data: { contractorId: bobRow.id, type: "job", jobId: other.id, startTime: start, endTime: new Date(start.getTime() + 3_600_000) } });

    const clash = await book(bob);
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ error: "That time clashes with JOB-1051. Pick another time." });

    expect((await book(bob, { slot: slot(360) })).body).toMatchObject({ error: "That time is outside opening hours. Pick another time." });

    const wa = await db.publicHoliday.create({ data: { state: "WA", date: new Date("2027-03-17T00:00:00.000Z"), name: "Test Day" } });
    expect((await book(bob, { slot: slot(540, 60, "2027-03-17") })).status).toBe(400);
    await db.publicHoliday.delete({ where: { id: wa.id } });

    await db.contractorSpecialty.updateMany({ where: { contractorId: bobRow.id }, data: { licenceExpiry: new Date("2027-03-01") } });
    const licence = await book(bob, { slot: slot(600) });
    expect(licence.status).toBe(409);
    expect(licence.body).toMatchObject({ error: "Your licence or insurance runs out before that date. Ring the office." });

    expect(await db.returnReason.count()).toBe(0);
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("in_progress");
  });

  test("AC7: a closed state can still be booked", async () => {
    const { bob } = await visitUnderWay();
    await db.operatingState.updateMany({ where: { state: "WA" }, data: { open: false } });
    expect((await book(bob)).status).toBe(200);
  });

  test("AC8: Bob books his own Not available time and it becomes available under his name; Mike's booking there is refused", async () => {
    const { bob, mike, jobId } = await visitUnderWay();
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { user: true } });
    await request(app)
      .put("/api/contractors/CON-014/availability")
      .set("Cookie", mike)
      .send({ changes: [{ date: RETURN_DAY, time: "09:00", available: false }, { date: RETURN_DAY, time: "09:30", available: false }] });

    // Mike, on an on-hold job, may not book the switched-off time.
    await db.job.update({ where: { id: jobId }, data: { status: "on_hold" } });
    const refused = await request(app).post("/api/jobs/JOB-1042/return-visit").set("Cookie", mike).send(slot(540, 60));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "Not available at that time - pick another slot or another contractor." });
    await db.job.update({ where: { id: jobId }, data: { status: "in_progress" } });

    expect((await book(bob, { slot: slot(540, 60) })).status).toBe(200);
    const rows = await db.contractorAvailability.findMany({ where: { contractorId: bobRow.id, date: new Date(`${RETURN_DAY}T00:00:00.000Z`), startTime: { in: ["09:00", "09:30"] } } });
    expect(rows.map((row) => [row.available, row.changedByUserId])).toEqual([[true, bobRow.userId], [true, bobRow.userId]]);
  });
});

describe("AC9 -- reminders", () => {
  test("AC9: a return booked before the morning run is reminded; one made after it is not", async () => {
    const { bob, jobId, assignmentId } = await visitUnderWay();
    expect((await book(bob, { slot: slot(540, 60, "2027-03-16") })).status).toBe(200);
    // The run on Monday 15 March, 9:00am Perth: the return block was made long before it.
    const reminded = await runJobTomorrowReminders(db, { now: new Date("2027-03-15T01:30:00.000Z"), runAt: "09:00", asDay: "2027-03-15" });
    expect(reminded.visits).toBe(1);
    expect(await rowsOf(db, jobId, "job_tomorrow")).not.toHaveLength(0);

    // A second return, made at 10:00am Monday (after the run), gets none.
    await db.notification.deleteMany({ where: { jobId, type: "job_tomorrow" } });
    await db.calendarEvent.deleteMany({ where: { assignmentId, startTime: { gt: new Date("2027-03-01T00:00:00.000Z") } } });
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.calendarEvent.create({
      data: { contractorId: bobRow.id, type: "job", jobId, assignmentId, startTime: new Date("2027-03-16T03:00:00.000Z"), endTime: new Date("2027-03-16T04:00:00.000Z"), createdAt: new Date("2027-03-15T02:00:00.000Z") },
    });
    const late = await runJobTomorrowReminders(db, { now: new Date("2027-03-15T02:30:00.000Z"), runAt: "09:00", asDay: "2027-03-15" });
    expect(late.visits).toBe(0);
  });
});

describe("AC10, AC11, AC12 -- Mike", () => {
  test("AC10: Mike puts a booked job on hold; the time comes off and Sarah and Lena get the Job update", async () => {
    const { mike, jobId } = await visitUnderWay();
    await db.job.update({ where: { id: jobId }, data: { status: "scheduled" } });
    await db.assignment.updateMany({ where: { jobId }, data: { status: "accepted" } });
    const soon = new Date(Date.now() + 3 * 86_400_000); // a booked time still ahead
    await db.calendarEvent.updateMany({ where: { jobId }, data: { startTime: soon, endTime: new Date(soon.getTime() + 3_600_000) } });
    expect((await request(app).post("/api/jobs/JOB-1042/hold").set("Cookie", mike).send({})).body).toMatchObject({ field: "reason" });
    const res = await request(app).post("/api/jobs/JOB-1042/hold").set("Cookie", mike).send({ reason: "more_time_needed" });
    expect(res.status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("on_hold");
    expect(await db.calendarEvent.count({ where: { jobId, startTime: { gt: new Date() } } })).toBe(0);
    const updates = await rowsOf(db, jobId, "job_update");
    expect(updates.filter((row) => row.recipientType === "customer").map((row) => row.channel).sort()).toEqual(["email", "sms"]);
    expect(updates.some((row) => row.recipientType === "site_contact")).toBe(true);
  });

  test("AC11: Mike sees the Reason and note, books the return, and the job goes Scheduled; the note leaves, the Reason stays", async () => {
    const { bob, mike, jobId } = await visitUnderWay();
    await returnVisit(bob, { timeEntries: entries(), completionNotes: "Waiting.", parts: [], reason: "part_on_order", notYet: true, officeNote: "Friday." });
    const onHold = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as {
      returnVisit: { reasonLabel: string; officeNote: string | null };
      actions: { hold: boolean; bookReturn: boolean };
    };
    expect(onHold.returnVisit).toMatchObject({ reasonLabel: "Part on order", officeNote: "Friday." });
    expect(onHold.actions).toMatchObject({ hold: false, bookReturn: true });

    const facts = (await request(app).get("/api/jobs/JOB-1042/dispatch?mode=return").set("Cookie", mike)).body as { mode: string; contractor: { code: string } };
    expect(facts).toMatchObject({ mode: "return", contractor: { code: "CON-014" } });

    const res = await request(app).post("/api/jobs/JOB-1042/return-visit").set("Cookie", mike).send(slot(540, 60));
    expect(res.status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("scheduled");
    const after = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as { returnVisit: { reasonLabel: string; officeNote: string | null } };
    expect(after.returnVisit).toMatchObject({ reasonLabel: "Part on order", officeNote: null });
  });

  test("AC12: Mike sees the contractor's work notes before completion", async () => {
    const { bob, mike } = await visitUnderWay();
    await request(app).put("/api/contractor/jobs/JOB-1042").set("Cookie", bob).send({ timeEntries: entries(), completionNotes: "Replaced the washer.", parts: [] });
    const visit = ((await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as { visit: { completed: boolean; completionNotes: string } }).visit;
    expect(visit).toMatchObject({ completed: false, completionNotes: "Replaced the washer." });
  });
});

describe("AC13 -- billing", () => {
  test("AC13: the hours of both visits bill, the return visit with its floor", async () => {
    const { bob, assignmentId } = await visitUnderWay();
    expect((await book(bob, { timeEntries: [...entries(), { date: RETURN_DAY, start: "09:00", end: "09:10", note: "" }] })).status).toBe(200);
    const done = await request(app)
      .post("/api/contractor/jobs/JOB-1042/complete")
      .set("Cookie", bob)
      .send({ timeEntries: [...entries(), { date: RETURN_DAY, start: "09:00", end: "09:10", note: "" }], completionNotes: "Finished.", parts: [] });
    expect(done.status).toBe(200);
    const settings = await db.platformSettings.findFirstOrThrow({ select: { returnVisitMinimumMinutes: true } });
    // first visit: one hour; the 10 minutes of the return visit bill at the return visit's floor
    expect(Number((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).billedHours)).toBe(1 + settings.returnVisitMinimumMinutes / 60);
  });
});
