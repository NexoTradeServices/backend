// Feature 1022 -- time zones
//
// AC5  a Sydney job's job-tomorrow reminder goes at 9:00am Sydney time the day before - before 9:00am Perth; a Perth
//      job's at 9:00am Perth time; each sends once
// AC6  a booking accepted after that morning's 9:00am on the job's clock gets no reminder, and the confirmation's
//      reminder line reads the job's clock
// AC7  at 10pm in Perth a Sydney suburb's "today" is already tomorrow's date: the earlier date is refused by the server
// AC8  the dispatch day view draws a Sydney job's day in Sydney time; a slot picked at 8:00am is 8:00am Sydney on the booking,
//      in summer and in winter
// AC9  opening hours and public holidays on a Sydney job read Sydney's clock and NSW's list
// AC11 Perth jobs behave as they did (the other test files)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { buildOpsApp, freshWorld, makeNewJob, signIn } from "./helpers/ops-app.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { dailyTick, DAILY_RUN_AT } from "../src/daily/index.js";
import { reminderWillCome } from "../src/jobs/job-tomorrow.js";
import { nextReference } from "../src/db/reference.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { zoneForState } from "../src/time/index.js";
import { seedWaHolidays } from "./helpers/holidays.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: ReturnType<typeof buildOpsApp>;
const email = recordingAdapter("test-email-1022", "email");

const NEWTOWN = { suburb: "Newtown", state: "NSW", country: "AU", postcode: "2042", lat: -33.897644, lng: 151.180228, placeId: "fixture-place-newtown" };

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  app = buildOpsApp(db);
  const rest = express.Router();
  rest.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
  app.use(rest);
});
afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});
beforeEach(async () => {
  await freshWorld(db, email);
  await seedWaHolidays(db); // keep the "public holidays missing" step quiet
  const liam = await db.contractor.findUniqueOrThrow({ where: { code: "CON-037" } });
  await db.contractorServedPostcode.create({ data: { contractorId: liam.id, postcode: "2042" } });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A Newtown (NSW) plumbing job for Hannah, new, with a site address - no booking yet. */
async function makeSydneyJob(preferred = "2027-03-16"): Promise<{ id: string; reference: string }> {
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const hannah =
    (await db.customer.findUnique({ where: { email: "hannah@idelta.com.au" } })) ??
    (await db.customer.create({ data: { code: await nextReference("CUS", db), name: "Hannah Lee", email: "hannah@idelta.com.au", phone: "0400 001 054" } }));
  const job = await db.job.create({
    data: {
      reference: await nextReference("JOB", db),
      customerId: hannah.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "2042",
      serviceLocation: NEWTOWN,
      siteAddress: { street: "30 King Street", ...NEWTOWN },
      timezone: "Australia/Sydney",
      description: "A Sydney test job.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date(`${preferred}T00:00:00.000Z`),
      status: "new",
    },
  });
  return { id: job.id, reference: job.reference };
}

/** A booked, accepted visit for `job` with `contractorCode` at `slot`, accepted at `acceptedAt`. */
async function bookVisit(jobId: string, contractorCode: string, slot: Date, acceptedAt: Date): Promise<void> {
  const contractor = await db.contractor.findUniqueOrThrow({ where: { code: contractorCode }, include: { specialties: true } });
  const assignment = await db.assignment.create({
    data: {
      jobId,
      contractorId: contractor.id,
      specialtyId: contractor.specialties[0]?.id ?? "",
      status: "accepted",
      proposedSlot: slot,
      confirmedSlot: slot,
      acceptedAt,
    },
  });
  await db.calendarEvent.create({
    data: { contractorId: contractor.id, type: "job", jobId, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 3_600_000) },
  });
  await db.job.update({ where: { id: jobId }, data: { status: "scheduled", serviceLevel: "normal" } });
}

const remindersFor = async (jobId: string): Promise<number> =>
  db.notification.count({ where: { jobId, type: "job_tomorrow", recipientType: "customer", channel: "email" } });

describe("AC5, AC6 -- the reminder runs on the job's own clock", () => {
  // Tue 3 Nov 2026, 9:00am: Sydney is AEDT (UTC+11) -> 2026-11-02T22:00Z; Perth is UTC+8 -> 2026-11-03T01:00Z.
  const SYDNEY_VISIT = new Date("2026-11-02T22:00:00.000Z");
  const PERTH_VISIT = new Date("2026-11-03T01:00:00.000Z");
  // The Sydney morning of Mon 2 Nov: 9:00am Sydney = 2026-11-01T22:00Z (= 6:00am Perth).
  const SYDNEY_9AM = new Date("2026-11-01T22:00:00.000Z");
  // The Perth morning of Mon 2 Nov: 9:00am Perth = 2026-11-02T01:00Z.
  const PERTH_9AM = new Date("2026-11-02T01:00:00.000Z");
  const MIN = 60_000;

  test("AC5: a Sydney job's reminder goes at 9:00am Sydney time - not at 8:55 - and only once, though it is 6am in Perth", async () => {
    const job = await makeSydneyJob();
    await bookVisit(job.id, "CON-037", SYDNEY_VISIT, new Date(SYDNEY_9AM.getTime() - 60 * 60_000 * 20));
    await dailyTick(db, new Date(SYDNEY_9AM.getTime() - 5 * MIN)); // 8:55am Sydney
    expect(await remindersFor(job.id)).toBe(0);
    await dailyTick(db, new Date(SYDNEY_9AM.getTime() + 5 * MIN)); // 9:05am Sydney = 6:05am Perth
    expect(await remindersFor(job.id)).toBe(1);
    await dailyTick(db, new Date(SYDNEY_9AM.getTime() + 6 * 60 * MIN)); // later that day
    await dailyTick(db, new Date(PERTH_9AM.getTime() + 5 * MIN)); // 9:05am Perth the same Monday
    expect(await remindersFor(job.id)).toBe(1);
    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "hannah@idelta.com.au");
    expect(mail?.message.text).toContain("tomorrow, Tue 3 Nov, at 9:00am");
    expect(mail?.message.text).not.toMatch(/AWST|AEDT|NSW time/);
  });

  test("AC5: a Perth job's reminder goes at 9:00am Perth time, not at 9:00am Sydney, and only once", async () => {
    const job = await makeNewJob(db);
    await bookVisit(job.id, "CON-014", PERTH_VISIT, new Date(PERTH_9AM.getTime() - 20 * 60 * MIN));
    await db.job.update({ where: { id: job.id }, data: { preferredDate: new Date("2026-11-03T00:00:00.000Z") } });
    await dailyTick(db, new Date(SYDNEY_9AM.getTime() + 5 * MIN)); // 6:05am Perth
    expect(await remindersFor(job.id)).toBe(0);
    await dailyTick(db, new Date(PERTH_9AM.getTime() + 5 * MIN));
    await dailyTick(db, new Date(PERTH_9AM.getTime() + 10 * MIN));
    expect(await remindersFor(job.id)).toBe(1);
  });

  test("AC5: the same holds in winter (AEST, UTC+10): 9:00am Sydney is 23:00 UTC", async () => {
    const job = await makeSydneyJob("2027-07-20");
    const visit = new Date("2027-07-19T23:00:00.000Z"); // Tue 20 Jul 9:00am AEST
    const nineSydney = new Date("2027-07-18T23:00:00.000Z"); // Mon 19 Jul 9:00am AEST
    await bookVisit(job.id, "CON-037", visit, new Date(nineSydney.getTime() - 10 * 60 * MIN));
    await dailyTick(db, new Date(nineSydney.getTime() - 5 * MIN));
    expect(await remindersFor(job.id)).toBe(0);
    await dailyTick(db, new Date(nineSydney.getTime() + 5 * MIN));
    expect(await remindersFor(job.id)).toBe(1);
  });

  test("AC6: a booking accepted after that morning's 9:00am on the job's clock gets no reminder", async () => {
    const job = await makeSydneyJob();
    await bookVisit(job.id, "CON-037", SYDNEY_VISIT, new Date(SYDNEY_9AM.getTime() + 30 * MIN)); // 9:30am Sydney
    await dailyTick(db, new Date(SYDNEY_9AM.getTime() + 2 * 60 * MIN));
    await dailyTick(db, new Date(SYDNEY_9AM.getTime() + 20 * 60 * MIN));
    expect(await remindersFor(job.id)).toBe(0);
  });

  test("AC6: the confirmation's reminder line reads the job's clock", () => {
    const slot = SYDNEY_VISIT; // Tue 3 Nov 9:00am Sydney
    const at = (utc: Date) => reminderWillCome({ jobZone: zoneForState("NSW"), slot, now: utc, runAt: DAILY_RUN_AT });
    expect(at(new Date(SYDNEY_9AM.getTime() - 60 * MIN))).toBe(true); // 8:00am Monday Sydney: still before the run
    expect(at(new Date(SYDNEY_9AM.getTime() + 60 * MIN))).toBe(false); // 10:00am Monday Sydney: too late for tomorrow's
    expect(at(new Date(SYDNEY_9AM.getTime() - 24 * 60 * MIN))).toBe(true); // Sunday: two days away
  });
});

describe("AC7 -- today is the suburb's state's today", () => {
  const enquiry = (location: Record<string, unknown>, preferredDate: string) => ({
    name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999", location, trade: "Plumbing", selectedOptions: [],
    preferredDate, preferredWindow: "morning", description: "Tap.", marketingEmail: false, marketingSms: false, recaptchaToken: "x",
  });
  const HILTON = { suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };

  test("AC7: at 10:30pm Mon 2 Nov in Perth it is already Tue 3 Nov in Sydney - the endpoint says so, and the server refuses 2 Nov for a Sydney suburb only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T14:30:00.000Z")); // 10:30pm Perth, 1:30am Sydney (next day)
    expect((await request(app).get("/api/enquiries/today?state=WA")).body).toMatchObject({ date: "2026-11-02" });
    expect((await request(app).get("/api/enquiries/today?state=NSW")).body).toMatchObject({ date: "2026-11-03" });
    expect((await request(app).get("/api/enquiries/today")).body).toMatchObject({ date: "2026-11-02" }); // the business clock
    expect((await request(app).get("/api/enquiries/today?state=ZZ")).status).toBe(400);

    const sydney = await request(app).post("/api/enquiries").send(enquiry(NEWTOWN, "2026-11-02"));
    expect(sydney.status).toBe(400);
    expect(sydney.body).toMatchObject({ error: "That date has passed. Pick another date.", field: "preferredDate" });
    expect((await request(app).post("/api/enquiries").send(enquiry(NEWTOWN, "2026-11-03"))).status).toBe(201);
    expect((await request(app).post("/api/enquiries").send(enquiry(HILTON, "2026-11-02"))).status).toBe(201); // Perth: still today
    expect((await request(app).post("/api/enquiries").send(enquiry(HILTON, "2026-11-01"))).status).toBe(400);
  });

  test("AC7: phone intake refuses the passed date the same way", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T14:30:00.000Z"));
    const mike = await signIn(app, "mike@idelta.com.au");
    const res = await request(app).post("/api/jobs/phone").set("Cookie", mike).send(enquiry(NEWTOWN, "2026-11-02"));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "That date has passed. Pick another date.", field: "preferredDate" });
  });
});

describe("AC8, AC9 -- dispatch for a Sydney job", () => {
  const dispatch = (cookie: string, reference: string, over: Record<string, unknown> = {}) =>
    request(app).post(`/api/jobs/${reference}/dispatch`).set("Cookie", cookie).send({ contractorCode: "CON-037", date: "2027-01-18", startMinutes: 480, holdMinutes: 60, emergency: false, ...over });

  test("AC8: a slot picked at 8:00am is 8:00am Sydney on the booking - in summer and in winter - and the day view draws it in Sydney time", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const summer = await makeSydneyJob("2027-01-18");
    const first = await dispatch(mike, summer.reference);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const winter = await makeSydneyJob("2027-06-22");
    const second = await dispatch(mike, winter.reference, { date: "2027-06-22" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const slots = await db.assignment.findMany({ where: { jobId: { in: [summer.id, winter.id] } }, orderBy: { proposedSlot: "asc" } });
    expect(slots.map((a) => a.proposedSlot?.toISOString())).toEqual(["2027-01-17T21:00:00.000Z", "2027-06-21T22:00:00.000Z"]); // summer AEDT UTC+11, winter AEST UTC+10

    const day = await request(app).get(`/api/contractors/CON-037/day?date=2027-01-18&job=${summer.reference}`).set("Cookie", mike);
    expect(day.body).toMatchObject({ blocks: [{ startMinutes: 480, endMinutes: 540, timeLabel: "8:00-9:00am NSW time", kind: "hold" }] });
    // Without the job the day is drawn on the business (Perth) clock, so the same block sits elsewhere.
    const perthDay = await request(app).get("/api/contractors/CON-037/day?date=2027-01-18").set("Cookie", mike);
    expect((perthDay.body as { blocks: { startMinutes: number }[] }).blocks[0]?.startMinutes).toBe(300); // 8:00am Sydney is 5:00am Perth
  });

  test("AC8: the dispatch read names the state's time for the page", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeSydneyJob();
    const res = await request(app).get(`/api/jobs/${job.reference}/dispatch`).set("Cookie", mike);
    expect(res.body).toMatchObject({ stateLabel: "NSW time" });
    const perth = await makeNewJob(db);
    expect((await request(app).get(`/api/jobs/${perth.reference}/dispatch`).set("Cookie", mike)).body).toMatchObject({ stateLabel: "WA time" });
  });

  test("AC9: hours and holidays on a Sydney job read Sydney's clock and NSW's list - King's Birthday 14 Jun 2027 is NSW's, not WA's", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const sydney = await makeSydneyJob("2027-06-14");
    const refused = await dispatch(mike, sydney.reference, { date: "2027-06-14" });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "Closed for King's Birthday. Pick another time." });
    // the same day for a Perth job is an ordinary working Monday
    const perth = await makeNewJob(db);
    const waDispatch = await request(app).post(`/api/jobs/${perth.reference}/dispatch`).set("Cookie", mike).send({ contractorCode: "CON-014", date: "2027-06-14", startMinutes: 480, holdMinutes: 60, emergency: false });
    expect(waDispatch.status).toBe(201);
    // opening hours: 6:00am Sydney is before 7:00am on the job's clock
    const early = await makeSydneyJob("2027-06-15");
    expect((await dispatch(mike, early.reference, { date: "2027-06-15", startMinutes: 360 })).status).toBe(400);
  });
});
