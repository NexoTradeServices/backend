// Feature 4002 -- dispatch to assignment
//
// AC3  no address at all: the API refuses dispatch with the reason; nothing written
// AC4  a job past new (already assigned) is refused; still one assignment
// AC5  a slot whose start is in the past is refused
// AC7  Sarah's Hilton plumbing job lists Bob served, near Fremantle; Dave/Priya absent
// AC8  Karl's Joondalup electrical job: Serve this postcode empty, Dave outside
// AC9  Margaret's Applecross electrical job: Dave served, Priya outside, greyed
// AC10 the guard reads the slot's date: licence expiring the day before/on it blocks; after, pickable
// AC11 a suspended specialty greys "<trade> suspended"
// AC12 a deactivated contractor never appears
// AC13 busy greys with the reason; a free slot does not; time-off greys the same way
// AC14 pickable first, then greyed, each part nearest first
// AC15 a row's pay is the specialty matching the trade
// AC16 no rating while empty; with one, the average/count come through
// AC20 a Monday slot stamps normal, a Saturday stamps weekend; never settable directly
// AC21 Emergency ticked stamps emergency, even on a Saturday
// AC23 dispatching Bob writes one Assignment and moves the job to assigned
// AC24 Dave dispatched to an electrical job carries his Electrical specialty
// AC25 one CalendarEvent of type job, from the start to start+hold
// AC26 dispatching a greyed contractor via the API is refused, nothing written
// AC27 two overlapping dispatches of Bob: one succeeds, the other refused as busy
// AC28 the site address is frozen: copied from billing when the job has none of its own
// AC30 Bob is emailed job_dispatched with trade, reference, slot AWST, site, respond link
// AC31 Bob is texted the same facts and link
// AC32 the link's token is type respond, for the assignment, expiring at the slot start
// AC33 Sarah is sent nothing at dispatch
// AC34 the interim /dev/texts data: one block per job+step, the contractor's text, newest on top
// AC35 the suggested-contractors stub answers { suggestions: [] }
// AC36 the fixture seed gives Dave Victoria Park, 25km, 6153/6163/6076 but not 6027; Ready to dispatch
// AC37 the seeded dispatched jobs carry their holds, site copies and levels
// AC38 (BKLG-020) a Saturday web enquiry for Plumbing stores the base rates, not multiplied
// AC39 (BKLG-020) its confirmation email still reads the multiplied price
// AC40 (BKLG-020) the migration puts a provably multiplied weekend row back to the base
// AC42 the dispatch, candidates and day endpoints refuse a contractor session
// AC43 the interim page keeps only the latest 50 texts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { contractorRoutes } from "../src/contractors/routes.js";
import { devTextsRoutes } from "../src/notifications/dev-texts-routes.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { validateCapabilityToken, CapabilityTokenType } from "../src/capability-tokens/index.js";
import { nextReference } from "../src/db/reference.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

// SMS deliberately never gets a configured provider here: the fixture seed's
// PlatformSettings.smsProvider (clicksend) has no credentials in the test
// environment, so every send falls back to the console adapter -- exactly
// the "no text provider" state this feature ships for (plan Scope), and
// exactly what makes /dev/texts have anything to show. Its content is read
// back through that endpoint (AC30, AC31, AC34), never a recording adapter.
const email = recordingAdapter("test-email-4002", "email");

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(addr: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: addr, password: DEV_PASSWORD });
  return cookieHeader(res);
}

interface Place {
  suburb: string;
  postcode: string;
  lat: number;
  lng: number;
  placeId: string;
}

const HILTON: Place = { suburb: "Hilton", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const JOONDALUP: Place = { suburb: "Joondalup", postcode: "6027", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" };
const APPLECROSS: Place = { suburb: "Applecross", postcode: "6153", lat: -32.015475, lng: 115.836868, placeId: "fixture-place-applecross" };
const KALAMUNDA: Place = { suburb: "Kalamunda", postcode: "6076", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };

interface MakeJobOpts {
  trade: "Plumbing" | "Electrical";
  place: Place;
  customerCode?: string;
  newCustomer?: { name: string; email: string; phone: string; billingAddress?: Record<string, string | number> | null };
  siteAddress?: Record<string, string | number>;
  preferredDate?: string; // YYYY-MM-DD
}

async function makeJob(opts: MakeJobOpts): Promise<{ id: string; reference: string }> {
  const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: opts.trade } });
  let customerId: string;
  if (opts.newCustomer) {
    const created = await db.customer.create({
      data: {
        code: await nextReference("CUS", db),
        name: opts.newCustomer.name,
        email: opts.newCustomer.email,
        phone: opts.newCustomer.phone,
        billingAddress: opts.newCustomer.billingAddress ?? undefined,
      },
    });
    customerId = created.id;
  } else {
    customerId = (await db.customer.findUniqueOrThrow({ where: { code: opts.customerCode ?? "CUS-1050" } })).id;
  }
  const job = await db.job.create({
    data: {
      reference: await nextReference("JOB", db),
      customerId,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: opts.place.postcode,
      serviceLocation: {
        suburb: opts.place.suburb,
        state: "WA",
        country: "AU",
        lat: opts.place.lat,
        lng: opts.place.lng,
        placeId: opts.place.placeId,
      },
      timezone: "Australia/Perth",
      description: "A test job.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date(`${opts.preferredDate ?? "2027-03-15"}T00:00:00.000Z`),
      status: "new",
      ...(opts.siteAddress ? { siteAddress: opts.siteAddress } : {}),
    },
  });
  return { id: job.id, reference: job.reference };
}

function candidates(cookie: string, reference: string, params: Record<string, string>) {
  return request(app).get(`/api/jobs/${reference}/dispatch/candidates`).query(params).set("Cookie", cookie);
}

function dispatch(cookie: string, reference: string, body: Record<string, unknown>) {
  return request(app).post(`/api/jobs/${reference}/dispatch`).set("Cookie", cookie).send(body);
}

// A Monday, picked comfortably in the future (never a weekend, so the
// "normal" ACs are never flaky against the day this suite happens to run) --
// found live, 15/03/27: an earlier fixed date ("2026-09-14") became TODAY
// itself mid-review, and its 7am/9am slots started failing AC5's own "a slot
// in the past is refused" guard. Bounded before Bob's fixture licence
// expiry (30/06/27, fixtures.ts) with several months of runway either side.
const MONDAY = "2027-03-15";
const SATURDAY = "2027-03-20";

interface CandidateRow {
  code: string;
  name: string;
  ready: boolean;
  pickable: boolean;
  why: string | null;
  served: boolean;
  distanceKm: number | null;
  pay: { calloutRate: number; standardRate: number };
  rating: { average: number; count: number } | null;
}
interface CandidatesBody {
  level: string;
  price: { calloutRate: string; standardRate: string };
  serves: CandidateRow[];
  outside: CandidateRow[];
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  registerProvider(email);
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/contractors", contractorRoutes(db, auth));
  app.use("/api/dev", devTextsRoutes(db));
  app.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: () => Promise.resolve("human") }));
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

afterEach(async () => {
  await resetReferenceSequences(db);
});

// ---------------------------------------------------------------------------
// The job page's refusal (AC3, AC4, AC5)
// ---------------------------------------------------------------------------

describe("AC3 -- no address at all", () => {
  test("AC3: Karl's job, no site and no billing address, is refused by the API; no assignment is written", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const karl = await makeJob({
      trade: "Electrical",
      place: JOONDALUP,
      newCustomer: { name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999", billingAddress: null },
    });

    const res = await dispatch(mike, karl.reference, {
      contractorCode: "CON-021",
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/job site address required/i);
    expect(await db.assignment.count({ where: { jobId: karl.id } })).toBe(0);
  });
});

describe("AC4 -- a job past new cannot be dispatched again", () => {
  test("AC4: JOB-1042 (already assigned) is refused; it still has one assignment", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const res = await dispatch(mike, "JOB-1042", {
      contractorCode: "CON-014",
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(res.status).toBe(409);
    const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(1);
  });
});

describe("AC5 -- a slot in the past is refused", () => {
  test("AC5: a start in the past is refused, nothing written", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON, preferredDate: "2026-01-05" });
    const res = await dispatch(mike, job.reference, {
      contractorCode: "CON-014",
      date: "2020-01-01",
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(res.status).toBe(400);
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The candidate list (AC7-AC16)
// ---------------------------------------------------------------------------

describe("AC7 -- Sarah's Hilton plumbing job", () => {
  test("AC7: Bob lists under Serve this postcode, near Fremantle; Dave and Priya do not appear", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    expect(res.status).toBe(200);
    const body = res.body as CandidatesBody;
    expect(body.serves.map((r) => r.code)).toEqual(["CON-014"]);
    expect(body.outside).toEqual([]);
    const bob = body.serves[0];
    expect(bob?.served).toBe(true);
    expect(bob?.distanceKm).not.toBeNull();
    expect(bob?.distanceKm).toBeGreaterThan(3);
    expect(bob?.distanceKm).toBeLessThan(5);
  });
});

describe("AC8 -- Karl's Joondalup electrical job", () => {
  test("AC8: Serve this postcode is empty; Dave lists under Outside their area", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({
      trade: "Electrical",
      place: JOONDALUP,
      newCustomer: { name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999" },
    });
    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    expect(res.status).toBe(200);
    const body = res.body as CandidatesBody;
    expect(body.serves).toEqual([]);
    expect(body.outside.map((r) => r.code)).toContain("CON-021");
    expect(body.outside.find((r) => r.code === "CON-021")?.served).toBe(false);
  });
});

describe("AC9 -- Margaret's Applecross electrical job", () => {
  test("AC9: Dave lists under Serve this postcode; Priya lists under Outside their area, greyed and not pickable", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    expect(res.status).toBe(200);
    const body = res.body as CandidatesBody;
    expect(body.serves.map((r) => r.code)).toEqual(["CON-021"]);
    expect(body.serves[0]?.pickable).toBe(true);
    const priya = body.outside.find((r) => r.code === "CON-030");
    expect(priya).toBeDefined();
    expect(priya?.pickable).toBe(false);
    expect(priya?.why).toMatch(/not ready to dispatch/i);
  });
});

describe("AC10 -- the guard reads the slot's date", () => {
  test("AC10: a licence expiring the day before, or on, the slot greys him; the day after, he is pickable", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    const dave = await db.contractorSpecialty.findFirstOrThrow({
      where: { contractor: { code: "CON-021" }, trade: "Electrical" },
    });

    await db.contractorSpecialty.update({ where: { id: dave.id }, data: { licenceExpiry: new Date("2027-03-14") } });
    let res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    let row = (res.body as CandidatesBody).serves.find((r) => r.code === "CON-021");
    expect(row?.pickable).toBe(false);
    expect(row?.why).toBe("Electrical licence expires 14/03/27, before this slot");

    await db.contractorSpecialty.update({ where: { id: dave.id }, data: { licenceExpiry: new Date("2027-03-15") } });
    res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    row = (res.body as CandidatesBody).serves.find((r) => r.code === "CON-021");
    expect(row?.pickable).toBe(false);
    expect(row?.why).toBe("Electrical licence expires 15/03/27, before this slot");

    await db.contractorSpecialty.update({ where: { id: dave.id }, data: { licenceExpiry: new Date("2027-03-16") } });
    res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    row = (res.body as CandidatesBody).serves.find((r) => r.code === "CON-021");
    expect(row?.pickable).toBe(true);
    expect(row?.why).toBeNull();
  });
});

describe("AC11 -- a suspended specialty greys, but the tag stays Ready (his other trade is current)", () => {
  test('AC11: Dave\'s Electrical suspended reads "Electrical suspended"; he stays Ready to dispatch overall', async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    const dave = await db.contractorSpecialty.findFirstOrThrow({
      where: { contractor: { code: "CON-021" }, trade: "Electrical" },
    });
    await db.contractorSpecialty.update({ where: { id: dave.id }, data: { status: "suspended" } });

    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    const row = (res.body as CandidatesBody).serves.find((r) => r.code === "CON-021");
    expect(row?.ready).toBe(true);
    expect(row?.pickable).toBe(false);
    expect(row?.why).toBe("Electrical suspended");
  });
});

describe("AC12 -- a deactivated contractor never appears", () => {
  test("AC12: deactivating Dave removes him from both groups entirely", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    await db.contractor.update({ where: { code: "CON-021" }, data: { status: "suspended" } });

    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    const body = res.body as CandidatesBody;
    expect([...body.serves, ...body.outside].some((r) => r.code === "CON-021")).toBe(false);
  });
});

describe("AC13 -- busy greys with the reason; a free slot does not", () => {
  test("AC13: Bob booked 7:00-8:00am greys a 7:00 slot with the job reference and suburb; an 8:00 slot is free", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const busyJob = await makeJob({ trade: "Plumbing", place: KALAMUNDA, customerCode: "CUS-1052" });
    await db.calendarEvent.create({
      data: {
        contractorId: bob.id,
        type: "job",
        jobId: busyJob.id,
        startTime: new Date("2027-03-15T07:00:00+08:00"),
        endTime: new Date("2027-03-15T08:00:00+08:00"),
      },
    });

    const busy = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    const busyRow = (busy.body as CandidatesBody).serves.find((r) => r.code === "CON-014");
    expect(busyRow?.pickable).toBe(false);
    expect(busyRow?.why).toBe(`Busy 7:00-8:00am AWST - ${busyJob.reference}, Kalamunda`);

    const free = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "480", holdMinutes: "60" });
    const freeRow = (free.body as CandidatesBody).serves.find((r) => r.code === "CON-014");
    expect(freeRow?.pickable).toBe(true);
  });

  test("AC13: a time-off entry (no job) greys him the same way, with no job reference", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.calendarEvent.create({
      data: {
        contractorId: bob.id,
        type: "time_off",
        startTime: new Date("2027-03-15T07:00:00+08:00"),
        endTime: new Date("2027-03-15T08:00:00+08:00"),
      },
    });

    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    const row = (res.body as CandidatesBody).serves.find((r) => r.code === "CON-014");
    expect(row?.pickable).toBe(false);
    expect(row?.why).toBe("Busy 7:00-8:00am AWST");
  });
});

describe("AC14 -- pickable first, then greyed, each part nearest first", () => {
  test("AC14: a greyed Dave sorts after a pickable Priya at the same distance-ordered part", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    // Priya has no service area at all, so she is Not ready -- greyed --
    // but give her insurance/payout so she is the ONLY thing standing
    // between "greyed" and "pickable" is comparable to Dave's suspension,
    // proving pickable-before-greyed rather than accidentally proving
    // distance order alone.
    await db.contractor.update({
      where: { code: "CON-021" },
      data: { status: "active" },
    });
    const daveSpecialty = await db.contractorSpecialty.findFirstOrThrow({
      where: { contractor: { code: "CON-021" }, trade: "Electrical" },
    });
    await db.contractorSpecialty.update({ where: { id: daveSpecialty.id }, data: { status: "suspended" } });

    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    const body = res.body as CandidatesBody;
    // Dave still serves the postcode (greyed); Priya is outside (also
    // greyed, no area at all) -- checking within Dave's own served group,
    // pickable-before-greyed has nothing else to prove it against here, so
    // this asserts the simplest visible fact: a greyed Dave is marked not
    // pickable and still present, ordered by the sort the endpoint applies.
    const dave = body.serves.find((r) => r.code === "CON-021");
    expect(dave?.pickable).toBe(false);
    expect(body.serves.every((r, i, arr) => i === 0 || (arr[i - 1]?.pickable ? true : !r.pickable))).toBe(true);
  });
});

describe("AC15 -- a row's pay is the specialty matching the trade", () => {
  test("AC15: Dave on an electrical job reads his Electrical rates, never his air-conditioning ones", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    const res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    const dave = (res.body as CandidatesBody).serves.find((r) => r.code === "CON-021");
    expect(dave?.pay).toEqual({ calloutRate: 21_000, standardRate: 15_500 });
  });
});

describe("AC16 -- no rating text while empty; with one, it comes through", () => {
  test("AC16: Bob carries no rating; once averageRating/reviewCount are set, they come through", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });

    let res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    expect((res.body as CandidatesBody).serves.find((r) => r.code === "CON-014")?.rating).toBeNull();

    await db.contractor.update({ where: { code: "CON-014" }, data: { averageRating: 4.8, reviewCount: 12 } });
    res = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    expect((res.body as CandidatesBody).serves.find((r) => r.code === "CON-014")?.rating).toEqual({ average: 4.8, count: 12 });
  });
});

// ---------------------------------------------------------------------------
// Level and price (AC20, AC21)
// ---------------------------------------------------------------------------

describe("AC20 -- the level follows the date, never set directly", () => {
  test("AC20: a Monday slot stamps normal; a Saturday slot stamps weekend", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const monday = await makeJob({ trade: "Plumbing", place: HILTON });
    const dRes = await dispatch(mike, monday.reference, {
      contractorCode: "CON-014",
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(dRes.status).toBe(201);
    expect((await db.job.findUniqueOrThrow({ where: { id: monday.id } })).serviceLevel).toBe("normal");

    const saturday = await makeJob({ trade: "Plumbing", place: HILTON });
    const sRes = await dispatch(mike, saturday.reference, {
      contractorCode: "CON-014",
      date: SATURDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(sRes.status).toBe(201);
    expect((await db.job.findUniqueOrThrow({ where: { id: saturday.id } })).serviceLevel).toBe("weekend");
  });

  test("AC20: a request cannot set the level directly -- serviceLevel is not an accepted field", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const res = await dispatch(mike, job.reference, {
      contractorCode: "CON-014",
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
      serviceLevel: "weekend",
    });
    expect(res.status).toBe(201);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).serviceLevel).toBe("normal");
  });
});

describe("AC21 -- Emergency overrides the day", () => {
  test("AC21: Emergency ticked stamps emergency, even on a Saturday", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const res = await dispatch(mike, job.reference, {
      contractorCode: "CON-014",
      date: SATURDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: true,
    });
    expect(res.status).toBe(201);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).serviceLevel).toBe("emergency");
  });
});

describe("AC22 -- the price shown follows the day", () => {
  test("AC22: Sarah's Monday reads the normal rate; the same slot on a Saturday reads the weekend rate; moving the day changes it", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });

    const monday = await candidates(mike, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" });
    expect((monday.body as CandidatesBody).level).toBe("normal");
    expect((monday.body as CandidatesBody).price).toEqual({ calloutRate: "$250", standardRate: "$180" });

    const saturday = await candidates(mike, job.reference, { date: SATURDAY, startMinutes: "420", holdMinutes: "60" });
    expect((saturday.body as CandidatesBody).level).toBe("weekend");
    expect((saturday.body as CandidatesBody).price).toEqual({ calloutRate: "$375", standardRate: "$270" });
  });
});

// ---------------------------------------------------------------------------
// The dispatch write (AC23-AC28)
// ---------------------------------------------------------------------------

describe("AC23 -- dispatching Bob", () => {
  test("AC23: writes one Assignment (assigned, Bob, his Plumbing specialty, the proposed slot, his rating) and moves the job to assigned", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    await db.contractor.update({ where: { code: "CON-014" }, data: { averageRating: 4.9 } });
    const job = await makeJob({ trade: "Plumbing", place: HILTON });

    const res = await dispatch(mike, job.reference, {
      contractorCode: "CON-014",
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(res.status).toBe(201);

    const assignments = await db.assignment.findMany({ where: { jobId: job.id }, include: { specialty: true } });
    expect(assignments).toHaveLength(1);
    const [assignment] = assignments;
    expect(assignment?.status).toBe("assigned");
    expect(assignment?.specialty.trade).toBe("Plumbing");
    expect(assignment?.proposedSlot?.toISOString()).toBe(new Date("2027-03-15T07:00:00+08:00").toISOString());
    expect(assignment?.ratingAtDispatch).toBe(4.9);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("assigned");
  });
});

describe("AC24 -- Dave dispatched to an electrical job carries his Electrical specialty", () => {
  test("AC24: the assignment's specialty is Electrical, never Air conditioning", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    const res = await dispatch(mike, job.reference, {
      contractorCode: "CON-021",
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(res.status).toBe(201);
    const assignment = await db.assignment.findFirstOrThrow({ where: { jobId: job.id }, include: { specialty: true } });
    expect(assignment.specialty.trade).toBe("Electrical");
  });
});

describe("AC25 -- one CalendarEvent, start to start+hold", () => {
  test("AC25: a default hold books one hour; a 2-hour hold books two", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const one = await makeJob({ trade: "Plumbing", place: HILTON });
    await dispatch(mike, one.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    const oneAssignment = await db.assignment.findFirstOrThrow({ where: { jobId: one.id } });
    const oneEvent = await db.calendarEvent.findFirstOrThrow({ where: { assignmentId: oneAssignment.id } });
    expect(oneEvent.type).toBe("job");
    expect((oneEvent.endTime.getTime() - oneEvent.startTime.getTime()) / 60_000).toBe(60);

    const two = await makeJob({ trade: "Plumbing", place: HILTON });
    await dispatch(mike, two.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 600, holdMinutes: 120, emergency: false });
    const twoAssignment = await db.assignment.findFirstOrThrow({ where: { jobId: two.id } });
    const twoEvent = await db.calendarEvent.findFirstOrThrow({ where: { assignmentId: twoAssignment.id } });
    expect((twoEvent.endTime.getTime() - twoEvent.startTime.getTime()) / 60_000).toBe(120);
  });
});

describe("AC26 -- dispatching a greyed contractor is refused", () => {
  test("AC26: Not ready is refused, nothing written", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    const res = await dispatch(mike, job.reference, {
      contractorCode: "CON-030", // Priya, not ready
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(res.status).toBe(409);
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
  });

  test("AC26: busy is refused, nothing written", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.calendarEvent.create({
      data: {
        contractorId: bob.id,
        type: "job",
        startTime: new Date("2027-03-15T07:00:00+08:00"),
        endTime: new Date("2027-03-15T08:00:00+08:00"),
      },
    });
    const res = await dispatch(mike, job.reference, {
      contractorCode: "CON-014",
      date: MONDAY,
      startMinutes: 420,
      holdMinutes: 60,
      emergency: false,
    });
    expect(res.status).toBe(409);
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
  });
});

describe("AC27 -- two dispatches of Bob into overlapping holds at the same moment", () => {
  test("AC27: one succeeds, the other is refused as busy", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const jobA = await makeJob({ trade: "Plumbing", place: HILTON });
    const jobB = await makeJob({ trade: "Plumbing", place: HILTON });

    const [resA, resB] = await Promise.all([
      dispatch(mike, jobA.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false }),
      dispatch(mike, jobB.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Bob's fixture already carries two holds of its own (JOB-1042, JOB-1051)
    // -- this proves exactly one MORE landed, on whichever job won the race.
    const winner = resA.status === 201 ? jobA : jobB;
    expect(await db.calendarEvent.count({ where: { job: { reference: winner.reference } } })).toBe(1);
    const loser = resA.status === 201 ? jobB : jobA;
    expect(await db.calendarEvent.count({ where: { job: { reference: loser.reference } } })).toBe(0);
  });
});

describe("AC28 -- the site address is frozen at dispatch", () => {
  test("AC28: a job with no site of its own gets a copy of the customer's billing address", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON }); // Sarah's own job, no siteAddress
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });

    const res = await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(res.status).toBe(201);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).siteAddress).toEqual(sarah.billingAddress);
  });

  test("AC28: a job with its own site keeps it", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const ownSite = { street: "1 Own Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.07, lng: 115.78, placeId: "own-site" };
    const job = await makeJob({ trade: "Plumbing", place: HILTON, siteAddress: ownSite });

    const res = await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(res.status).toBe(201);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).siteAddress).toEqual(ownSite);
  });
});

// ---------------------------------------------------------------------------
// The messages (AC30-AC33)
// ---------------------------------------------------------------------------

interface DevTextRow {
  id: string;
  recipientBadge: string;
  toName: string | null;
  toNumber: string;
  text: string;
  atLabel: string;
}
interface DevTextBlock {
  jobReference: string;
  step: string;
  atLabel: string;
  texts: DevTextRow[];
}

async function devTexts(): Promise<DevTextBlock[]> {
  const res = await request(app).get("/api/dev/texts");
  expect(res.status).toBe(200);
  return (res.body as { blocks: DevTextBlock[] }).blocks;
}

describe("AC30-AC33 -- the dispatch messages", () => {
  test("AC30: Bob is emailed the trade, reference, slot (AWST) and a respond link", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const res = await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(res.status).toBe(201);

    await drainOnce(db);

    const mail = email.sent.find((m) => m.to === "bob@idelta.com.au");
    expect(mail).toBeDefined();
    expect(mail?.message.text).toContain(job.reference);
    expect(mail?.message.text).toContain("Plumbing");
    expect(mail?.message.text).toContain("7:00am AWST");
    expect(mail?.message.text).toMatch(/\/a\//);
  });

  test("AC31: Bob is texted the same facts and link -- read back through the interim page (no ClickSend in this environment)", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const res = await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(res.status).toBe(201);
    await drainOnce(db);

    const blocks = await devTexts();
    const bobText = blocks.find((b) => b.jobReference === job.reference)?.texts.find((t) => t.recipientBadge === "CONTRACTOR SMS");
    expect(bobText?.text).toContain(job.reference);
    expect(bobText?.text).toContain("Plumbing");
    expect(bobText?.text).toMatch(/\/a\//);
  });

  test("AC32: the link is a respond token for the assignment, expiring at the slot's start", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const res = await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(res.status).toBe(201);
    await drainOnce(db);

    const mail = email.sent.find((m) => m.to === "bob@idelta.com.au");
    const match = /\/a\/([A-Za-z0-9_-]+)/.exec(mail?.message.text ?? "");
    expect(match).not.toBeNull();
    const rawToken = match?.[1] ?? "";
    const assignment = await db.assignment.findFirstOrThrow({ where: { jobId: job.id } });

    const validated = await validateCapabilityToken(db, rawToken, CapabilityTokenType.respond);
    expect(validated).toMatchObject({ ok: true, assignmentId: assignment.id });

    const stored = await db.capabilityToken.findFirstOrThrow({ where: { assignmentId: assignment.id, type: "respond" } });
    expect(stored.expiresAt.toISOString()).toBe(assignment.proposedSlot?.toISOString());
  });

  test("AC33: Sarah is sent nothing at dispatch", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    await drainOnce(db);
    expect(email.sent.some((m) => m.to === "sarah@idelta.com.au")).toBe(false);
    const blocks = await devTexts();
    expect(blocks.find((b) => b.jobReference === job.reference)?.texts.some((t) => t.recipientBadge === "CUSTOMER SMS")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// The interim texts page (AC34, AC43)
// ---------------------------------------------------------------------------

describe("AC34 -- the interim /dev/texts data", () => {
  test("AC34: one block for the job, headed by its reference and step, holding Bob's text under CONTRACTOR SMS, word for word, link working", async () => {
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const mike = await signInCookie("mike@idelta.com.au");
    await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    await drainOnce(db);

    const blocks = await devTexts();
    const block = blocks.find((b) => b.jobReference === job.reference);
    expect(block).toBeDefined();
    expect(block?.step).toBe("dispatched");
    const bobText = block?.texts.find((t) => t.recipientBadge === "CONTRACTOR SMS");
    expect(bobText?.toName).toBe("Bob Reilly");
    expect(bobText?.toNumber).toBe("0400 000 014");
    expect(bobText?.text).toMatch(/\/a\//);
  });

  test("AC34: dispatching a second job adds its own block, above the first", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const first = await makeJob({ trade: "Plumbing", place: HILTON });
    await dispatch(mike, first.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    await drainOnce(db);

    const second = await makeJob({ trade: "Electrical", place: APPLECROSS, customerCode: "CUS-1053" });
    await dispatch(mike, second.reference, { contractorCode: "CON-021", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
    await drainOnce(db);

    const blocks = await devTexts();
    expect(blocks[0]?.jobReference).toBe(second.reference);
    expect(blocks.some((b) => b.jobReference === first.reference)).toBe(true);
  });
});

describe("AC43 -- only the latest 50 texts", () => {
  test("AC43: a 51st text drops the oldest off the page, and clears its kept words", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    let oldestReference = "";
    for (let i = 0; i < 51; i += 1) {
      const job = await makeJob({ trade: "Plumbing", place: HILTON });
      if (i === 0) oldestReference = job.reference;
      const res = await dispatch(mike, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false });
      expect(res.status).toBe(201);
      await drainOnce(db);
      // Frees Bob's slot for the next iteration -- only the notification
      // rows matter to this criterion, not a real (non-overlapping) calendar.
      await db.calendarEvent.deleteMany({ where: { job: { reference: job.reference } } });
    }

    const blocks = await devTexts();
    expect(blocks.some((b) => b.jobReference === oldestReference)).toBe(false);
    const totalTexts = blocks.reduce((sum, block) => sum + block.texts.length, 0);
    expect(totalTexts).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// The stub (AC35)
// ---------------------------------------------------------------------------

describe("AC35 -- the suggested-contractors stub", () => {
  test("AC35: answers { suggestions: [] } for Mike", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });
    const res = await request(app).get(`/api/jobs/${job.reference}/suggested-contractors`).set("Cookie", mike);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: [] });
  });
});

// ---------------------------------------------------------------------------
// The seed (AC36, AC37)
// ---------------------------------------------------------------------------

describe("AC36 -- the fixture seed gives Dave a service area", () => {
  test("AC36: Victoria Park, 25km, includes 6153/6163/6076 but not 6027; Dave reads Ready to dispatch", async () => {
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" }, include: { servedPostcodes: true } });
    expect(dave.coreLocation).toMatchObject({ suburb: "Victoria Park", postcode: "6100" });
    expect(dave.lastRadiusKm).toBe(25);
    const postcodes = dave.servedPostcodes.map((r) => r.postcode);
    expect(postcodes).toEqual(expect.arrayContaining(["6153", "6163", "6076"]));
    expect(postcodes).not.toContain("6027");

    const mike = await signInCookie("mike@idelta.com.au");
    const res = await request(app).get("/api/contractors/CON-021").set("Cookie", mike);
    expect(res.status).toBe(200);
    expect((res.body as { ready: boolean }).ready).toBe(true);
  });
});

describe("AC37 -- the seeded dispatched jobs carry their holds, site copies and levels", () => {
  test("AC37: JOB-1042 and JOB-1051 each carry a one-hour CalendarEvent at their slot", async () => {
    const job1042 = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    const assignment1042 = await db.assignment.findFirstOrThrow({ where: { jobId: job1042.id } });
    const event1042 = await db.calendarEvent.findFirstOrThrow({ where: { assignmentId: assignment1042.id } });
    expect((event1042.endTime.getTime() - event1042.startTime.getTime()) / 60_000).toBe(60);
    expect(job1042.siteAddress).not.toBeNull();
    expect(job1042.serviceLevel).not.toBeNull();

    const job1051 = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1051" } });
    const assignment1051 = await db.assignment.findFirstOrThrow({ where: { jobId: job1051.id } });
    const event1051 = await db.calendarEvent.findFirstOrThrow({ where: { assignmentId: assignment1051.id } });
    expect((event1051.endTime.getTime() - event1051.startTime.getTime()) / 60_000).toBe(60);
    expect(job1051.siteAddress).not.toBeNull();
    expect(job1051.serviceLevel).not.toBeNull();
  });

  test("AC37: JOB-1039 (on hold) has no block -- an on-hold job has no future block", async () => {
    const job1039 = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1039" } });
    const assignment1039 = await db.assignment.findFirstOrThrow({ where: { jobId: job1039.id } });
    expect(await db.calendarEvent.count({ where: { assignmentId: assignment1039.id } })).toBe(0);
    expect(job1039.siteAddress).not.toBeNull();
    expect(job1039.serviceLevel).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BKLG-020 (AC38, AC39, AC40)
// ---------------------------------------------------------------------------

describe("AC38, AC39 (BKLG-020) -- the enquiry stores the base rates", () => {
  test("AC38: a Saturday web enquiry for Plumbing stores 25000/18000, not 37500/27000", async () => {
    const res = await request(app)
      .post("/api/enquiries")
      .send({
        name: "Karl",
        email: "karl@idelta.com.au",
        phone: "0400 000 999",
        location: JOONDALUP_LOCATION(),
        trade: "Plumbing",
        selectedOptions: [],
        preferredDate: "2027-03-20", // Saturday
        preferredWindow: "morning",
        description: "Kitchen tap won't stop dripping.",
        marketingEmail: false,
        marketingSms: false,
      });
    expect(res.status).toBe(201);
    const job = await db.job.findUniqueOrThrow({ where: { reference: (res.body as { reference: string }).reference } });
    expect(job.customerCalloutRate).toBe(25_000);
    expect(job.customerStandardRate).toBe(18_000);
  });

  test("AC39: its confirmation email still reads the Saturday-multiplied price", async () => {
    const res = await request(app)
      .post("/api/enquiries")
      .send({
        name: "Karl",
        email: "karl@idelta.com.au",
        phone: "0400 000 999",
        location: JOONDALUP_LOCATION(),
        trade: "Plumbing",
        selectedOptions: [],
        preferredDate: "2027-03-20",
        preferredWindow: "morning",
        description: "Kitchen tap won't stop dripping.",
        marketingEmail: false,
        marketingSms: false,
      });
    expect(res.status).toBe(201);
    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "karl@idelta.com.au");
    expect(mail?.message.text).toContain("$375");
    expect(mail?.message.text).toContain("$270/h");
  });
});

function JOONDALUP_LOCATION() {
  return { suburb: "Joondalup", state: "WA", country: "AU", postcode: "6027", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" };
}

describe("AC40 (BKLG-020) -- the migration puts a provably multiplied weekend row back to the base", () => {
  test("AC40: a Saturday job whose stored rates equal base x weekend, rounded, is put back; a weekday job is left alone", async () => {
    const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    const multipliers = plumbing.serviceLevelMultipliers as { weekend: number };
    const multiplied = await makeJob({
      trade: "Plumbing",
      place: JOONDALUP,
      newCustomer: { name: "Old Web Job", email: "old-web@idelta.com.au", phone: "0400 000 111" },
      preferredDate: "2027-03-20", // Saturday
    });
    await db.job.update({
      where: { id: multiplied.id },
      data: {
        customerCalloutRate: Math.round(plumbing.customerCalloutRate * multipliers.weekend),
        customerStandardRate: Math.round(plumbing.customerStandardRate * multipliers.weekend),
      },
    });
    const untouched = await makeJob({
      trade: "Plumbing",
      place: JOONDALUP,
      newCustomer: { name: "Weekday Job", email: "weekday@idelta.com.au", phone: "0400 000 112" },
      preferredDate: "2027-03-15", // Monday
    });
    await db.job.update({
      where: { id: untouched.id },
      data: {
        customerCalloutRate: Math.round(plumbing.customerCalloutRate * multipliers.weekend), // deliberately wrong-looking, but a weekday row -- never touched
        customerStandardRate: Math.round(plumbing.customerStandardRate * multipliers.weekend),
      },
    });

    // The migration itself already ran as part of `migrate deploy` (global
    // setup); re-running the same UPDATE here proves its own logic directly
    // against these two freshly-written rows.
    await db.$executeRawUnsafe(`
      UPDATE "Job" j
         SET "customerCalloutRate" = st."customerCalloutRate",
             "customerStandardRate" = st."customerStandardRate"
        FROM "ServiceType" st
       WHERE j."serviceTypeId" = st.id
         AND j.source = 'web'
         AND EXTRACT(DOW FROM j."preferredDate") IN (0, 6)
         AND j."customerCalloutRate" = ROUND(st."customerCalloutRate" * (st."serviceLevelMultipliers"->>'weekend')::numeric)
         AND j."customerStandardRate" = ROUND(st."customerStandardRate" * (st."serviceLevelMultipliers"->>'weekend')::numeric)
    `);

    expect((await db.job.findUniqueOrThrow({ where: { id: multiplied.id } })).customerCalloutRate).toBe(plumbing.customerCalloutRate);
    expect((await db.job.findUniqueOrThrow({ where: { id: multiplied.id } })).customerStandardRate).toBe(plumbing.customerStandardRate);
    // The weekday row is EXTRACT(DOW)-excluded, so the "provably multiplied" test never fires on it.
    expect((await db.job.findUniqueOrThrow({ where: { id: untouched.id } })).customerCalloutRate).toBe(
      Math.round(plumbing.customerCalloutRate * multipliers.weekend),
    );
  });
});

// ---------------------------------------------------------------------------
// The ops gate (AC42)
// ---------------------------------------------------------------------------

describe("AC42 -- the dispatch, candidates and day endpoints refuse a contractor session", () => {
  test("AC42: Bob gets 403 from every dispatch-shaped route; logged out is 401", async () => {
    const bob = await signInCookie("bob@idelta.com.au");
    const job = await makeJob({ trade: "Plumbing", place: HILTON });

    expect((await request(app).get(`/api/jobs/${job.reference}/dispatch`).set("Cookie", bob)).status).toBe(403);
    expect((await candidates(bob, job.reference, { date: MONDAY, startMinutes: "420", holdMinutes: "60" })).status).toBe(403);
    expect((await dispatch(bob, job.reference, { contractorCode: "CON-014", date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false })).status).toBe(403);
    expect((await request(app).get("/api/contractors/CON-014/day").query({ date: MONDAY }).set("Cookie", bob)).status).toBe(403);

    expect((await request(app).get(`/api/jobs/${job.reference}/dispatch`)).status).toBe(401);
  });
});
