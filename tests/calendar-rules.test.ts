// Feature 1020 -- opening hours and holidays on dispatch, reschedule, the enquiry and the request edit
//
// AC3  dispatch and reschedule refuse a slot that starts before opening or ends after closing, an emergency included
// AC4  booked jobs do not change when the hours change
// AC6  dispatch and reschedule on a holiday are refused for that job's state, an emergency included; another state's holiday does not refuse
// AC7  the enquiry, the phone intake and the request edit refuse a holiday as the wanted date, with the words
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express from "express";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { buildOpsApp, freshWorld, makeNewJob, signIn, MONDAY, acceptJob1042 } from "./helpers/ops-app.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: ReturnType<typeof buildOpsApp>;
const email = recordingAdapter("test-email-1020-rules", "email");

beforeAll(() => {
  db = testClient();
  app = buildOpsApp(db);
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await freshWorld(db, email);
});

function dispatch(cookie: string, reference: string, body: Record<string, unknown>) {
  return request(app).post(`/api/jobs/${reference}/dispatch`).set("Cookie", cookie).send(body);
}
const slot = (over: Record<string, unknown> = {}) => ({ contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false, ...over });
const OUTSIDE = "That time is outside opening hours. Pick another time.";

describe("AC3 -- opening hours on dispatch", () => {
  test("AC3: 7:00am-8:00am is fine; 6:30am, and a hold that ends after 7:00pm, are refused with nothing written; emergency gets no way round", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    for (const over of [{ startMinutes: 390 }, { startMinutes: 1080, holdMinutes: 90 }, { startMinutes: 390, emergency: true }]) {
      const res = await dispatch(mike, job.reference, slot(over));
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe(OUTSIDE);
    }
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
    expect((await dispatch(mike, job.reference, slot({ startMinutes: 1050, holdMinutes: 60 }))).status).toBe(201);
  });

  test("AC3: the hours the owner sets decide, and the dispatch facts carry them", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    await db.platformSettings.updateMany({ data: { openingTime: "09:00", closingTime: "17:00" } });
    const facts = await request(app).get(`/api/jobs/${job.reference}/dispatch`).set("Cookie", mike);
    expect(facts.body).toMatchObject({ openingTime: "09:00", closingTime: "17:00" });
    expect((await dispatch(mike, job.reference, slot({ startMinutes: 480 }))).status).toBe(400);
    expect((await dispatch(mike, job.reference, slot({ startMinutes: 540 }))).status).toBe(201);
  });

  test("AC3: reschedule refuses a slot outside the hours too, and the booking stays where it was", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await acceptJob1042(db, app);
    const before = await db.calendarEvent.findMany({ where: { job: { reference: "JOB-1042" } }, orderBy: { startTime: "asc" } });
    const res = await request(app).post("/api/jobs/JOB-1042/reschedule").set("Cookie", mike).send({ date: MONDAY, startMinutes: 1110, holdMinutes: 60, emergency: true });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(OUTSIDE);
    const after = await db.calendarEvent.findMany({ where: { job: { reference: "JOB-1042" } }, orderBy: { startTime: "asc" } });
    expect(after.map((e) => e.startTime)).toEqual(before.map((e) => e.startTime));
  });
});

describe("AC4 -- booked jobs stay put when the hours change", () => {
  test("AC4: narrowing the hours leaves an existing booking exactly as it was", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    expect((await dispatch(mike, job.reference, slot({ startMinutes: 420 }))).status).toBe(201);
    const before = await db.calendarEvent.findMany({ where: { jobId: job.id } });
    await db.platformSettings.updateMany({ data: { openingTime: "10:00", closingTime: "16:00" } });
    const after = await db.calendarEvent.findMany({ where: { jobId: job.id } });
    expect(after).toEqual(before);
    expect(await db.assignment.count({ where: { jobId: job.id, status: "assigned" } })).toBe(1);
  });
});

describe("AC6 -- holidays on dispatch and reschedule", () => {
  test("AC6: a WA holiday refuses a WA job with the holiday's name, emergency included; NSW's holiday does not", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    await db.publicHoliday.create({ data: { state: "WA", date: new Date(`${MONDAY}T00:00:00.000Z`), name: "Christmas Day" } });
    for (const emergency of [false, true]) {
      const res = await dispatch(mike, job.reference, slot({ emergency }));
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe("Closed for Christmas Day. Pick another time.");
    }
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
    await db.publicHoliday.deleteMany({});
    await db.publicHoliday.create({ data: { state: "NSW", date: new Date(`${MONDAY}T00:00:00.000Z`), name: "Christmas Day" } });
    expect((await dispatch(mike, job.reference, slot())).status).toBe(201);
  });

  test("AC6: reschedule onto a holiday is refused", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await acceptJob1042(db, app);
    await db.publicHoliday.create({ data: { state: "WA", date: new Date(`${MONDAY}T00:00:00.000Z`), name: "Christmas Day" } });
    const res = await request(app).post("/api/jobs/JOB-1042/reschedule").set("Cookie", mike).send({ date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("Closed for Christmas Day. Pick another time.");
  });
});

describe("AC7 -- a holiday as the wanted date", () => {
  const WORDS = "We're closed on Christmas Day. Please pick another date.";
  const enquiryApp = (): express.Express => {
    const a = express();
    a.use(express.json());
    a.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
    return a;
  };
  const enquiry = (preferredDate: string) => ({
    name: "Karl",
    email: "karl@idelta.com.au",
    phone: "0400 000 999",
    location: { suburb: "Joondalup", state: "WA", country: "AU", postcode: "6027", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" },
    trade: "Plumbing",
    selectedOptions: ["Where in the property is it?: Kitchen"],
    preferredDate,
    preferredWindow: "morning",
    description: "Kitchen tap won't stop dripping.",
    marketingEmail: false,
    marketingSms: false,
    recaptchaToken: "x",
  });

  test("AC7: the enquiry form's server refuses a WA holiday with the words and the field; a day later it goes through", async () => {
    await db.publicHoliday.create({ data: { state: "WA", date: new Date("2099-12-25T00:00:00.000Z"), name: "Christmas Day" } });
    const jobsBefore = await db.job.count();
    const res = await request(enquiryApp()).post("/api/enquiries").send(enquiry("2099-12-25"));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: WORDS, field: "preferredDate" });
    expect(await db.job.count()).toBe(jobsBefore);
    expect((await request(enquiryApp()).post("/api/enquiries").send(enquiry("2099-12-24"))).status).toBeLessThan(300);
  });

  test("AC7: the phone intake refuses it too", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await db.publicHoliday.create({ data: { state: "WA", date: new Date("2099-12-25T00:00:00.000Z"), name: "Christmas Day" } });
    const res = await request(app).post("/api/jobs/phone").set("Cookie", mike).send(enquiry("2099-12-25"));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: WORDS, field: "preferredDate" });
  });

  test("AC7: a request edit refuses a holiday as the new wanted date and leaves the job as it was", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    await db.publicHoliday.create({ data: { state: "WA", date: new Date("2099-12-25T00:00:00.000Z"), name: "Christmas Day" } });
    const before = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    const res = await request(app).put(`/api/jobs/${job.reference}/request`).set("Cookie", mike).send({ preferredDate: "2099-12-25" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: WORDS, field: "preferredDate" });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).preferredDate).toEqual(before.preferredDate);
  });
});
