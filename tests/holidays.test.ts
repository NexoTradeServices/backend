// Feature 1020 -- public holidays (routes, the open read, the migration's WA dates)
//
// AC5  the owner adds and removes a holiday for any state and year; a second one on the same state and date is refused
// AC8  adding a holiday on a day with a booked job leaves the job booked and returns "1 job is already booked that day"
// AC9  Remove all: a finished year only, one state and year at a time; the current and future years are refused
// AC10 WA's published dates for 2026 and 2027 are there after the migration
// also: owner-only writes, Mike refused, the open read for the forms
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { buildOpsApp, freshWorld, makeNewJob, signIn, MONDAY } from "./helpers/ops-app.js";
import { holidayRoutes, publicHolidayRoutes } from "../src/holidays/routes.js";
import { todayIn } from "../src/time/index.js";
import type { PrismaClient } from "../src/db/client.js";

const MIGRATION = new URL("../prisma/migrations/20261102100000_opening_hours_and_holidays/migration.sql", import.meta.url);

let db: PrismaClient;
let app: ReturnType<typeof buildOpsApp>;
const email = recordingAdapter("test-email-1020-holidays", "email");

beforeAll(() => {
  db = testClient();
  app = buildOpsApp(db);
  app.use("/api/holidays", holidayRoutes(db));
  app.use("/api/public-holidays", publicHolidayRoutes(db));
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await freshWorld(db, email);
  await db.publicHoliday.deleteMany(); // the fixtures load NSW's (1021); these tests start from none
});

const thisYear = (): number => Number(todayIn("Australia/Perth").slice(0, 4));

describe("AC10 -- the migration loads WA's dates", () => {
  test("AC10: running the migration's insert gives WA its 2026 and 2027 holidays, Christmas and Boxing Day among them", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const insert = sql.slice(sql.indexOf('INSERT INTO "PublicHoliday"'));
    expect(await db.publicHoliday.count()).toBe(0);
    await db.$executeRawUnsafe(insert);
    const in2026 = await db.publicHoliday.count({ where: { state: "WA", date: { gte: new Date("2026-01-01"), lt: new Date("2027-01-01") } } });
    const in2027 = await db.publicHoliday.count({ where: { state: "WA", date: { gte: new Date("2027-01-01"), lt: new Date("2028-01-01") } } });
    expect(in2026).toBeGreaterThanOrEqual(7);
    expect(in2027).toBeGreaterThanOrEqual(7);
    expect((await db.publicHoliday.findUnique({ where: { state_date: { state: "WA", date: new Date("2026-12-25") } } }))?.name).toBe("Christmas Day");
    expect((await db.publicHoliday.findUnique({ where: { state_date: { state: "WA", date: new Date("2027-09-27") } } }))?.name).toBe("King's Birthday");
  });
});

describe("AC5 -- add and remove", () => {
  test("AC5: the owner adds a holiday for NSW 2028 and removes it; the list follows each step", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    const added = await request(app).post("/api/holidays").set("Cookie", owner).send({ state: "NSW", date: "2028-01-26", name: "Australia Day" });
    expect(added.status).toBe(201);
    const list = await request(app).get("/api/holidays?state=NSW&year=2028").set("Cookie", owner);
    expect((list.body as { holidays: { date: string; name: string }[] }).holidays).toMatchObject([{ date: "2028-01-26", name: "Australia Day" }]);
    const id = (added.body as { holiday: { id: string } }).holiday.id;
    expect((await request(app).delete(`/api/holidays/${id}`).set("Cookie", owner)).status).toBe(204);
    expect(await db.publicHoliday.count({ where: { state: "NSW" } })).toBe(0);
  });

  test("AC5: a second holiday on the same state and date is refused; a blank name or date is refused", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    const body = { state: "WA", date: "2028-12-25", name: "Christmas Day" };
    expect((await request(app).post("/api/holidays").set("Cookie", owner).send(body)).status).toBe(201);
    const again = await request(app).post("/api/holidays").set("Cookie", owner).send(body);
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toBe("WA already has a holiday on that date.");
    expect((await request(app).post("/api/holidays").set("Cookie", owner).send({ ...body, name: " ", date: "2028-12-26" })).status).toBe(400);
    expect((await request(app).post("/api/holidays").set("Cookie", owner).send({ ...body, date: "" })).status).toBe(400);
    expect(await db.publicHoliday.count()).toBe(1);
  });

  test("owner only: Mike is refused every write and read; the open read needs no login and lists from today on", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    expect((await request(app).get("/api/holidays?state=WA&year=2028").set("Cookie", mike)).status).toBe(403);
    expect((await request(app).post("/api/holidays").set("Cookie", mike).send({ state: "WA", date: "2028-01-01", name: "New Year" })).status).toBe(403);
    expect((await request(app).delete("/api/holidays?state=WA&year=2020").set("Cookie", mike)).status).toBe(403);
    await db.publicHoliday.createMany({
      data: [
        { state: "WA", date: new Date("2020-01-01"), name: "Long ago" },
        { state: "WA", date: new Date("2099-12-25"), name: "Christmas Day" },
        { state: "NSW", date: new Date("2099-12-25"), name: "Not WA" },
      ],
    });
    const open = await request(app).get("/api/public-holidays?state=WA");
    expect(open.status).toBe(200);
    expect((open.body as { holidays: unknown[] }).holidays).toEqual([{ date: "2099-12-25", name: "Christmas Day" }]);
    expect((await request(app).get("/api/public-holidays")).status).toBe(400);
  });
});

describe("AC8 -- a holiday on a booked day", () => {
  test("AC8: the job stays booked and the add reports 1 booked job; another state's job is not counted", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const owner = await signIn(app, "owner@idelta.com.au");
    const job = await makeNewJob(db);
    const dispatched = await request(app)
      .post(`/api/jobs/${job.reference}/dispatch`)
      .set("Cookie", mike)
      .send({ contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(dispatched.status).toBe(201);
    const added = await request(app).post("/api/holidays").set("Cookie", owner).send({ state: "WA", date: MONDAY, name: "Test Day" });
    expect(added.status).toBe(201);
    expect((added.body as { bookedJobs: number }).bookedJobs).toBe(1);
    const other = await request(app).post("/api/holidays").set("Cookie", owner).send({ state: "NSW", date: MONDAY, name: "Test Day" });
    expect((other.body as { bookedJobs: number }).bookedJobs).toBe(0);
    const stillBooked = await db.assignment.count({ where: { jobId: job.id, status: "assigned" } });
    expect(stillBooked).toBe(1);
  });
});

describe("1020 -- past years are cleaned up, never added to", () => {
  test("adding to a past year is refused; removing one row of it works; the current year still takes an add", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    const past = thisYear() - 1;
    const refused = await request(app).post("/api/holidays").set("Cookie", owner).send({ state: "NSW", date: `${String(past)}-03-01`, name: "Too late" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "Past years can't be added to.", field: "date" });
    expect(await db.publicHoliday.count({ where: { state: "NSW" } })).toBe(0);
    const old = await db.publicHoliday.create({ data: { state: "NSW", date: new Date(`${String(past)}-03-01`), name: "Old row" } });
    expect((await request(app).delete(`/api/holidays/${old.id}`).set("Cookie", owner)).status).toBe(204);
    const now = await request(app).post("/api/holidays").set("Cookie", owner).send({ state: "NSW", date: `${String(thisYear())}-12-30`, name: "This year" });
    expect(now.status).toBe(201);
  });
});

describe("AC9 -- Remove all", () => {
  test("AC9: a finished year goes in one call, other years and states stay; this year and next are refused", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    const past = thisYear() - 1;
    await db.publicHoliday.createMany({
      data: [
        { state: "WA", date: new Date(`${String(past)}-01-01`), name: "A" },
        { state: "WA", date: new Date(`${String(past)}-12-25`), name: "B" },
        { state: "NSW", date: new Date(`${String(past)}-12-25`), name: "C" },
        { state: "WA", date: new Date(`${String(thisYear())}-12-25`), name: "D" },
      ],
    });
    const removed = await request(app).delete(`/api/holidays?state=WA&year=${String(past)}`).set("Cookie", owner);
    expect(removed.status).toBe(200);
    expect((removed.body as { removed: number }).removed).toBe(2);
    expect(await db.publicHoliday.count()).toBe(2);
    expect((await request(app).delete(`/api/holidays?state=WA&year=${String(thisYear())}`).set("Cookie", owner)).status).toBe(409);
    expect((await request(app).delete(`/api/holidays?state=WA&year=${String(thisYear() + 1)}`).set("Cookie", owner)).status).toBe(409);
    expect(await db.publicHoliday.count()).toBe(2);
  });
});
