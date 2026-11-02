// Feature 2004 -- contractor Availability and Calendar (the server rules)
//
// AC3  half hours are set for a week and hold; only CHANGED half hours are written, with who and when
// AC4  Day off / Day on, Copy to next day (Sunday rolls to Monday) and Copy to next week; "Replace it?" when the week is set
// AC6  booked and to-answer jobs win over taps, Day off, Day on and copy; a copied job's hours arrive available
// AC7  past and holiday half hours are locked and skipped
// AC9  a job that has landed wins over a tap
// AC10 a week never set counts as available; the dashboard says "Set your availability" until the first save
// AC11 widening the hours leaves the new half hours Not available for an existing contractor, with one dashboard message;
//      a contractor added afterwards has them; narrowing hides and restoring brings back
// AC12 dispatch and reschedule refuse Not available time; the candidate row is greyed and tagged
// AC13 "Change availability" (linkable) only when Not available is the sole problem
// AC14 time switched off just before dispatch is refused
// AC15 changing availability moves no job and sends nothing
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express from "express";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { acceptJob1042, buildOpsApp, freshWorld, makeNewJob, signIn, MONDAY } from "./helpers/ops-app.js";
import { contractorAvailabilityRoutes, opsAvailabilityRoutes } from "../src/availability/routes.js";
import { contractorDashboardRoutes } from "../src/contractors/dashboard-routes.js";
import { addDays, mondayOf } from "../src/availability/index.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: ReturnType<typeof buildOpsApp>;
const email = recordingAdapter("test-email-2004", "email");

// A week well ahead: Mon 8 Mar 2027 .. Sun 14 Mar 2027 (Perth). MONDAY (from the helpers) is Mon 15 Mar 2027.
const WEEK = "2027-03-08";
const TUE = "2027-03-09";
const SUN = "2027-03-14";

beforeAll(() => {
  db = testClient();
  app = buildOpsApp(db);
  const rest = express.Router();
  rest.use("/api/contractor", contractorAvailabilityRoutes(db));
  rest.use("/api/contractor", contractorDashboardRoutes(db));
  rest.use("/api/contractors", opsAvailabilityRoutes(db));
  app.use(rest);
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await freshWorld(db, email);
});

interface Week {
  availabilitySet: boolean;
  openingTime: string;
  closingTime: string;
  days: { date: string; closed: string | null; slots: { time: string; state: string }[] }[];
}

const bobGet = async (cookie: string, week = WEEK): Promise<Week> =>
  (await request(app).get(`/api/contractor/availability?week=${week}`).set("Cookie", cookie)).body as Week;
const put = (cookie: string, changes: unknown, path = "/api/contractor/availability") =>
  request(app).put(path).set("Cookie", cookie).send({ changes });
const off = (date: string, ...times: string[]) => times.map((time) => ({ date, time, available: false }));
const stateOf = (week: Week, date: string, time: string): string | undefined =>
  week.days.find((d) => d.date === date)?.slots.find((s) => s.time === time)?.state;

describe("AC3, AC10 -- setting a week", () => {
  test("AC10: a week never set counts as available inside the hours; the dashboard says so until the first save", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    const week = await bobGet(bob);
    expect(week.availabilitySet).toBe(false);
    expect(week.days).toHaveLength(7);
    expect(stateOf(week, TUE, "07:00")).toBe("available");
    expect(stateOf(week, TUE, "18:30")).toBe("available");
    expect(week.days[0]?.slots).toHaveLength(24); // 07:00 .. 18:30
    const dash = await request(app).get("/api/contractor/dashboard").set("Cookie", bob);
    expect(dash.body).toMatchObject({ setAvailability: true });
    expect((await put(bob, [])).status).toBe(200); // a save with nothing changed still counts as set
    expect((await request(app).get("/api/contractor/dashboard").set("Cookie", bob)).body).toMatchObject({ setAvailability: false });
    // Mike sees "Availability not set" on the candidate rows of someone who never saved: Dave, here.
  });

  test("AC3: three half hours off hold after a reload; only changed half hours are written, with who and when", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    const saved = await put(bob, [...off(TUE, "07:00", "07:30", "08:00"), { date: TUE, time: "09:00", available: true }]);
    expect(saved.body).toEqual({ written: 3, skipped: 0 }); // 09:00 was already available - nothing written
    const again = await put(bob, off(TUE, "07:00"));
    expect(again.body).toEqual({ written: 0, skipped: 0 });
    const rows = await db.contractorAvailability.findMany({ orderBy: { startTime: "asc" } });
    expect(rows.map((r) => r.startTime)).toEqual(["07:00", "07:30", "08:00"]);
    const bobUser = await db.user.findUniqueOrThrow({ where: { email: "bob@idelta.com.au" } });
    expect(rows.every((r) => r.changedByUserId === bobUser.id && !r.available)).toBe(true);
    const week = await bobGet(bob);
    expect([stateOf(week, TUE, "07:00"), stateOf(week, TUE, "08:30")]).toEqual(["not_available", "available"]);
    // turning one back on rewrites the row
    await put(bob, [{ date: TUE, time: "07:00", available: true }]);
    expect(stateOf(await bobGet(bob), TUE, "07:00")).toBe("available");
  });

  test("AC3: Mike sets Bob's week through the record's door; the row says Mike did it", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const res = await put(mike, off(TUE, "10:00"), "/api/contractors/CON-014/availability");
    expect(res.body).toEqual({ written: 1, skipped: 0 });
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    expect((await db.contractorAvailability.findFirstOrThrow()).changedByUserId).toBe(mikeUser.id);
    const bob = await signIn(app, "bob@idelta.com.au");
    expect((await put(bob, [], "/api/contractors/CON-014/availability")).status).toBe(403);
  });
});

describe("AC4 -- Day off, Day on and Copy", () => {
  const dayOf = (date: string, available: boolean) => {
    const times: string[] = [];
    for (let m = 7 * 60; m < 19 * 60; m += 30) times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 === 0 ? "00" : "30"}`);
    return times.map((time) => ({ date, time, available }));
  };

  test("AC4: Day off switches every half hour of a day off; Day on brings them back", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    expect((await put(bob, dayOf(TUE, false))).body).toEqual({ written: 24, skipped: 0 });
    expect((await bobGet(bob)).days.find((d) => d.date === TUE)?.slots.every((s) => s.state === "not_available")).toBe(true);
    await put(bob, dayOf(TUE, true));
    expect((await bobGet(bob)).days.find((d) => d.date === TUE)?.slots.every((s) => s.state === "available")).toBe(true);
  });

  test("AC4, AC8: Copy to next day moves the pattern one day on - Sunday rolls to Monday - and saves the unsaved taps sent with it", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    const res = await request(app).post("/api/contractor/availability/copy-day").set("Cookie", bob).send({ from: SUN, changes: off(SUN, "07:00", "07:30") });
    expect(res.body).toMatchObject({ target: addDays(SUN, 1) });
    const week = await bobGet(bob, addDays(WEEK, 7));
    expect([stateOf(week, "2027-03-15", "07:00"), stateOf(week, "2027-03-15", "07:30"), stateOf(week, "2027-03-15", "08:00")]).toEqual(["not_available", "not_available", "available"]);
    expect(stateOf(await bobGet(bob), SUN, "07:00")).toBe("not_available"); // the tap sent with the copy was saved too
  });

  test("AC4: Copy to next week copies the pattern and asks 'Replace it?' when that week is already set", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await put(bob, off(TUE, "07:00", "07:30"));
    const first = await request(app).post("/api/contractor/availability/copy-week").set("Cookie", bob).send({ fromWeek: WEEK });
    expect(first.body).toMatchObject({ needsReplace: false, targetWeek: "2027-03-15" });
    expect(stateOf(await bobGet(bob, "2027-03-15"), "2027-03-16", "07:00")).toBe("not_available");
    await put(bob, off(TUE, "08:00"));
    const second = await request(app).post("/api/contractor/availability/copy-week").set("Cookie", bob).send({ fromWeek: WEEK });
    expect(second.body).toEqual({ needsReplace: true, targetWeek: "2027-03-15" });
    expect(stateOf(await bobGet(bob, "2027-03-15"), "2027-03-16", "08:00")).toBe("available"); // nothing happened yet
    const replaced = await request(app).post("/api/contractor/availability/copy-week").set("Cookie", bob).send({ fromWeek: WEEK, replace: true });
    expect(replaced.body).toMatchObject({ needsReplace: false });
    expect(stateOf(await bobGet(bob, "2027-03-15"), "2027-03-16", "08:00")).toBe("not_available");
  });
});

describe("AC6, AC7, AC9 -- what wins", () => {
  async function bobsJobDay(): Promise<{ date: string; time: string }> {
    const block = await db.calendarEvent.findFirstOrThrow({ where: { contractor: { code: "CON-014" }, type: "job" } });
    const local = new Date(block.startTime.getTime() + 8 * 3_600_000); // Perth, UTC+8
    return { date: local.toISOString().slice(0, 10), time: local.toISOString().slice(11, 16) };
  }

  test("AC6: a to-answer job (JOB-1042, waiting on Bob) wins over a tap and over Day off; a copy brings its hours across available", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    const { date, time } = await bobsJobDay();
    const week = await bobGet(bob, mondayOf(date));
    expect(stateOf(week, date, time)).toBe("to_answer");
    expect((await put(bob, off(date, time))).body).toEqual({ written: 0, skipped: 1 });
    expect(await db.contractorAvailability.count()).toBe(0);
    // Day off for that whole day writes everything except the held hour
    const dayOff = [];
    for (let m = 7 * 60; m < 19 * 60; m += 30) dayOff.push({ date, time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 === 0 ? "00" : "30"}`, available: false });
    expect((await put(bob, dayOff)).body).toMatchObject({ skipped: 2 }); // an hour = two half hours (07:00-09:00 slot starts at 08:00)
    // a copy from a day holding a job: its hours arrive available
    await request(app).post("/api/contractor/availability/copy-day").set("Cookie", bob).send({ from: date });
    const next = await bobGet(bob, mondayOf(addDays(date, 1)));
    expect(stateOf(next, addDays(date, 1), time)).toBe("available");
  });

  test("AC6, AC9: once the job is accepted it is booked and still wins; a job landing wins over a tap saved after it", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await acceptJob1042(db, app);
    const { date, time } = await bobsJobDay();
    expect(stateOf(await bobGet(bob, mondayOf(date)), date, time)).toBe("booked");
    expect((await put(bob, off(date, time))).body).toMatchObject({ written: 0, skipped: 1 });
  });

  test("AC7: yesterday and holidays are locked and skipped; the holiday carries its name", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await db.publicHoliday.create({ data: { state: "WA", date: new Date("2027-03-10T00:00:00.000Z"), name: "Test Day" } });
    const week = await bobGet(bob);
    expect(week.days.find((d) => d.date === "2027-03-10")).toMatchObject({ closed: "Test Day" });
    expect(stateOf(week, "2027-03-10", "09:00")).toBe("closed");
    expect((await put(bob, off("2027-03-10", "09:00"))).body).toEqual({ written: 0, skipped: 1 });
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect(stateOf(await bobGet(bob, mondayOf(past)), past, "09:00")).toBe("past");
    expect((await put(bob, off(past, "09:00"))).body).toEqual({ written: 0, skipped: 1 });
  });
});

describe("AC11 -- the business hours change", () => {
  test("AC11: widening leaves the new half hours Not available for Bob, with one dashboard message; a contractor added afterwards has them", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await db.platformSettings.updateMany({ data: { openingTime: "06:00", closingTime: "20:00", openingHoursChangedAt: new Date() } });
    const week = await bobGet(bob);
    expect(week.openingTime).toBe("06:00");
    expect([stateOf(week, TUE, "06:00"), stateOf(week, TUE, "07:00"), stateOf(week, TUE, "19:30")]).toEqual(["not_available", "available", "not_available"]);
    const dash = (await request(app).get("/api/contractor/dashboard").set("Cookie", bob)).body as { hoursNotice: unknown };
    expect(dash.hoursNotice).toEqual({ openingTime: "06:00", closingTime: "20:00" });
    expect((await request(app).post("/api/contractor/hours-notice-seen").set("Cookie", bob)).status).toBe(200);
    expect(((await request(app).get("/api/contractor/dashboard").set("Cookie", bob)).body as { hoursNotice: unknown }).hoursNotice).toBeNull();
    // Bob switches 06:00 on; then the hours narrow: the setting is hidden, restoring brings it back
    await put(bob, [{ date: TUE, time: "06:00", available: true }]);
    await db.platformSettings.updateMany({ data: { openingTime: "08:00", closingTime: "17:00" } });
    expect((await bobGet(bob)).days[1]?.slots.map((s) => s.time)[0]).toBe("08:00");
    await db.platformSettings.updateMany({ data: { openingTime: "06:00", closingTime: "20:00" } });
    expect(stateOf(await bobGet(bob), TUE, "06:00")).toBe("available");
    // a contractor added now starts from the widened hours
    const mike = await signIn(app, "mike@idelta.com.au");
    const made = await request(app).post("/api/contractors").set("Cookie", mike).send({ operatingState: "WA", name: "Nina New", email: "nina.new@idelta.com.au", phone: "0412 345 678" });
    expect(made.status).toBe(201);
    const nina = await db.contractor.findUniqueOrThrow({ where: { code: (made.body as { code: string }).code } });
    expect([nina.defaultOpening, nina.defaultClosing]).toEqual(["06:00", "20:00"]);
  });
});

describe("AC12, AC13, AC14 -- dispatch", () => {
  const candidates = async (cookie: string, reference: string, startMinutes = 480) =>
    (await request(app).get(`/api/jobs/${reference}/dispatch/candidates?date=${MONDAY}&startMinutes=${String(startMinutes)}&holdMinutes=60`).set("Cookie", cookie)).body as {
      serves: { code: string; pickable: boolean; why: string | null; notAvailable: boolean; linkable: boolean; availabilityNotSet: boolean }[];
    };
  const dispatchTo = (cookie: string, reference: string, startMinutes = 480) =>
    request(app).post(`/api/jobs/${reference}/dispatch`).set("Cookie", cookie).send({ contractorCode: "CON-014", date: MONDAY, startMinutes, holdMinutes: 60, emergency: false });

  test("AC12, AC13: a switched-off hour greys Bob with 'Not available', offers Change availability, and the server refuses it", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    await put(mike, off(MONDAY, "08:00"), "/api/contractors/CON-014/availability");
    const bob = (await candidates(mike, job.reference)).serves.find((r) => r.code === "CON-014");
    expect(bob).toMatchObject({ pickable: false, why: "Not available", notAvailable: true, linkable: true, availabilityNotSet: false });
    const refused = await dispatchTo(mike, job.reference);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "Not available at that time - pick another slot or another contractor." });
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
    // Change availability: Mike opens that hour with Bob's yes; the slot can then be dispatched.
    await put(mike, [{ date: MONDAY, time: "08:00", available: true }], "/api/contractors/CON-014/availability");
    expect((await candidates(mike, job.reference)).serves.find((r) => r.code === "CON-014")).toMatchObject({ pickable: true, notAvailable: false });
    expect((await dispatchTo(mike, job.reference)).status).toBe(201);
  });

  test("AC13: not linkable when Not available is not the only problem (Busy comes first)", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const first = await makeNewJob(db);
    expect((await dispatchTo(mike, first.reference, 480)).status).toBe(201);
    const second = await makeNewJob(db);
    await put(mike, off(MONDAY, "08:00"), "/api/contractors/CON-014/availability");
    const row = (await candidates(mike, second.reference, 480)).serves.find((r) => r.code === "CON-014");
    expect(row?.why).toMatch(/^Busy /);
    expect(row).toMatchObject({ pickable: false, linkable: false });
  });

  test("AC14: time switched off just before dispatch refuses it - the page then refreshes its list", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bobCookie = await signIn(app, "bob@idelta.com.au");
    const job = await makeNewJob(db);
    expect((await candidates(mike, job.reference)).serves.find((r) => r.code === "CON-014")?.pickable).toBe(true);
    await put(bobCookie, off(MONDAY, "08:30")); // Bob switches off the second half of the hour
    expect((await dispatchTo(mike, job.reference)).status).toBe(409);
    expect((await candidates(mike, job.reference)).serves.find((r) => r.code === "CON-014")?.why).toBe("Not available");
  });

  test("AC12: reschedule refuses Not available time too, and the booking stays", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await acceptJob1042(db, app);
    await put(mike, off(MONDAY, "09:00"), "/api/contractors/CON-014/availability");
    const res = await request(app).post("/api/jobs/JOB-1042/reschedule").set("Cookie", mike).send({ date: MONDAY, startMinutes: 540, holdMinutes: 60, emergency: false });
    expect(res.status).toBe(409);
    expect(await db.assignment.count({ where: { job: { reference: "JOB-1042" }, status: { in: ["assigned", "accepted"] } } })).toBe(1);
  });

  test("AC10: Mike sees 'Availability not set' on a row whose contractor never saved", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    expect((await candidates(mike, job.reference)).serves.find((r) => r.code === "CON-014")?.availabilityNotSet).toBe(true);
    await put(mike, [], "/api/contractors/CON-014/availability");
    expect((await candidates(mike, job.reference)).serves.find((r) => r.code === "CON-014")?.availabilityNotSet).toBe(false);
  });
});

describe("AC15, calendar -- nothing moves, nothing is sent; the calendar reads the days", () => {
  test("AC15: setting availability moves no job and queues no email or text", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await acceptJob1042(db, app);
    const before = { notifications: await db.notification.count(), job: await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } }), events: await db.calendarEvent.findMany() };
    await put(bob, off(TUE, "07:00", "07:30"));
    await request(app).post("/api/contractor/availability/copy-week").set("Cookie", bob).send({ fromWeek: WEEK });
    expect(await db.notification.count()).toBe(before.notifications);
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).status).toBe(before.job.status);
    expect(await db.calendarEvent.findMany()).toEqual(before.events);
  });

  test("AC2: the calendar carries the booked block with its status, the closed day, the Not available runs and the day's job count", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await acceptJob1042(db, app);
    await db.publicHoliday.create({ data: { state: "WA", date: new Date("2027-03-10T00:00:00.000Z"), name: "Test Day" } });
    await put(bob, off(TUE, "07:00", "07:30"));
    const block = await db.calendarEvent.findFirstOrThrow({ where: { type: "job" } });
    const jobDay = new Date(block.startTime.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    const cal = (await request(app).get(`/api/contractor/calendar?from=${WEEK}&to=${SUN}`).set("Cookie", bob)).body as {
      days: { date: string; closed: string | null; notAvailable: { startMinutes: number; endMinutes: number }[]; blocks: unknown[] }[];
    };
    expect(cal.days).toHaveLength(7);
    expect(cal.days.find((d) => d.date === "2027-03-10")?.closed).toBe("Test Day");
    expect(cal.days.find((d) => d.date === TUE)?.notAvailable).toEqual([{ startMinutes: 420, endMinutes: 480 }]);
    const jobCal = (await request(app).get(`/api/contractor/calendar?from=${jobDay}&to=${jobDay}`).set("Cookie", bob)).body as { days: { blocks: { status: string; jobReference: string; timeLabel: string }[] }[] };
    expect(jobCal.days[0]?.blocks[0]).toMatchObject({ status: "booked", jobReference: "JOB-1042", timeLabel: "8:00-9:00am" });
  });
});
