// Feature 4006 -- take off (the design's Reassign)
//
// AC4  taking Bob off JOB-1042 cancels his booking (audit pair), removes the block, kills his link,
//      sends him "You're off JOB-1042" email + text, and puts the job back to New with the Dispatch
//      button; Sarah gets nothing
// AC8  his old link says "You're no longer booked" (taken_off)
// AC9  Earlier bookings lists it as Taken off
// AC12 the link's row is kept, expired
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import {
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
const email = recordingAdapter("test-email-4006-take-off", "email");

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

const takeOff = (cookie: string, reference = "JOB-1042") =>
  request(app).post(`/api/jobs/${reference}/take-off`).set("Cookie", cookie).send({});

describe("AC4 -- taking Bob off", () => {
  test("AC4: an accepted booking comes off: cancelled by Mike, block gone, link dead, Bob told, job New with Dispatch, Sarah told nothing", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    await drainOnce(db);
    const before = await db.notification.count({ where: { jobId, recipientType: { in: ["customer", "site_contact"] } } });
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });

    const res = await takeOff(mike);
    expect(res.status).toBe(200);
    const body = res.body as { toast: string; job: { status: string; canDispatch: boolean; actions: { takeOff: boolean }; contractor: unknown } };
    expect(body.toast).toBe("Bob taken off JOB-1042. It's back in New.");
    expect(body.job).toMatchObject({ status: "new", canDispatch: true, contractor: null });
    expect(body.job.actions.takeOff).toBe(false);

    const old = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(old).toMatchObject({ status: "cancelled", cancelledByUserId: mikeUser.id });
    expect(old.cancelledAt).not.toBeNull();
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(0);

    const rows = await rowsOf(db, jobId, "taken_off");
    expect(rows.map((row) => row.channel).sort()).toEqual(["email", "sms"]);
    expect(rows.every((row) => row.recipientType === "contractor")).toBe(true);
    expect(await db.notification.count({ where: { jobId, recipientType: { in: ["customer", "site_contact"] } } })).toBe(before);

    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "bob@idelta.com.au" && (m.message.subject ?? "") === "You're off JOB-1042");
    expect(mail?.message.text).toContain("Nothing to do");
  });

  test("AC4: a booking still waiting for his answer comes off the same way", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const waiting = await activeAssignment(db, "JOB-1042");
    expect(waiting.status).toBe("assigned");
    expect((await takeOff(mike)).status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).status).toBe("new");
    expect((await db.assignment.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("cancelled");
  });

  test("AC4: refused from New and from work in progress; nothing is sent", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await db.job.update({ where: { reference: "JOB-1042" }, data: { status: "new" } });
    expect((await takeOff(mike)).status).toBe(409);
    await db.job.update({ where: { reference: "JOB-1042" }, data: { status: "in_progress" } });
    const res = await takeOff(mike);
    expect(res.status).toBe(409);
    expect(await db.notification.count({ where: { type: "taken_off" } })).toBe(0);
  });
});

describe("AC8, AC9, AC12 -- the old link and the history", () => {
  test("AC8, AC12: Bob's old link reads taken_off with the job reference; the row is kept and expired", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const waiting = await activeAssignment(db, "JOB-1042");
    const token = await respondToken(db, waiting.id);
    await takeOff(mike);
    const read = await request(app).get(`/api/respond/${token}`);
    expect(read.status).toBe(410);
    expect(read.body).toMatchObject({ state: "taken_off", jobReference: "JOB-1042" });
    expect((read.body as { officePhone: string }).officePhone).not.toBe("");
    // Answering through it is refused the same way.
    const answer = await request(app).post(`/api/respond/${token}/accept`).send({});
    expect(answer.status).toBe(410);
    const rows = await db.capabilityToken.findMany({ where: { assignmentId: waiting.id } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("AC9: Earlier bookings shows Bob as Taken off with the old time; a later dispatch of Bob again does not turn it into Moved", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await takeOff(mike);
    const again = await request(app)
      .post("/api/jobs/JOB-1042/dispatch")
      .set("Cookie", mike)
      .send({ contractorCode: "CON-014", date: "2027-03-15", startMinutes: 420, holdMinutes: 60, emergency: false });
    expect(again.status).toBe(201);
    const detail = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as {
      earlierBookings: { contractorName: string; what: string; slotLabel: string | null }[];
    };
    expect(detail.earlierBookings).toHaveLength(1);
    expect(detail.earlierBookings[0]).toMatchObject({ contractorName: "Bob Reilly", what: "Taken off" });
    expect(detail.earlierBookings[0]?.slotLabel).not.toBeNull();
  });
});
