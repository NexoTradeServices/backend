// Feature 4006 -- take off (the design's Reassign)
//
// AC4  taking Bob off JOB-1042 cancels his booking (audit pair), removes the block, kills his link,
//      sends him "Job reassigned" email + text, and puts the job back to New with the Dispatch
//      button; when the job was booked Sarah and Lena each get a "Job update" email + text (CL-04),
//      when it was not nobody customer-side is told
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
import { Prisma } from "../src/generated/prisma/client.js";
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
  test("AC4: an accepted booking comes off: cancelled by Mike, block gone, link dead, Bob told, job New with Dispatch", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    await drainOnce(db);
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });

    const res = await takeOff(mike);
    expect(res.status).toBe(200);
    const body = res.body as { toast: string; job: { status: string; canDispatch: boolean; actions: { takeOff: boolean }; contractor: unknown } };
    expect(body.toast).toBe("JOB-1042 reassigned. It's back in New.");
    expect(body.job).toMatchObject({ status: "new", canDispatch: true, contractor: null });
    expect(body.job.actions.takeOff).toBe(false);

    const old = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(old).toMatchObject({ status: "cancelled", cancelledByUserId: mikeUser.id });
    expect(old.cancelledAt).not.toBeNull();
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(0);

    const rows = await rowsOf(db, jobId, "taken_off");
    expect(rows.map((row) => row.channel).sort()).toEqual(["email", "sms"]);
    expect(rows.every((row) => row.recipientType === "contractor")).toBe(true);

    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "bob@idelta.com.au" && (m.message.subject ?? "") === "Job reassigned - JOB-1042");
    expect(mail?.message.text).toContain("Your calendar is clear for that time.");
  });

  test("AC4 (CL-04): a booked job sends Sarah and Lena a Job update, each in their own wording; nothing states a time that is still on", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    await drainOnce(db);
    email.reset();
    expect((await takeOff(mike)).status).toBe(200);

    const rows = await rowsOf(db, jobId, "job_update");
    expect(rows.map((row) => `${row.recipientType}:${row.channel}`).sort()).toEqual([
      "customer:email",
      "customer:sms",
      "site_contact:email",
      "site_contact:sms",
    ]);
    // Keys are derivable, so a retry is the same ask.
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(4);

    await drainOnce(db);
    const sarah = email.sent.find((m) => m.to === "sarah@idelta.com.au" && (m.message.subject ?? "").startsWith("Job update"));
    expect(sarah?.message.subject).toBe("Job update - JOB-1042");
    expect(sarah?.message.text).toContain("Hi Sarah,");
    expect(sarah?.message.text).toContain("is being re-arranged. We'll send you the new time shortly.");
    expect(sarah?.message.text).toContain("12 Paget Street, Hilton");
    expect(sarah?.message.text).not.toContain("Lena");
    expect(sarah?.message.text).not.toContain("$");
    const lena = email.sent.find((m) => m.to === "lena@idelta.com.au" && (m.message.subject ?? "").startsWith("Job update"));
    expect(lena?.message.subject).toMatch(/^Job update - 12 Paget Street, /);
    expect(lena?.message.text).toContain("Hi Lena,");
    expect(lena?.message.text).toContain("is being re-arranged. You'll hear the new time shortly.");
    expect(lena?.message.text).not.toContain("Sarah");
    expect(lena?.message.text).not.toContain("0400");
  });

  test("AC4 (CL-04): a site contact who gave no email gets the text only", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    await db.job.update({ where: { id: jobId }, data: { siteContact: { name: "Lena Park", phone: "0400 002 050" } } });
    expect((await takeOff(mike)).status).toBe(200);
    const rows = await rowsOf(db, jobId, "job_update");
    expect(rows.filter((row) => row.recipientType === "site_contact").map((row) => row.channel)).toEqual(["sms"]);
    expect(rows.filter((row) => row.recipientType === "customer")).toHaveLength(2);
  });

  test("AC4 (CL-04): no site contact on the job - only the customer is told", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    await db.job.update({ where: { id: jobId }, data: { siteContact: Prisma.DbNull } });
    expect((await takeOff(mike)).status).toBe(200);
    const rows = await rowsOf(db, jobId, "job_update");
    expect(rows.map((row) => row.recipientType)).toEqual(["customer", "customer"]);
  });

  test("AC4 (CL-04): a booking still waiting for his answer comes off the same way, and nobody customer-side is told", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const waiting = await activeAssignment(db, "JOB-1042");
    expect(waiting.status).toBe("assigned");
    expect((await takeOff(mike)).status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).status).toBe("new");
    expect((await db.assignment.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("cancelled");
    // No confirmed time ever went to Sarah or Lena, so there is nothing to update.
    expect(await db.notification.count({ where: { jobId: waiting.jobId, type: "job_update" } })).toBe(0);
    expect(
      await db.notification.count({ where: { jobId: waiting.jobId, recipientType: { in: ["customer", "site_contact"] } } }),
    ).toBe(0);
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

  test("AC9: Earlier bookings shows Bob as Reassigned with the old time; a later dispatch of Bob again does not turn it into Rescheduled", async () => {
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
    expect(detail.earlierBookings[0]).toMatchObject({ contractorName: "Bob Reilly", what: "Reassigned" });
    expect(detail.earlierBookings[0]?.slotLabel).not.toBeNull();
  });
});
