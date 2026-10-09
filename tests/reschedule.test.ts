// Feature 4006 -- reschedule (Ops job actions; Contractor Workflow step 5)
//
// AC1  rescheduling the scheduled JOB-1042 swaps Bob's bookings in one step: old cancelled (Mike + time),
//      block off, new booking + hold block, the new date's level, job Assigned; Bob gets ONE "Job moved"
//      email + text with the old time off, the new time and an Accept link; Sarah gets nothing
// AC2  Bob accepting the new time sends Sarah her slot confirmation with the new time and that date's
//      price (a Saturday move states the weekend price); Lena gets her own wording
// AC3  the dispatch guards run again without counting the job's own old block; a refusal leaves the old
//      booking untouched
// AC8  Bob's old link says "moved" - even one he had already answered
// AC9  Earlier bookings lists the old booking as Moved
// AC12 the old link's row is kept, expired
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { formatDollars } from "../src/enquiries/money.js";
import {
  MONDAY,
  SATURDAY,
  acceptJob1042,
  activeAssignment,
  buildOpsApp,
  freshWorld,
  respondToken,
  rowsOf,
  signIn,
} from "./helpers/ops-app.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-4006-reschedule", "email");

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  app = buildOpsApp(db);
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

beforeEach(async () => {
  await freshWorld(db, email);
});

afterEach(async () => {
  await resetReferenceSequences(db);
});

function reschedule(cookie: string, body: Record<string, unknown>) {
  return request(app).post("/api/jobs/JOB-1042/reschedule").set("Cookie", cookie).send(body);
}

const MONDAY_7AM = { date: MONDAY, startMinutes: 420, holdMinutes: 60, emergency: false };

describe("AC1 -- the swap", () => {
  test("AC1: the scheduled JOB-1042 moves to a Monday: old booking cancelled by Mike, block off, new hold, level re-derived, job Assigned", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    await drainOnce(db);
    const before = await db.notification.count({ where: { jobId, recipientType: { in: ["customer", "site_contact"] } } });
    expect(before).toBeGreaterThan(0);
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });

    const res = await reschedule(mike, MONDAY_7AM);
    expect(res.status).toBe(200);
    expect((res.body as { toast: string }).toast).toBe("JOB-1042 moved. Waiting for Bob's answer.");

    const old = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(old.status).toBe("cancelled");
    expect(old.cancelledByUserId).toBe(mikeUser.id);
    expect(old.cancelledAt).not.toBeNull();
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(0);

    const fresh = await activeAssignment(db, "JOB-1042");
    expect(fresh.id).not.toBe(assignmentId);
    expect(fresh.status).toBe("assigned");
    expect(fresh.contractorId).toBe(old.contractorId);
    expect(fresh.proposedSlot?.toISOString()).toBe("2027-03-14T23:00:00.000Z"); // Mon 7:00am AWST
    const blocks = await db.calendarEvent.findMany({ where: { assignmentId: fresh.id } });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("job");
    const block = blocks[0];
    expect(block === undefined ? 0 : (block.endTime.getTime() - block.startTime.getTime()) / 60_000).toBe(60);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("assigned");
    expect(job.serviceLevel).toBe("normal");

    // ONE "Job moved" per channel to Bob, nothing new to the customer or the site contact.
    const moved = await rowsOf(db, jobId, "job_moved");
    expect(moved.map((row) => row.channel).sort()).toEqual(["email", "sms"]);
    expect(moved.every((row) => row.recipientType === "contractor")).toBe(true);
    expect(await db.notification.count({ where: { jobId, recipientType: { in: ["customer", "site_contact"] } } })).toBe(before);

    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "bob@idelta.com.au" && (m.message.subject ?? "").startsWith("Job moved"));
    expect(mail?.message.subject).toContain("JOB-1042");
    expect(mail?.message.text).toMatch(/is off/);
    expect(mail?.message.text).toContain("Site contact: Lena Park");
    expect(mail?.message.text).not.toContain("0400"); // the phone is never given
    expect(mail?.message.text).toMatch(/\/a\/[\w-]+/);
  });

  test("AC5: the job page offers Reschedule, Take off and Cancel while the job is booked", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const detail = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as {
      actions: { reschedule: boolean; takeOff: boolean; cancel: boolean };
    };
    expect(detail.actions).toEqual({ reschedule: true, takeOff: true, cancel: true });
  });
});

describe("AC2 -- Bob accepts the new time", () => {
  test("AC2: Sarah's slot confirmation states the new time and the Saturday (weekend) price; Lena gets her own wording", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await acceptJob1042(db, app);
    await drainOnce(db);
    expect((await reschedule(mike, { ...MONDAY_7AM, date: SATURDAY, startMinutes: 480 })).status).toBe(200);
    const fresh = await activeAssignment(db, "JOB-1042");
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).serviceLevel).toBe("weekend");

    email.reset();
    const token = await respondToken(db, fresh.id);
    expect((await request(app).post(`/api/respond/${token}/accept`).send({})).status).toBe(200);
    await drainOnce(db);

    const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    const multipliers = serviceType.serviceLevelMultipliers as { weekend: number };
    const callout = formatDollars(Math.round(serviceType.customerCalloutRate * multipliers.weekend));
    const standard = formatDollars(Math.round(serviceType.customerStandardRate * multipliers.weekend));

    const sarah = email.sent.find((m) => m.to === "sarah@idelta.com.au" && (m.message.subject ?? "").startsWith("Booked"));
    expect(sarah?.message.text).toContain("Sat 20/03, 8:00am AWST");
    expect(sarah?.message.text).toContain(`${callout} call-out including the first hour, then ${standard} an hour`);
    expect(sarah?.message.text).not.toContain("Lena");

    const lena = email.sent.find((m) => m.to === "lena@idelta.com.au");
    expect(lena?.message.text).toContain("Sat 20/03, 8:00am AWST");
    expect(lena?.message.text).not.toContain("$");
  });
});

describe("AC3 -- the guards run again", () => {
  test("AC3: a slot in the past is refused and the old booking stays exactly as it was", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    const res = await reschedule(mike, { ...MONDAY_7AM, date: "2020-01-06" });
    expect(res.status).toBe(400);
    const old = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(old.status).toBe("accepted");
    expect(old.cancelledAt).toBeNull();
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("scheduled");
    expect(await rowsOf(db, jobId, "job_moved")).toHaveLength(0);
  });

  test("AC3: a clash with another job of Bob's is refused as busy; the old booking stays", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    const old = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    await db.calendarEvent.create({
      data: {
        contractorId: old.contractorId,
        type: "time_off",
        startTime: new Date("2027-03-14T22:00:00.000Z"),
        endTime: new Date("2027-03-15T01:00:00.000Z"),
      },
    });
    const res = await reschedule(mike, MONDAY_7AM);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/busy/i);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("accepted");
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(1);
    expect(await rowsOf(db, jobId, "job_moved")).toHaveLength(0);
  });

  test("AC3: the job's own old block is not a clash -- moving half an hour later overlapping it goes through", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await acceptJob1042(db, app);
    const facts = (await request(app).get("/api/jobs/JOB-1042/dispatch").query({ mode: "reschedule" }).set("Cookie", mike)).body as {
      mode: string;
      contractor: { code: string; firstName: string };
      defaults: { date: string; startMinutes: number; holdMinutes: number };
    };
    expect(facts.mode).toBe("reschedule");
    expect(facts.contractor).toMatchObject({ code: "CON-014", firstName: "Bob" });

    const res = await reschedule(mike, { ...facts.defaults, startMinutes: facts.defaults.startMinutes + 30, emergency: false });
    expect(res.status).toBe(200);
  });

  test("AC3: the candidates for a reschedule do not count the job's own block as busy", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await acceptJob1042(db, app);
    const facts = (await request(app).get("/api/jobs/JOB-1042/dispatch").query({ mode: "reschedule" }).set("Cookie", mike)).body as {
      defaults: { date: string; startMinutes: number; holdMinutes: number };
    };
    const query = { ...facts.defaults, emergency: "false" };
    type Rows = { serves: { code: string; pickable: boolean; why: string | null }[]; outside: { code: string; pickable: boolean; why: string | null }[] };
    const plain = (await request(app).get("/api/jobs/JOB-1042/dispatch/candidates").query(query).set("Cookie", mike)).body as Rows;
    const mode = (await request(app).get("/api/jobs/JOB-1042/dispatch/candidates").query({ ...query, mode: "reschedule" }).set("Cookie", mike)).body as Rows;
    const bobPlain = [...plain.serves, ...plain.outside].find((row) => row.code === "CON-014");
    const bobMode = [...mode.serves, ...mode.outside].find((row) => row.code === "CON-014");
    expect(bobPlain?.pickable).toBe(false);
    expect(bobPlain?.why).toMatch(/^Busy/);
    expect(bobMode?.pickable).toBe(true);
  });

  test("AC3: a new job cannot be rescheduled (409), and a contractor session is refused", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await db.job.update({ where: { reference: "JOB-1042" }, data: { status: "new" } });
    expect((await reschedule(mike, MONDAY_7AM)).status).toBe(409);
    const bob = await signIn(app, "bob@idelta.com.au");
    expect((await reschedule(bob, MONDAY_7AM)).status).toBe(403);
  });
});

describe("AC8, AC9, AC12 -- the old link and the history", () => {
  test("AC8, AC12: Bob's answered old link says it was moved; its row is kept and expired", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { assignmentId } = await acceptJob1042(db, app);
    // A link Bob had already answered through: the accept burned it; mint one more and burn like the answer did.
    const token = await respondToken(db, assignmentId);
    expect((await reschedule(mike, MONDAY_7AM)).status).toBe(200);

    const read = await request(app).get(`/api/respond/${token}`);
    expect(read.status).toBe(410);
    expect(read.body).toMatchObject({ state: "moved", jobReference: "JOB-1042" });

    const rows = await db.capabilityToken.findMany({ where: { assignmentId } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("AC9: the job page lists the old booking under Earlier bookings as Moved, with the old time", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { assignmentId } = await acceptJob1042(db, app);
    const old = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    await reschedule(mike, MONDAY_7AM);
    const detail = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as {
      earlierBookings: { contractorName: string; what: string; slotLabel: string | null }[];
      contractor: { standing: string } | null;
    };
    expect(detail.earlierBookings).toHaveLength(1);
    expect(detail.earlierBookings[0]).toMatchObject({ contractorName: "Bob Reilly", what: "Moved" });
    expect(detail.earlierBookings[0]?.slotLabel).not.toBeNull();
    expect(old.confirmedSlot).not.toBeNull();
    expect(detail.contractor?.standing).toMatch(/^Waiting for Bob's answer/);
  });
});
