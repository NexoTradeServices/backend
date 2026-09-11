// Feature 4001 -- ops job queue and job detail
//
// AC2  All open lists the seed's three live jobs and a fresh enquiry; closed ones are absent
// AC3  status order new -> assigned -> scheduled -> in progress -> on hold; older new on top
// AC4  within a status the soonest slot first; no slot last
// AC5  each chip shows its own status and its count; Closed = completed + cancelled, newest change first
// AC6  search spans every status whatever the chip; code, phone (either spacing), reference; no match
// AC8  a row's facts, times labelled AWST, JOB-1042 with Bob and where he stands
// AC9  a new job's waiting time, and its missing site address
// AC10 51 open jobs: 50, then the 51st
// AC11 the job page's request, answers as saved, none answered
// AC12 JOB-1042's active assignment; a new job is not dispatched
// AC13 Karl's first call: billing picked, ticked, saved -> site equals billing
// AC14 Margaret's billing changed from a new job shows on JOB-1039 too
// AC15 a different site stays on the job only
// AC16 the street wins on a new job: postcode + serviceLocation move, timezone never
// AC17 a dispatched job's site is locked: refused, nothing written
// AC18 only a structured pick is ever stored
// AC19 a Dispute note: server-stamped id / at / operatorId, newest first, "Mike"
// AC20 the four hand types only; correction and anything else refused
// AC21 the author edits inside 10 minutes; unchanged text stamps nothing
// AC22 after 10 minutes the edit is refused and no Edit is offered
// AC23 the owner cannot edit Mike's note
// AC24 the new-job-request email carries <web origin>/ops/jobs/<reference>
// AC26 (BKLG-023) a fresh base seed gives Plumbing the six questions
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
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { nextReference } from "../src/db/reference.js";
import { formatDateLabel, formatDateTimeLabel, formatPlainDate } from "../src/time/index.js";
import type { AssignmentStatus, JobStatus } from "../src/generated/prisma/enums.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-4001", "email");

// ---------------------------------------------------------------------------
// Shapes the API returns
// ---------------------------------------------------------------------------

interface ContractorView {
  name: string;
  code: string;
  standing: string;
}

interface QueueRow {
  reference: string;
  status: JobStatus;
  source: string;
  customerName: string;
  customerCode: string;
  trade: string;
  suburb: string;
  postcode: string;
  wantedDate: string;
  windowLabel: string;
  receivedLabel: string;
  waiting: string | null;
  noSiteAddress: boolean;
  closedLabel: string | null;
  contractor: ContractorView | null;
}

interface QueueBody {
  rows: QueueRow[];
  total: number;
  hasMore: boolean;
  counts: Record<string, number>;
  updatedLabel: string;
}

interface NoteView {
  id: string | null;
  type: string;
  note: string;
  atLabel: string;
  authorName: string;
  edited: boolean;
  editableForSeconds: number;
}

interface DetailBody {
  reference: string;
  status: JobStatus;
  source: string;
  trade: string;
  suburb: string;
  postcode: string;
  wantedDate: string;
  windowLabel: string;
  receivedLabel: string;
  description: string | null;
  answers: string[];
  customer: { code: string; name: string; phone: string | null; email: string; billingAddress: unknown };
  siteAddress: unknown;
  siteSameAsBilling: boolean;
  siteLocked: boolean;
  contractor: ContractorView | null;
  notes: NoteView[];
}

// ---------------------------------------------------------------------------
// Places picks and places -- Perth, told with the cast's suburbs
// ---------------------------------------------------------------------------

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

function pick(street: string, suburb: string, state: string, postcode: string, lat: number, lng: number) {
  return {
    street,
    suburb,
    state,
    country: "AU",
    postcode,
    lat,
    lng,
    placeId: `test-place-${street.toLowerCase().replace(/\s+/g, "-")}`,
  };
}

const KARL_HOME = pick("18 Lakeside Drive", "Joondalup", "WA", "6027", -31.7446, 115.7686);
const FREMANTLE_SITE = pick("14 Marine Terrace", "Fremantle", "WA", "6160", -32.0569, 115.7439);
const MARGARET_NEW_HOME = pick("9 Ardross Street", "Ardross", "WA", "6153", -32.0226, 115.8356);
const SARAH_RENTAL = pick("3 Rennie Crescent", "Hilton", "WA", "6163", -32.0712, 115.7811);
const ADELAIDE_SITE = pick("1 King William Street", "Adelaide", "SA", "5000", -34.9285, 138.6007);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  return cookieHeader(res);
}

async function queue(cookie: string, params: Record<string, string> = {}): Promise<QueueBody> {
  const res = await request(app).get("/api/jobs").query(params).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as QueueBody;
}

async function detail(cookie: string, reference: string): Promise<DetailBody> {
  const res = await request(app).get(`/api/jobs/${reference}`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as DetailBody;
}

function saveAddresses(cookie: string, reference: string, body: unknown) {
  return request(app).put(`/api/jobs/${reference}/addresses`).set("Cookie", cookie).send(body as object);
}

function addNote(cookie: string, reference: string, body: unknown) {
  return request(app).post(`/api/jobs/${reference}/notes`).set("Cookie", cookie).send(body as object);
}

function editNote(cookie: string, reference: string, noteId: string, note: string) {
  return request(app).put(`/api/jobs/${reference}/notes/${noteId}`).set("Cookie", cookie).send({ note });
}

interface MakeJob {
  customerCode?: string;
  newCustomer?: { name: string; email: string; phone: string };
  status?: JobStatus;
  place?: Place;
  createdAt?: Date;
  source?: "web" | "phone";
  description?: string;
  selectedOptions?: string[];
  siteAddress?: Record<string, string | number>;
  cancelledAt?: Date;
  assignment?: {
    status: AssignmentStatus;
    proposedSlot?: Date | null;
    confirmedSlot?: Date | null;
    completedAt?: Date | null;
  };
}

/** A test's own job, on top of the seeded cast. The test database is wiped per test. */
async function makeJob(opts: MakeJob = {}): Promise<{ id: string; reference: string }> {
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const customerId = opts.newCustomer
    ? (await db.customer.create({ data: { code: await nextReference("CUS", db), ...opts.newCustomer } })).id
    : (await db.customer.findUniqueOrThrow({ where: { code: opts.customerCode ?? "CUS-1050" } })).id;
  const place = opts.place ?? HILTON;
  const job = await db.job.create({
    data: {
      reference: await nextReference("JOB", db),
      customerId,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: place.postcode,
      serviceLocation: {
        suburb: place.suburb,
        state: "WA",
        country: "AU",
        lat: place.lat,
        lng: place.lng,
        placeId: place.placeId,
      },
      timezone: "Australia/Perth",
      description: opts.description ?? "Kitchen mixer tap is leaking from the base.",
      selectedOptions: opts.selectedOptions ?? [],
      source: opts.source ?? "web",
      preferredWindow: "morning",
      preferredDate: new Date("2026-09-17T00:00:00.000Z"),
      status: opts.status ?? "new",
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.siteAddress ? { siteAddress: opts.siteAddress } : {}),
      ...(opts.cancelledAt ? { cancelledAt: opts.cancelledAt } : {}),
    },
  });
  if (opts.assignment) {
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
    if (!specialty) throw new Error("Bob has no Plumbing specialty in the fixture seed");
    await db.assignment.create({
      data: {
        jobId: job.id,
        contractorId: bob.id,
        specialtyId: specialty.id,
        status: opts.assignment.status,
        proposedSlot: opts.assignment.proposedSlot ?? null,
        confirmedSlot: opts.assignment.confirmedSlot ?? null,
        completedAt: opts.assignment.completedAt ?? null,
      },
    });
  }
  return { id: job.id, reference: job.reference };
}

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
const daysFromNow = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60_000);

async function storedNotes(reference: string): Promise<Record<string, string>[]> {
  const job = await db.job.findUniqueOrThrow({ where: { reference } });
  return (job.operatorNotes ?? []) as Record<string, string>[];
}

async function mikeId(): Promise<string> {
  return (await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } })).id;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
  email.reset();
});

// The JOB and CUS sequences are shared with every later test file (truncate
// never touches them), and this file mints dozens -- put them back so a file
// that expects the next free reference still gets it.
afterEach(async () => {
  await resetReferenceSequences(db);
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

describe("AC2 -- open work only", () => {
  test("AC2: All open lists JOB-1042, JOB-1051, JOB-1039 and a fresh web enquiry; a completed and a cancelled job are absent", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const fresh = await makeJob({ newCustomer: { name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999" }, place: JOONDALUP });
    const completed = await makeJob({ customerCode: "CUS-1052", status: "completed", place: KALAMUNDA });
    const cancelled = await makeJob({ customerCode: "CUS-1050", status: "cancelled", cancelledAt: new Date() });

    const body = await queue(mike);
    const byRef = new Map(body.rows.map((row) => [row.reference, row.status]));
    expect(byRef.get("JOB-1042")).toBe("assigned");
    expect(byRef.get("JOB-1051")).toBe("scheduled");
    expect(byRef.get("JOB-1039")).toBe("on_hold");
    expect(byRef.get(fresh.reference)).toBe("new");
    expect(byRef.has(completed.reference)).toBe(false);
    expect(byRef.has(cancelled.reference)).toBe(false);
    expect(body.total).toBe(4);
  });

  test("AC2: the queue is ops work -- the owner sees it; a contractor is refused; logged out is refused", async () => {
    const owner = await signInCookie("owner@idelta.com.au");
    expect((await queue(owner)).total).toBe(3);

    const bob = await signInCookie("bob@idelta.com.au");
    expect((await request(app).get("/api/jobs").set("Cookie", bob)).status).toBe(403);
    expect((await request(app).get("/api/jobs/JOB-1042").set("Cookie", bob)).status).toBe(403);
    expect((await request(app).get("/api/jobs")).status).toBe(401);
  });
});

describe("AC3 -- the order by status, then the longest-waiting new job on top", () => {
  test("AC3: new, then assigned, scheduled, in progress, on hold -- of two new jobs the earlier received is on top", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const later = await makeJob({ createdAt: minutesAgo(60) });
    const earlier = await makeJob({ createdAt: minutesAgo(120) });
    await makeJob({
      customerCode: "CUS-1052",
      status: "in_progress",
      place: KALAMUNDA,
      assignment: { status: "in_progress", confirmedSlot: minutesAgo(30) },
    });

    const body = await queue(mike);
    expect(body.rows.map((row) => row.status)).toEqual(["new", "new", "assigned", "scheduled", "in_progress", "on_hold"]);
    expect(body.rows[0]?.reference).toBe(earlier.reference);
    expect(body.rows[1]?.reference).toBe(later.reference);
  });
});

describe("AC4 -- within a status, the soonest slot first", () => {
  test("AC4: of two scheduled jobs for Bob the earlier slot is on top; a scheduled job with no slot sits last", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const inThreeDays = await makeJob({
      status: "scheduled",
      assignment: { status: "accepted", proposedSlot: daysFromNow(3), confirmedSlot: daysFromNow(3) },
    });
    const inTwoDays = await makeJob({
      status: "scheduled",
      assignment: { status: "accepted", proposedSlot: daysFromNow(2), confirmedSlot: daysFromNow(2) },
    });
    const noSlot = await makeJob({ status: "scheduled", createdAt: minutesAgo(500) });

    const body = await queue(mike, { status: "scheduled" });
    // JOB-1051 is the seed's own: accepted for today 1:00pm, sooner than both.
    expect(body.rows.map((row) => row.reference)).toEqual([
      "JOB-1051",
      inTwoDays.reference,
      inThreeDays.reference,
      noSlot.reference,
    ]);
  });
});

describe("AC5 -- the status chips", () => {
  test("AC5: each chip shows only its own status and its count matches its rows", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    await makeJob();
    await makeJob();
    await makeJob({ status: "in_progress", assignment: { status: "in_progress", confirmedSlot: minutesAgo(10) } });

    const all = await queue(mike);
    expect(all.counts["open"]).toBe(all.total);
    for (const status of ["new", "assigned", "scheduled", "in_progress", "on_hold"] as const) {
      const body = await queue(mike, { status });
      expect(body.rows.length).toBeGreaterThan(0);
      expect(body.rows.every((row) => row.status === status)).toBe(true);
      expect(body.counts[status]).toBe(body.rows.length);
      expect(body.total).toBe(body.rows.length);
    }
  });

  test("AC5: Closed shows the completed and the cancelled job, the more recently changed first", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const completed = await makeJob({ customerCode: "CUS-1052", status: "completed", place: KALAMUNDA });
    const cancelled = await makeJob({ status: "cancelled", cancelledAt: minutesAgo(200) });
    await db.job.update({ where: { id: cancelled.id }, data: { updatedAt: minutesAgo(200) } });
    await db.job.update({ where: { id: completed.id }, data: { updatedAt: minutesAgo(20) } });

    const body = await queue(mike, { status: "closed" });
    expect(body.rows.map((row) => row.reference)).toEqual([completed.reference, cancelled.reference]);
    expect(body.counts["closed"]).toBe(2);
    expect(body.rows[0]?.closedLabel).toMatch(/^Completed [A-Z][a-z]{2} \d{2}\/\d{2}\/\d{2}$/);
    expect(body.rows[1]?.closedLabel).toMatch(/^Cancelled [A-Z][a-z]{2} \d{2}\/\d{2}\/\d{2}$/);

    // The order is by recency, not by status: touch the cancelled job last and it leads.
    await db.job.update({ where: { id: cancelled.id }, data: { updatedAt: minutesAgo(1) } });
    const again = await queue(mike, { status: "closed" });
    expect(again.rows.map((row) => row.reference)).toEqual([cancelled.reference, completed.reference]);
  });
});

describe("AC6 -- search spans every status, whatever chip is chosen", () => {
  test("AC6: CUS-1052 finds Tom's completed job; both phone spellings find Tom; JOB-1042 finds Sarah's; no match is empty", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const tomsOld = await makeJob({ customerCode: "CUS-1052", status: "completed", place: KALAMUNDA });

    // The New chip is chosen; search ignores it.
    const byCode = await queue(mike, { status: "new", q: "CUS-1052" });
    expect(byCode.rows.map((row) => row.reference).sort()).toEqual(["JOB-1051", tomsOld.reference].sort());
    expect(byCode.rows.find((row) => row.reference === tomsOld.reference)?.status).toBe("completed");

    for (const phone of ["0400 001 052", "0400001052"]) {
      const byPhone = await queue(mike, { status: "new", q: phone });
      expect(byPhone.rows.every((row) => row.customerName === "Tom")).toBe(true);
      expect(byPhone.rows.map((row) => row.reference).sort()).toEqual(["JOB-1051", tomsOld.reference].sort());
    }

    const byReference = await queue(mike, { q: "job-1042" });
    expect(byReference.rows.map((row) => row.reference)).toEqual(["JOB-1042"]);
    expect(byReference.rows[0]?.customerName).toBe("Sarah Chen");

    const byName = await queue(mike, { status: "closed", q: "sarah" });
    expect(byName.rows.map((row) => row.reference)).toContain("JOB-1042");

    const none = await queue(mike, { q: "no such job anywhere" });
    expect(none.rows).toEqual([]);
    expect(none.total).toBe(0);
  });

  test("AC6: a search term is taken literally -- % and _ match nothing special", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await queue(mike, { q: "%" })).total).toBe(0);
    expect((await queue(mike, { q: "_" })).total).toBe(0);
  });
});

describe("AC8 -- what a row carries", () => {
  test("AC8: JOB-1042's row -- reference, tag, Sarah and her CUS code, trade, suburb and postcode, wanted date and window, received AWST, Web, Bob and where he stands", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const body = await queue(mike);
    const row = body.rows.find((r) => r.reference === "JOB-1042");
    const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    expect(row).toMatchObject({
      reference: "JOB-1042",
      status: "assigned",
      customerName: "Sarah Chen",
      customerCode: "CUS-1050",
      trade: "Plumbing",
      suburb: "Hilton",
      postcode: "6163",
      wantedDate: formatPlainDate(job.preferredDate),
      windowLabel: "morning 7:00-12:00",
      source: "web",
    });
    expect(row?.receivedLabel).toMatch(/^(Today|[A-Z][a-z]{2} \d{2}\/\d{2}\/\d{2}), \d{1,2}:\d{2}(am|pm) AWST$/);
    expect(row?.contractor?.name).toBe("Bob Reilly");
    expect(row?.contractor?.code).toBe("CON-014");
    expect(row?.contractor?.standing).toMatch(/^Waiting for Bob's answer - proposed [A-Z][a-z]{2} \d{2}\/\d{2}, 8:00am AWST$/);

    expect(body.rows.find((r) => r.reference === "JOB-1051")?.contractor?.standing).toBe("Booked - Today, 1:00pm AWST");
    expect(body.rows.find((r) => r.reference === "JOB-1039")?.contractor?.standing).toBe("On hold - no return date yet");
    expect(body.updatedLabel).toMatch(/^\d{1,2}:\d{2}(am|pm) AWST$/);
  });

  test("AC8: a phone-taken job says Phone", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const phoned = await makeJob({ source: "phone" });
    const row = (await queue(mike)).rows.find((r) => r.reference === phoned.reference);
    expect(row?.source).toBe("phone");
  });

  test("AC8: times render in the given zone and are labelled -- today, another day with its year, and a plain date read as stored", () => {
    const now = new Date("2026-09-10T02:42:00.000Z"); // 10:42am in Perth
    expect(formatDateTimeLabel("Australia/Perth", new Date("2026-09-10T01:14:00.000Z"), now)).toBe("Today, 9:14am AWST");
    expect(formatDateTimeLabel("Australia/Perth", new Date("2026-09-08T07:20:00.000Z"), now)).toBe("Tue 08/09/26, 3:20pm AWST");
    // 11pm UTC on the 9th is already the 10th in Perth.
    expect(formatDateLabel("Australia/Perth", new Date("2026-09-09T23:00:00.000Z"))).toBe("Thu 10/09/26");
    expect(formatPlainDate(new Date("2026-09-11T00:00:00.000Z"))).toBe("Fri 11/09/26");
  });
});

describe("AC9 -- a new job's row says how long it has waited, and when the call is still owed", () => {
  test("AC9: a new job waiting 90 minutes shows 1h 30m and no site address; one with a site says nothing of it", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const waiting = await makeJob({ createdAt: new Date(Date.now() - 90 * 60_000 - 5_000) });
    const called = await makeJob({ siteAddress: SARAH_RENTAL });

    const rows = (await queue(mike)).rows;
    const waitingRow = rows.find((r) => r.reference === waiting.reference);
    expect(waitingRow?.waiting).toBe("1h 30m");
    expect(waitingRow?.noSiteAddress).toBe(true);
    expect(rows.find((r) => r.reference === called.reference)?.noSiteAddress).toBe(false);

    const dispatched = rows.find((r) => r.reference === "JOB-1042");
    expect(dispatched?.waiting).toBeNull();
    expect(dispatched?.noSiteAddress).toBe(false);
  });
});

describe("AC10 -- 50 rows a batch", () => {
  test("AC10: with 51 open jobs the queue returns 50, and the next batch holds the 51st", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    for (let i = 0; i < 48; i += 1) {
      await makeJob({ createdAt: minutesAgo(1000 - i) });
    }

    const first = await queue(mike);
    expect(first.total).toBe(51);
    expect(first.rows).toHaveLength(50);
    expect(first.hasMore).toBe(true);

    const next = await queue(mike, { offset: "50" });
    expect(next.rows.map((row) => row.reference)).toEqual(["JOB-1039"]);
    expect(next.hasMore).toBe(false);
  });

  test("AC10: a bad paging or status value is refused", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await request(app).get("/api/jobs").query({ limit: "0" }).set("Cookie", mike)).status).toBe(400);
    expect((await request(app).get("/api/jobs").query({ offset: "-1" }).set("Cookie", mike)).status).toBe(400);
    expect((await request(app).get("/api/jobs").query({ status: "completed" }).set("Cookie", mike)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The job page
// ---------------------------------------------------------------------------

describe("AC11 -- the request, read-only", () => {
  test("AC11: trade, suburb and postcode, wanted date and window, arrived by, description, and each answered question as saved", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({
      source: "phone",
      description: "Hot water system making a banging noise.",
      selectedOptions: ["Is the hot water gas or electric?: Gas", "Roughly how old is it?: About 12 years"],
    });
    const page = await detail(mike, job.reference);
    expect(page).toMatchObject({
      trade: "Plumbing",
      suburb: "Hilton",
      postcode: "6163",
      wantedDate: "Thu 17/09/26",
      windowLabel: "morning 7:00-12:00",
      source: "phone",
      description: "Hot water system making a banging noise.",
      answers: ["Is the hot water gas or electric?: Gas", "Roughly how old is it?: About 12 years"],
    });
  });

  test("AC11: a job with no answered question carries none", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await detail(mike, "JOB-1042")).answers).toEqual([]);
    expect((await request(app).get("/api/jobs/JOB-9999").set("Cookie", mike)).status).toBe(404);
  });
});

describe("AC12 -- the contractor card", () => {
  test("AC12: JOB-1042 shows Bob Reilly, CON-014, waiting for his answer, the proposed slot labelled AWST; a new job is not dispatched", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const page = await detail(mike, "JOB-1042");
    expect(page.contractor?.name).toBe("Bob Reilly");
    expect(page.contractor?.code).toBe("CON-014");
    expect(page.contractor?.standing).toMatch(/^Waiting for Bob's answer - proposed .+ AWST$/);

    const fresh = await makeJob();
    expect((await detail(mike, fresh.reference)).contractor).toBeNull();
  });
});

describe("AC13-AC18 -- the Addresses card's one Save", () => {
  test("AC13: Karl's first call -- billing picked, ticked, saved: the customer holds the pick and the job site equals it", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ newCustomer: { name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999" }, place: JOONDALUP });
    const before = await detail(mike, job.reference);
    expect(before.customer.billingAddress).toBeNull();
    expect(before.siteSameAsBilling).toBe(true);

    const res = await saveAddresses(mike, job.reference, { billingAddress: KARL_HOME, site: { sameAsBilling: true } });
    expect(res.status).toBe(200);

    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { customer: true } });
    expect(stored.customer.billingAddress).toEqual(KARL_HOME);
    expect(stored.siteAddress).toEqual(KARL_HOME);
    const page = (res.body as { job: DetailBody }).job;
    expect(page.siteSameAsBilling).toBe(true);
    expect((res.body as { moved: unknown }).moved).toBeNull();
  });

  test("AC14: Margaret's billing changed from a new job of hers is on the customer, and JOB-1039's page shows it too", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ customerCode: "CUS-1053", place: APPLECROSS });

    const margaretBefore = (await db.customer.findUniqueOrThrow({ where: { code: "CUS-1053" } })).billingAddress;
    const res = await saveAddresses(mike, job.reference, { billingAddress: MARGARET_NEW_HOME, site: { sameAsBilling: true } });
    expect(res.status).toBe(200);

    const margaret = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1053" } });
    expect(margaret.billingAddress).toEqual(MARGARET_NEW_HOME);
    expect((await detail(mike, "JOB-1039")).customer.billingAddress).toEqual(MARGARET_NEW_HOME);
    // V8: JOB-1039 is on hold with no site of its own -- it keeps the address it was dispatched to.
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1039" } })).siteAddress).toEqual(margaretBefore);
  });

  test("AC15: unticked, a different site stays on the job only -- the billing is unchanged, and Sarah's next new job has no site", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const billingBefore = (await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress;
    const job = await makeJob();

    const res = await saveAddresses(mike, job.reference, { site: { sameAsBilling: false, address: SARAH_RENTAL } });
    expect(res.status).toBe(200);

    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).siteAddress).toEqual(SARAH_RENTAL);
    expect((await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress).toEqual(billingBefore);
    expect((res.body as { job: DetailBody }).job.siteSameAsBilling).toBe(false);

    const next = await makeJob();
    expect((await db.job.findUniqueOrThrow({ where: { id: next.id } })).siteAddress).toBeNull();
    const nextPage = await detail(mike, next.reference);
    expect(nextPage.siteAddress).toBeNull();
    expect(nextPage.siteSameAsBilling).toBe(true);
  });

  test("AC15: ticked again, the site becomes a copy of the billing -- a later billing change never moves it", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob();
    expect((await saveAddresses(mike, job.reference, { site: { sameAsBilling: true } })).status).toBe(200);
    const sarahHome = (await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress;
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).siteAddress).toEqual(sarahHome);

    const other = await makeJob();
    expect((await saveAddresses(mike, other.reference, { billingAddress: SARAH_RENTAL })).status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).siteAddress).toEqual(sarahHome);
  });

  test("AC16: on a new job booked for 6027, a Fremantle 6160 site moves the postcode and serviceLocation; the timezone is unchanged", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ newCustomer: { name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999" }, place: JOONDALUP });

    const res = await saveAddresses(mike, job.reference, { site: { sameAsBilling: false, address: FREMANTLE_SITE } });
    expect(res.status).toBe(200);
    expect((res.body as { moved: unknown }).moved).toEqual({ from: "Joondalup 6027", to: "Fremantle 6160" });

    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.postcode).toBe("6160");
    expect(stored.serviceLocation).toEqual({
      suburb: "Fremantle",
      state: "WA",
      country: "AU",
      lat: FREMANTLE_SITE.lat,
      lng: FREMANTLE_SITE.lng,
      placeId: FREMANTLE_SITE.placeId,
    });
    expect(stored.timezone).toBe("Australia/Perth");
  });

  test("AC16: even a site in another state leaves Job.timezone frozen at creation", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob();
    expect((await saveAddresses(mike, job.reference, { site: { sameAsBilling: false, address: ADELAIDE_SITE } })).status).toBe(200);
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.postcode).toBe("5000");
    expect(stored.timezone).toBe("Australia/Perth");
  });

  test("AC16 (V9): a site in another suburb of the same postcode moves the job too -- Margaret's Ardross pick", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ customerCode: "CUS-1053", place: APPLECROSS });
    const res = await saveAddresses(mike, job.reference, { site: { sameAsBilling: false, address: MARGARET_NEW_HOME } });
    expect(res.status).toBe(200);
    expect((res.body as { moved: unknown }).moved).toEqual({ from: "Applecross 6153", to: "Ardross 6153" });
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.postcode).toBe("6153");
    expect(stored.serviceLocation).toEqual({
      suburb: "Ardross",
      state: "WA",
      country: "AU",
      lat: MARGARET_NEW_HOME.lat,
      lng: MARGARET_NEW_HOME.lng,
      placeId: MARGARET_NEW_HOME.placeId,
    });
  });

  test("AC16 (V9): a site in the job's own suburb still puts the job on the street's coordinates, and reports no move", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob();
    const res = await saveAddresses(mike, job.reference, { site: { sameAsBilling: false, address: SARAH_RENTAL } });
    expect(res.status).toBe(200);
    expect((res.body as { moved: unknown }).moved).toBeNull();
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.postcode).toBe("6163");
    expect(stored.serviceLocation).toMatchObject({ suburb: "Hilton", lat: SARAH_RENTAL.lat, placeId: SARAH_RENTAL.placeId });
  });

  test("AC17: on JOB-1042 (dispatched) the site shows locked, and a save that changes it is refused with nothing written", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await detail(mike, "JOB-1042")).siteLocked).toBe(true);
    const billingBefore = (await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress;

    const res = await saveAddresses(mike, "JOB-1042", {
      billingAddress: SARAH_RENTAL,
      site: { sameAsBilling: false, address: FREMANTLE_SITE },
    });
    expect(res.status).toBe(409);
    expect((res.body as { field?: string }).field).toBe("siteAddress");

    const stored = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    expect(stored.siteAddress).toBeNull();
    expect(stored.postcode).toBe("6163");
    expect((await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress).toEqual(billingBefore);
  });

  test("AC17 (V8): a billing-only save from the dispatched job goes through, and the job keeps the address it was dispatched to", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const sarahHome = (await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress;
    expect((await saveAddresses(mike, "JOB-1042", { billingAddress: SARAH_RENTAL })).status).toBe(200);
    expect((await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress).toEqual(SARAH_RENTAL);
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).siteAddress).toEqual(sarahHome);
    expect((await detail(mike, "JOB-1042")).siteAddress).toEqual(sarahHome);
  });

  test("AC17 (V8): a billing change from another of Sarah's jobs writes the old address onto JOB-1042 first; her new jobs still follow the billing, and a job with its own site keeps it", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const sarahHome = (await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).billingAddress;
    const newJob = await makeJob();
    const otherNew = await makeJob();
    const ownSite = await makeJob({ status: "scheduled", siteAddress: FREMANTLE_SITE, assignment: { status: "accepted", confirmedSlot: daysFromNow(2) } });

    expect((await saveAddresses(mike, newJob.reference, { billingAddress: SARAH_RENTAL })).status).toBe(200);

    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).siteAddress).toEqual(sarahHome);
    expect((await db.job.findUniqueOrThrow({ where: { id: otherNew.id } })).siteAddress).toBeNull();
    expect((await detail(mike, otherNew.reference)).customer.billingAddress).toEqual(SARAH_RENTAL);
    expect((await db.job.findUniqueOrThrow({ where: { id: ownSite.id } })).siteAddress).toEqual(FREMANTLE_SITE);
  });

  test("AC18: an address that is not a structured pick is refused -- missing postcode, lat/lng or placeId, or plain text -- and nothing is stored", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeJob({ newCustomer: { name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999" }, place: JOONDALUP });
    const without = (key: string) => Object.fromEntries(Object.entries(KARL_HOME).filter(([k]) => k !== key));

    for (const bad of [without("postcode"), without("lat"), without("placeId"), "18 Lakeside Drive, Joondalup"]) {
      const billing = await saveAddresses(mike, job.reference, { billingAddress: bad });
      expect(billing.status).toBe(400);
      expect((billing.body as { field?: string }).field).toBe("billingAddress");

      const site = await saveAddresses(mike, job.reference, { site: { sameAsBilling: false, address: bad } });
      expect(site.status).toBe(400);
      expect((site.body as { field?: string }).field).toBe("siteAddress");
    }

    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { customer: true } });
    expect(stored.customer.billingAddress).toBeNull();
    expect(stored.siteAddress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Operator notes
// ---------------------------------------------------------------------------

describe("AC19-AC23 -- operator notes, a log", () => {
  test("AC19: Mike adds a Dispute note to Tom's completed job -- id, at and operatorId are the server's; newest first, labelled AWST, by Mike", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const tomsOld = await makeJob({ customerCode: "CUS-1052", status: "completed", place: KALAMUNDA });
    const started = Date.now();

    const res = await addNote(mike, tomsOld.reference, {
      type: "dispute",
      note: "Tom says Bob was on site 1.5h, not 2.5h.",
      id: "forged-id",
      at: "2020-01-01T00:00:00.000Z",
      operatorId: "someone-else",
    });
    expect(res.status).toBe(201);

    const notes = await storedNotes(tomsOld.reference);
    expect(notes).toHaveLength(1);
    const note = notes[0] ?? {};
    expect(Object.keys(note).sort()).toEqual(["at", "id", "note", "operatorId", "type"]);
    expect(note["id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(note["operatorId"]).toBe(await mikeId());
    expect(note["type"]).toBe("dispute");
    expect(note["note"]).toBe("Tom says Bob was on site 1.5h, not 2.5h.");
    expect(new Date(note["at"] ?? "").getTime()).toBeGreaterThanOrEqual(started - 1000);

    const second = await addNote(mike, tomsOld.reference, { type: "general", note: "Rang Tom back, left a message." });
    expect(second.status).toBe(201);
    const page = second.body as DetailBody;
    expect(page.notes.map((n) => n.type)).toEqual(["general", "dispute"]);
    expect(page.notes[1]?.authorName).toBe("Mike");
    expect(page.notes[1]?.atLabel).toMatch(/^Today, \d{1,2}:\d{2}(am|pm) AWST$/);
  });

  test("AC20: General, Instruction, Complaint and Dispute are taken; correction or any other type is refused", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    for (const type of ["general", "instruction", "complaint", "dispute"]) {
      expect((await addNote(mike, "JOB-1042", { type, note: `A ${type} note.` })).status).toBe(201);
    }
    for (const type of ["correction", "other", "", undefined]) {
      const res = await addNote(mike, "JOB-1042", { type, note: "Should never land." });
      expect(res.status).toBe(400);
      expect((res.body as { field?: string }).field).toBe("type");
    }
    expect((await addNote(mike, "JOB-1042", { type: "general", note: "   " })).status).toBe(400);
    expect((await addNote(mike, "JOB-1042", { type: "general", note: "x".repeat(2001) })).status).toBe(400);
    expect(await storedNotes("JOB-1042")).toHaveLength(4);
  });

  test("AC21: inside 10 minutes Mike edits his own note -- the text changes, editedAt is stamped, and it reads edited", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const added = (await addNote(mike, "JOB-1042", { type: "instruction", note: "Side gate code 4411." })).body as DetailBody;
    const noteId = added.notes[0]?.id ?? "";
    expect(added.notes[0]?.editableForSeconds).toBeGreaterThan(0);
    expect(added.notes[0]?.editableForSeconds).toBeLessThanOrEqual(600);

    const res = await editNote(mike, "JOB-1042", noteId, "Side gate code 4411. The dog is friendly.");
    expect(res.status).toBe(200);
    const stored = (await storedNotes("JOB-1042"))[0] ?? {};
    expect(stored["note"]).toBe("Side gate code 4411. The dog is friendly.");
    expect(stored["editedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((res.body as DetailBody).notes[0]?.edited).toBe(true);
  });

  test("AC21: saving the same text unchanged stamps nothing", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const added = (await addNote(mike, "JOB-1042", { type: "general", note: "Sarah prefers mornings." })).body as DetailBody;
    const res = await editNote(mike, "JOB-1042", added.notes[0]?.id ?? "", "  Sarah prefers mornings.  ");
    expect(res.status).toBe(200);
    expect((await storedNotes("JOB-1042"))[0]?.["editedAt"]).toBeUndefined();
    expect((res.body as DetailBody).notes[0]?.edited).toBe(false);
  });

  test("AC22: after 10 minutes the edit is refused by the server and the page offers no Edit", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const added = (await addNote(mike, "JOB-1042", { type: "general", note: "Original words." })).body as DetailBody;
    const noteId = added.notes[0]?.id ?? "";

    const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    const backdated = ((job.operatorNotes ?? []) as Record<string, string>[]).map((note) => ({
      ...note,
      at: minutesAgo(11).toISOString(),
    }));
    await db.job.update({ where: { id: job.id }, data: { operatorNotes: backdated } });

    const res = await editNote(mike, "JOB-1042", noteId, "Changed words.");
    expect(res.status).toBe(409);
    expect((await storedNotes("JOB-1042"))[0]?.["note"]).toBe("Original words.");
    expect((await detail(mike, "JOB-1042")).notes[0]?.editableForSeconds).toBe(0);
  });

  test("AC23: the owner cannot edit Mike's note even inside the 10 minutes -- refused, and no Edit shows for the owner", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const owner = await signInCookie("owner@idelta.com.au");
    const added = (await addNote(mike, "JOB-1042", { type: "complaint", note: "Sarah unhappy with the wait." })).body as DetailBody;
    const noteId = added.notes[0]?.id ?? "";

    const res = await editNote(owner, "JOB-1042", noteId, "Owner rewrote it.");
    expect(res.status).toBe(403);
    expect((await storedNotes("JOB-1042"))[0]?.["note"]).toBe("Sarah unhappy with the wait.");

    expect((await detail(owner, "JOB-1042")).notes[0]?.editableForSeconds).toBe(0);
    expect((await detail(mike, "JOB-1042")).notes[0]?.editableForSeconds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The ops inbox email, and the seed
// ---------------------------------------------------------------------------

describe("AC24 -- the new-job-request email links to the job page", () => {
  test("AC24: the email carries <web origin>/ops/jobs/<reference>, in the text and as the HTML link", async () => {
    await setProviders(db, { emailProvider: email.name, providerOverrides: null });
    const res = await request(app)
      .post("/api/enquiries")
      .send({
        name: "Karl",
        email: "karl@idelta.com.au",
        phone: "0400 000 999",
        location: { suburb: "Joondalup", state: "WA", country: "AU", postcode: "6027", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" },
        trade: "Plumbing",
        selectedOptions: [],
        preferredDate: "2026-09-16",
        preferredWindow: "morning",
        description: "Kitchen tap won't stop dripping.",
        marketingEmail: false,
        marketingSms: false,
      });
    expect(res.status).toBe(201);
    const reference = (res.body as { reference: string }).reference;

    await drainOnce(db);
    const settings = await db.platformSettings.findFirstOrThrow();
    const notice = email.sent.find((m) => m.to === settings.operatorEmail);
    const url = `${process.env["WEB_ORIGIN"] ?? ""}/ops/jobs/${reference}`;
    expect(url).toMatch(/^https?:\/\/[^/]+\/ops\/jobs\/JOB-\d+$/);
    expect(notice?.message.text).toContain(url);
    expect(notice?.message.html).toContain(`href="${url}"`);
  });
});

describe("AC26 (BKLG-023) -- Plumbing's questions", () => {
  test("AC26 (BKLG-023): a fresh base seed gives Plumbing the six questions, in order", async () => {
    await truncateAll(db);
    await seedBase(db);
    const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    expect(plumbing.prefilledFields).toEqual([
      "Where in the property is it?",
      "What brand is it, if you know?",
      "Roughly how old is it?",
      "Is water leaking right now?",
      "Can you turn the water off at the mains?",
      "Is the hot water gas or electric?",
    ]);
  });
});
