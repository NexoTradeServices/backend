// Feature 1021 -- operating states
//
// AC1  the owner ticks and unticks states and it holds, with who and when; Mike cannot reach it
// AC2  opening a state with fewer than 7 holidays for the current year is refused (the whole Save), 7 opens it
// AC3  closing a state leaves its existing jobs workable (dispatch, reschedule) and its contractors on the books
// AC4  the coverage check and the enquiry refuse a closed state; nothing is saved
// AC5  phone intake refuses a closed state; a job cannot move to one; an edit inside its own closed state works
// AC6  inside an open state the tiers behave as before
// AC7  a new contractor needs an open Operating state; refused before the login is made, so no invite
// AC8  only ops and the owner set it; Mike moves a contractor to an open state, keeps a closed current one
// AC9  a pin outside the contractor's state is refused with each caller's words; a radius across a border leaves those postcodes out
// AC10 after the state changes the contractor is Not ready with "Service area outside <state>"; booked jobs stay
// AC11 the missing holidays check covers open states only
// AC12 Liam, a ready NSW contractor, is in the fixtures; the base seed alone opens WA only
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express from "express";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { buildOpsApp, freshWorld, makeNewJob, signIn, MONDAY } from "./helpers/ops-app.js";
import { settingsRoutes } from "../src/settings/routes.js";
import { operatingStatesRoutes } from "../src/holidays/operating-states.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { suburbRoutes } from "../src/suburbs/routes.js";
import { contractorServiceAreaRoutes } from "../src/contractors/service-area-routes.js";
import { missingHolidays } from "../src/holidays/missing.js";
import { runPublicHolidaysMissing } from "../src/holidays/missing-step.js";
import { seedBase } from "../src/db/seed/base.js";
import { todayIn } from "../src/time/index.js";
import { Prisma } from "../src/generated/prisma/client.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: ReturnType<typeof buildOpsApp>;
const email = recordingAdapter("test-email-1021", "email");

const NEWTOWN = { suburb: "Newtown", state: "NSW", country: "AU", postcode: "2042", lat: -33.897644, lng: 151.180228, placeId: "fixture-place-newtown" };
const ENMORE = { suburb: "Enmore", state: "NSW", country: "AU", postcode: "2042", lat: -33.8990, lng: 151.1735, placeId: "fixture-place-enmore" };
const MELBOURNE = { suburb: "Melbourne", state: "VIC", country: "AU", postcode: "3000", lat: -37.8136, lng: 144.9631, placeId: "fixture-place-melbourne" };
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };

const thisYear = (): number => Number(todayIn("Australia/Perth").slice(0, 4));

function settingsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gstRegistered: false, businessAbn: null, legalEntityName: "Trade Services", businessAddress: null,
    gstRatePercent: 10, paymentTermsDays: 7, serviceReachKm: 25, calloutFee: 15_000, returnVisitMinimumMinutes: 30,
    maxContractorPartAmount: 15_000, operatorPhone: "08 0000 0000", operatorEmail: "ops@idelta.com.au",
    displayName: "Perth Trades & Services", timezone: "Australia/Perth", payoutCycle: "weekly", payoutDay: "fri",
    emailProvider: "mailjet", smsProvider: "clicksend", ...overrides,
  };
}

function contractorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { operatingState: "NSW", name: "Nina New", email: "nina.new@idelta.com.au", phone: "0412 345 678", ...overrides };
}

async function addHolidays(state: string, count: number, year = thisYear()): Promise<void> {
  await db.publicHoliday.createMany({
    data: Array.from({ length: count }, (_, i) => ({ state, date: new Date(Date.UTC(year, i, 10)), name: `Day ${String(i + 1)}` })),
    skipDuplicates: true,
  });
}

beforeAll(() => {
  db = testClient();
  app = buildOpsApp(db);
  const rest = express.Router();
  rest.use("/api/settings", settingsRoutes(db));
  rest.use("/api/operating-states", operatingStatesRoutes(db));
  rest.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
  rest.use("/api/suburbs", suburbRoutes(db));
  rest.use("/api/contractor", contractorServiceAreaRoutes(db));
  app.use(rest);
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await freshWorld(db, email);
});

const put = (cookie: string, overrides: Record<string, unknown>) => request(app).put("/api/settings").set("Cookie", cookie).send(settingsBody(overrides));

describe("AC1 -- ticking states on Settings", () => {
  test("AC1: the owner unticks NSW and it holds after a reload with who and when; WA stays unstamped", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    const before = await request(app).get("/api/settings").set("Cookie", owner);
    const states = (before.body as { operatingStates: { state: string; open: boolean }[] }).operatingStates;
    expect(states).toHaveLength(8);
    expect(states.filter((s) => s.open).map((s) => s.state).sort()).toEqual(["NSW", "WA"]);
    const saved = await put(owner, { operatingStates: ["WA"] });
    expect(saved.status).toBe(200);
    const after = await request(app).get("/api/settings").set("Cookie", owner);
    const rows = (after.body as { operatingStates: { state: string; open: boolean; changedBy: string | null; changedAt: string | null }[] }).operatingStates;
    expect(rows.find((r) => r.state === "NSW")).toMatchObject({ open: false, changedBy: "The owner" });
    expect(rows.find((r) => r.state === "NSW")?.changedAt).not.toBeNull();
    expect(rows.find((r) => r.state === "WA")).toMatchObject({ open: true, changedAt: null });
  });

  test("AC1: the rows GET gave can be sent straight back (the open ones count)", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    const got = (await request(app).get("/api/settings").set("Cookie", owner)).body as Record<string, unknown>;
    const res = await put(owner, { operatingStates: got["operatingStates"] }); // the rows, as GET gave them
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await db.operatingState.findMany({ where: { open: true } })).map((r) => r.state).sort()).toEqual(["NSW", "WA"]);
  });

  test("AC1: a save without the list leaves the states alone; Mike cannot reach it", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    expect((await put(owner, {})).status).toBe(200);
    expect(await db.operatingState.count({ where: { open: true } })).toBe(2);
    const mike = await signIn(app, "mike@idelta.com.au");
    expect((await put(mike, { operatingStates: ["WA"] })).status).toBe(403);
    expect((await request(app).get("/api/settings").set("Cookie", mike)).status).toBe(403);
  });
});

describe("AC2 -- a state opens only with its holidays in", () => {
  test("AC2: VIC with no holidays is refused with the words and the state; nothing else in the save is kept", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    const res = await put(owner, { operatingStates: ["WA", "NSW", "VIC"], displayName: "Changed Name" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Can't open VIC until its public holidays are entered.", field: "operatingStates", state: "VIC" });
    expect((await db.operatingState.findUniqueOrThrow({ where: { state: "VIC" } })).open).toBe(false);
    expect((await db.platformSettings.findFirstOrThrow()).displayName).toBe("Perth Trades & Services");
  });

  test("AC2: 6 holidays is still refused; 7 opens it and stamps who and when", async () => {
    const owner = await signIn(app, "owner@idelta.com.au");
    await addHolidays("VIC", 6);
    expect((await put(owner, { operatingStates: ["WA", "NSW", "VIC"] })).status).toBe(400);
    await addHolidays("VIC", 7);
    const ok = await put(owner, { operatingStates: ["WA", "NSW", "VIC"] });
    expect(ok.status).toBe(200);
    const vic = await db.operatingState.findUniqueOrThrow({ where: { state: "VIC" } });
    expect(vic.open).toBe(true);
    expect(vic.changedAt).not.toBeNull();
    expect(vic.changedByUserId).not.toBeNull();
  });
});

describe("AC3 -- closing a state honours what is there", () => {
  test("AC3: with NSW unticked, Hannah's Newtown job is still dispatched to Liam and rescheduled; Liam stays on the books", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const owner = await signIn(app, "owner@idelta.com.au");
    const liam = await db.contractor.findUniqueOrThrow({ where: { code: "CON-037" } });
    await db.contractorServedPostcode.create({ data: { contractorId: liam.id, postcode: "2042" } });
    const job = await makeNewJob(db);
    await db.job.update({
      where: { id: job.id },
      data: { postcode: "2042", serviceLocation: NEWTOWN, siteAddress: { street: "1 King Street", ...NEWTOWN }, timezone: "Australia/Sydney" },
    });
    expect((await put(owner, { operatingStates: ["WA"] })).status).toBe(200);
    const dispatched = await request(app)
      .post(`/api/jobs/${job.reference}/dispatch`)
      .set("Cookie", mike)
      .send({ contractorCode: "CON-037", date: MONDAY, startMinutes: 540, holdMinutes: 60, emergency: false });
    expect(dispatched.status).toBe(201);
    const moved = await request(app)
      .post(`/api/jobs/${job.reference}/reschedule`)
      .set("Cookie", mike)
      .send({ date: MONDAY, startMinutes: 600, holdMinutes: 60, emergency: false });
    expect(moved.status).toBe(200);
    expect((await db.contractor.findUniqueOrThrow({ where: { code: "CON-037" } })).status).toBe("active");
  });
});

describe("AC4 -- the enquiry form stops at a closed state", () => {
  const enquiry = (location: Record<string, unknown>) => ({
    name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999", location, trade: "Plumbing",
    selectedOptions: [], preferredDate: "2099-06-02", preferredWindow: "morning", description: "Tap.",
    marketingEmail: false, marketingSms: false, recaptchaToken: "x",
  });

  test("AC4: coverage answers state_not_open for VIC first, even with a contractor nearby; a direct send is refused and saves nothing", async () => {
    const query = new URLSearchParams({ state: "VIC", postcode: "3000", lat: "-37.8136", lng: "144.9631" }).toString();
    expect((await request(app).get(`/api/enquiries/coverage?${query}`)).body).toEqual({ tier: "state_not_open" });
    const jobs = await db.job.count();
    const res = await request(app).post("/api/enquiries").send(enquiry(MELBOURNE));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Sorry, we don't currently operate or service in VIC.", field: "location" });
    expect(await db.job.count()).toBe(jobs);
    expect(await db.customer.count({ where: { email: "karl@idelta.com.au" } })).toBe(0);
  });

  test("AC6: inside open states the tiers are unchanged - Hilton is covered, a far WA point is out of reach, NSW with Liam's area is covered", async () => {
    const liam = await db.contractor.findUniqueOrThrow({ where: { code: "CON-037" } });
    await db.contractorServedPostcode.create({ data: { contractorId: liam.id, postcode: "2042" } });
    const tier = async (q: Record<string, string>): Promise<unknown> => (await request(app).get(`/api/enquiries/coverage?${new URLSearchParams(q).toString()}`)).body as unknown;
    expect(await tier({ state: "WA", postcode: "6163", lat: "-32.0731", lng: "115.7797" })).toEqual({ tier: "covered" });
    expect(await tier({ state: "WA", postcode: "6725", lat: "-17.96", lng: "122.23" })).toEqual({ tier: "out_of_reach" });
    expect(await tier({ state: "NSW", postcode: "2042", lat: "-33.8976", lng: "151.1802" })).toEqual({ tier: "covered" });
    expect(await tier({ postcode: "3000", lat: "-37.8136", lng: "144.9631" })).not.toEqual({ tier: "state_not_open" }); // the ops queue's read names no state
  });
});

describe("AC5 -- phone intake and the request edit", () => {
  test("AC5: phone intake refuses VIC with the words; the job's suburb cannot move to VIC; an edit inside its own closed state still works", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const phoneBody = {
      name: "Hannah Lee", email: "hannah@idelta.com.au", phone: "0400 001 053", location: MELBOURNE, trade: "Plumbing",
      selectedOptions: [], preferredDate: "2099-06-02", preferredWindow: "morning", description: "Tap.",
    };
    const refused = await request(app).post("/api/jobs/phone").set("Cookie", mike).send(phoneBody);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "VIC is not an operating state.", field: "location" });

    const made = await request(app).post("/api/jobs/phone").set("Cookie", mike).send({ ...phoneBody, location: NEWTOWN });
    expect(made.status).toBe(201);
    const reference = (made.body as { reference: string }).reference;
    const moveToVic = await request(app).put(`/api/jobs/${reference}/request`).set("Cookie", mike).send({ location: MELBOURNE });
    expect(moveToVic.status).toBe(400);
    expect(moveToVic.body).toMatchObject({ error: "VIC is not an operating state.", field: "location" });

    // NSW closes; the job is in NSW, so an edit that stays in NSW still works.
    await db.operatingState.update({ where: { state: "NSW" }, data: { open: false } });
    const inside = await request(app).put(`/api/jobs/${reference}/request`).set("Cookie", mike).send({ location: ENMORE, description: "Still a tap." });
    expect(inside.status).toBe(200);
    // ...and a job in WA cannot move into the now-closed NSW.
    const waJob = await makeNewJob(db);
    await db.job.update({ where: { id: waJob.id }, data: { siteAddress: Prisma.DbNull } }); // the suburb follows a site address; this one has none
    const intoNsw = await request(app).put(`/api/jobs/${waJob.reference}/request`).set("Cookie", mike).send({ location: NEWTOWN });
    expect(intoNsw.status).toBe(400);
  });
});

describe("AC7, AC8 -- the Operating state on the contractor record", () => {
  test("AC7: the state is required, and a closed state is refused before the login is made - no user, no invite", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const users = await db.user.count();
    const notifications = await db.notification.count();
    const none = await request(app).post("/api/contractors").set("Cookie", mike).send(contractorBody({ operatingState: undefined }));
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ field: "operatingState" });
    const closed = await request(app).post("/api/contractors").set("Cookie", mike).send(contractorBody({ operatingState: "VIC" }));
    expect(closed.status).toBe(400);
    expect(closed.body).toMatchObject({ error: "VIC is not an operating state.", field: "operatingState" });
    expect(await db.user.count()).toBe(users);
    expect(await db.notification.count()).toBe(notifications);
    const ok = await request(app).post("/api/contractors").set("Cookie", mike).send(contractorBody());
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ operatingState: "NSW" });
  });

  test("AC7: the form's list is the open states only", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const res = await request(app).get("/api/operating-states").set("Cookie", mike);
    expect((res.body as { states: string[] }).states.sort()).toEqual(["NSW", "WA"]);
  });

  test("AC8: Bob (contractor) cannot set it; Mike moves Dave to an open state, is refused a closed one, and a contractor's own closed state may stay", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    expect((await request(app).post("/api/contractors").set("Cookie", bob).send(contractorBody())).status).toBe(403);
    expect((await request(app).put("/api/contractors/CON-021").set("Cookie", bob).send(contractorBody())).status).toBe(403);

    const mike = await signIn(app, "mike@idelta.com.au");
    const dave = (await request(app).get("/api/contractors/CON-021").set("Cookie", mike)).body as Record<string, unknown>;
    const edit = (state: string | undefined) =>
      request(app).put("/api/contractors/CON-021").set("Cookie", mike).send({ ...dave, operatingState: state, specialties: dave["specialties"] });
    expect((await edit("NSW")).status).toBe(200);
    expect((await edit("VIC")).status).toBe(400);
    await db.operatingState.update({ where: { state: "NSW" }, data: { open: false } });
    expect((await edit("NSW")).status).toBe(200); // his current state stays even though it has closed
    expect((await edit(undefined)).status).toBe(200); // a save that does not name it leaves it alone
    expect((await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } })).operatingState).toBe("NSW");
  });
});

describe("AC9, AC10 -- the service area stays inside the state", () => {
  test("AC9: Liam saving a WA pin is refused in his own words; Mike's words name him; the old pin and area stay", async () => {
    const liam = await db.contractor.findUniqueOrThrow({ where: { code: "CON-037" } });
    await db.contractorServedPostcode.create({ data: { contractorId: liam.id, postcode: "2042" } });
    const waPin = { ...HILTON, placeId: "x" };
    const own = await signIn(app, "liam@idelta.com.au");
    const refused = await request(app).put("/api/contractor/service-area").set("Cookie", own).send({ coreLocation: waPin, radiusKm: 30, postcodes: ["2042"] });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "Your service area must be in NSW. Contact the office.", field: "coreLocation" });
    const mike = await signIn(app, "mike@idelta.com.au");
    const byMike = await request(app).put("/api/contractors/CON-037/service-area").set("Cookie", mike).send({ coreLocation: waPin, radiusKm: 30, postcodes: ["2042"] });
    expect(byMike.body).toMatchObject({ error: "Liam's service area must be in NSW. Change Liam's Operating state first.", field: "coreLocation" });
    const after = await db.contractor.findUniqueOrThrow({ where: { code: "CON-037" }, include: { servedPostcodes: true } });
    expect(after.coreLocation).toMatchObject({ suburb: "Newtown", state: "NSW" });
    expect(after.servedPostcodes.map((p) => p.postcode)).toEqual(["2042"]);
  });

  test("AC9: a radius across the border leaves the other state's postcodes out, with no error", async () => {
    await db.suburb.createMany({
      data: [
        { name: "Nearside", slug: "nearside-qq-9001", postcode: "9001", state: "QQ", centroidLat: -30.0, centroidLng: 150.0 },
        { name: "Farside", slug: "farside-rr-9002", postcode: "9002", state: "RR", centroidLat: -30.05, centroidLng: 150.0 },
      ],
    });
    const mike = await signIn(app, "mike@idelta.com.au");
    const all = await request(app).get("/api/suburbs/in-range?lat=-30&lng=150&km=15").set("Cookie", mike);
    expect((all.body as { postcode: string }[]).map((r) => r.postcode).sort()).toEqual(["9001", "9002"]);
    const only = await request(app).get("/api/suburbs/in-range?lat=-30&lng=150&km=15&state=QQ").set("Cookie", mike);
    expect(only.status).toBe(200);
    expect((only.body as { postcode: string }[]).map((r) => r.postcode)).toEqual(["9001"]);
    await db.suburb.deleteMany({ where: { state: { in: ["QQ", "RR"] } } });
  });

  test("AC10: Mike moves Bob to NSW - Bob is Not ready with 'Service area outside NSW' and JOB-1042 stays booked; moving back clears it", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = (await request(app).get("/api/contractors/CON-014").set("Cookie", mike)).body as Record<string, unknown>;
    expect(bob["ready"]).toBe(true);
    const jobBefore = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    const moved = await request(app).put("/api/contractors/CON-014").set("Cookie", mike).send({ ...bob, operatingState: "NSW" });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ ready: false, operatingState: "NSW" });
    expect((moved.body as { missing: string[] }).missing).toContain("Service area outside NSW");
    const jobAfter = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    expect(jobAfter.status).toBe(jobBefore.status);
    const back = await request(app).put("/api/contractors/CON-014").set("Cookie", mike).send({ ...bob, operatingState: "WA" });
    expect(back.body).toMatchObject({ ready: true });
  });
});

describe("AC11 -- the missing holidays check covers open states", () => {
  test("AC11: NSW open with this year's 7 and none for next year raises NSW 2028 on a Monday after 1 October; a closed VIC raises nothing", async () => {
    await db.publicHoliday.deleteMany();
    await addHolidays("WA", 7, 2027);
    await addHolidays("NSW", 7, 2027);
    const gaps = await missingHolidays(db, "2027-10-04");
    expect(gaps.map((g) => `${g.state} ${String(g.year)}`)).toEqual(["NSW 2028", "WA 2028"]);
    await runPublicHolidaysMissing(db, { today: "2027-10-04" });
    const keys = (await db.notification.findMany({ where: { type: "public_holidays_missing" } })).map((n) => n.idempotencyKey).sort();
    expect(keys).toEqual(["public_holidays_missing:NSW:2028:2027-10-04", "public_holidays_missing:WA:2028:2027-10-04"]);
    await db.operatingState.update({ where: { state: "NSW" }, data: { open: false } });
    expect((await missingHolidays(db, "2027-10-04")).map((g) => g.state)).toEqual(["WA"]);
  });
});

describe("AC12 -- Liam and the seeds", () => {
  test("AC12: Liam is CON-037 in NSW, Plumbing at Bob's rates, core location Newtown, and logs in", async () => {
    const liam = await db.contractor.findUniqueOrThrow({ where: { code: "CON-037" }, include: { specialties: true } });
    expect(liam).toMatchObject({ name: "Liam Walsh", operatingState: "NSW", status: "active" });
    expect(liam.coreLocation).toMatchObject({ suburb: "Newtown", postcode: "2042" });
    expect(liam.specialties).toMatchObject([{ trade: "Plumbing", contractorCalloutRate: 20_000, contractorStandardRate: 15_000 }]);
    const cookie = await signIn(app, "liam@idelta.com.au");
    expect(cookie).toContain("better-auth.session_token");
  });

  test("AC12: the base seed alone (what production runs) opens WA only; running it again keeps the owner's ticks", async () => {
    await db.operatingState.deleteMany();
    await seedBase(db);
    expect((await db.operatingState.findMany({ where: { open: true } })).map((r) => r.state)).toEqual(["WA"]);
    expect(await db.operatingState.count()).toBe(8);
    await db.operatingState.update({ where: { state: "NSW" }, data: { open: true } });
    await seedBase(db);
    expect((await db.operatingState.findUniqueOrThrow({ where: { state: "NSW" } })).open).toBe(true);
  });
});
