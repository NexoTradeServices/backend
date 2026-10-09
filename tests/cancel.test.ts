// Feature 4006 -- cancel job (Ops job actions; Cancellation policy)
//
// AC5  cancel asks for a reason; Other needs a note; the job reads Cancelled with reason, note, Mike and
//      time; its booking cancelled, block freed, link dead
// AC6  who is told: as-you-asked / apology / nobody for a duplicate; Bob when he held a booking, answered
//      or not; Lena only when the job was booked
// AC7  refused once work has started; no-show cannot be picked
// AC8  the contractor's old link says the job was cancelled, even one he had answered
// AC9  Earlier bookings shows Cancelled
// AC12 the track link's row is kept, expired
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { CapabilityTokenType, mintCapabilityLink } from "../src/capability-tokens/index.js";
import {
  acceptJob1042,
  activeAssignment,
  buildOpsApp,
  freshWorld,
  makeNewJob,
  respondToken,
  rowsOf,
  signIn,
} from "./helpers/ops-app.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-4006-cancel", "email");

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

const cancel = (cookie: string, reference: string, body: Record<string, unknown>) =>
  request(app).post(`/api/jobs/${reference}/cancel`).set("Cookie", cookie).send(body);

async function recipients(jobId: string, type: string): Promise<string[]> {
  const rows = await rowsOf(db, jobId, type);
  return rows.map((row) => `${row.recipientType}:${row.channel}`).sort();
}

describe("AC5 -- the cancel", () => {
  test("AC5: reason is required; Other needs a note; a long note is refused", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const none = await cancel(mike, "JOB-1042", {});
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ field: "reason" });
    const other = await cancel(mike, "JOB-1042", { reason: "other", note: "   " });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ field: "note", error: "Required." });
    const long = await cancel(mike, "JOB-1042", { reason: "price", note: "x".repeat(501) });
    expect(long.status).toBe(400);
    expect((await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).status).toBe("assigned");
  });

  test("AC5: cancelling the scheduled JOB-1042: Cancelled with reason, note, Mike and the day; booking cancelled, block freed, links dead", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId, assignmentId } = await acceptJob1042(db, app);
    const track = await mintCapabilityLink(db, { type: CapabilityTokenType.track, jobId });
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });

    const res = await cancel(mike, "JOB-1042", { reason: "customer_changed_mind", note: "  Sarah rang this morning  " });
    expect(res.status).toBe(200);
    const body = res.body as {
      toast: string;
      job: { status: string; actions: Record<string, boolean>; cancelled: { reasonLabel: string; note: string | null; byName: string; atLabel: string }; contractor: unknown };
    };
    expect(body.toast).toBe("JOB-1042 cancelled.");
    expect(body.job.status).toBe("cancelled");
    expect(body.job.actions).toEqual({ reschedule: false, takeOff: false, cancel: false });
    expect(body.job.cancelled).toMatchObject({
      reasonLabel: "Customer changed their mind",
      note: "Sarah rang this morning",
      byName: "Mike",
    });
    expect(body.job.cancelled.atLabel).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "cancelled", cancelReason: "customer_changed_mind", cancelledByUserId: mikeUser.id });
    expect(job.cancelledAt).not.toBeNull();
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment).toMatchObject({ status: "cancelled", cancelledByUserId: mikeUser.id });
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(0);

    const trackRow = await db.capabilityToken.findUniqueOrThrow({ where: { id: track.tokenId } });
    expect(trackRow.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("AC5: a job still New cancels with no booking to cancel", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    expect((await cancel(mike, job.reference, { reason: "price" })).status).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
  });
});

describe("AC6 -- who is told", () => {
  test("AC6: scheduled with Lena as site contact, changed mind: Sarah as-you-asked, Lena text + email, Bob email + text", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    await cancel(mike, "JOB-1042", { reason: "customer_changed_mind" });

    expect(await recipients(jobId, "job_cancelled")).toEqual([
      "customer:email",
      "customer:sms",
      "site_contact:email",
      "site_contact:sms",
    ]);
    expect(await recipients(jobId, "job_cancelled_contractor")).toEqual(["contractor:email", "contractor:sms"]);
    const sarah = (await rowsOf(db, jobId, "job_cancelled")).find((row) => row.recipientType === "customer");
    expect(sarah?.context).toMatchObject({ wording: "as_you_asked" });
    // Keys are derivable: <type>:job:<jobId>:<audience>:<channel>
    expect((await rowsOf(db, jobId, "job_cancelled")).map((row) => row.idempotencyKey)).toContain(
      `job_cancelled:job:${jobId}:customer:email`,
    );

    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "sarah@idelta.com.au" && (m.message.subject ?? "").startsWith("Cancelled"));
    expect(mail?.message.text).toContain("As you asked");
    expect(mail?.message.text).toContain("Nothing is owed");
    expect(mail?.message.text).toContain("JOB-1042");
    const lena = email.sent.find((m) => m.to === "lena@idelta.com.au" && (m.message.subject ?? "").startsWith("Visit cancelled"));
    expect(lena?.message.subject).toContain("Visit cancelled");
    expect(lena?.message.text).toContain("Nobody will come");
    const bob = email.sent.find((m) => m.to === "bob@idelta.com.au" && (m.message.subject ?? "").startsWith("Job cancelled"));
    expect(bob?.message.text).toContain("Don't go");
  });

  test("AC6: still waiting on Bob (assigned): Sarah and Bob told, Lena not (the visit was never confirmed to her)", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const jobId = (await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).id;
    await cancel(mike, "JOB-1042", { reason: "price" });
    expect(await recipients(jobId, "job_cancelled")).toEqual(["customer:email", "customer:sms"]);
    expect(await recipients(jobId, "job_cancelled_contractor")).toEqual(["contractor:email", "contractor:sms"]);
  });

  test("AC6: Nobody can cover the area: Sarah gets the apology", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const job = await makeNewJob(db);
    await cancel(mike, job.reference, { reason: "no_coverage" });
    expect(await recipients(job.id, "job_cancelled")).toEqual(["customer:email", "customer:sms"]);
    expect(await recipients(job.id, "job_cancelled_contractor")).toEqual([]);
    await drainOnce(db);
    const mail = email.sent.find((m) => m.to === "sarah@idelta.com.au" && (m.message.subject ?? "").startsWith("Sorry"));
    expect(mail?.message.text).toContain("nobody can cover your area");
    expect(mail?.message.text).toContain("Nothing is owed");
  });

  test("AC6: Duplicate: nobody customer-side hears; Bob still does when he held a booking", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const jobId = (await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).id;
    await cancel(mike, "JOB-1042", { reason: "duplicate" });
    expect(await recipients(jobId, "job_cancelled")).toEqual([]);
    expect(await recipients(jobId, "job_cancelled_contractor")).toEqual(["contractor:email", "contractor:sms"]);

    const second = await makeNewJob(db);
    await cancel(mike, second.reference, { reason: "duplicate" });
    expect(await db.notification.count({ where: { jobId: second.id } })).toBe(0);
  });

  test("AC6: Duplicate on a booked job: Lena is not told either (nobody customer-side), Bob is", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { jobId } = await acceptJob1042(db, app);
    await cancel(mike, "JOB-1042", { reason: "duplicate" });
    expect(await recipients(jobId, "job_cancelled")).toEqual([]);
    expect(await recipients(jobId, "job_cancelled_contractor")).toEqual(["contractor:email", "contractor:sms"]);
  });
});

describe("AC7 -- once work has started", () => {
  test("AC7: in progress, on hold and completed are refused with the plan's words; nothing changes or sends", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const jobId = (await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } })).id;
    for (const status of ["in_progress", "on_hold", "completed"] as const) {
      await db.job.update({ where: { id: jobId }, data: { status } });
      const res = await cancel(mike, "JOB-1042", { reason: "price" });
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe("Work has started - cancel is for before work starts.");
      expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(status);
    }
    expect(await db.notification.count({ where: { type: { in: ["job_cancelled", "job_cancelled_contractor"] } } })).toBe(0);
  });

  test("AC7: No-show cannot be picked here, and an already cancelled job is refused", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const res = await cancel(mike, "JOB-1042", { reason: "customer_no_show" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("No-show is its own action.");
    expect((await cancel(mike, "JOB-1042", { reason: "price" })).status).toBe(200);
    expect((await cancel(mike, "JOB-1042", { reason: "price" })).status).toBe(409);
  });

  test("AC7: Cancel is for Mike: a contractor session is refused", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    expect((await cancel(bob, "JOB-1042", { reason: "price" })).status).toBe(403);
  });
});

describe("AC8, AC9 -- the old link and the history", () => {
  test("AC8: Bob's link, answered or not, says the job was cancelled", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const waiting = await activeAssignment(db, "JOB-1042");
    const token = await respondToken(db, waiting.id);
    await cancel(mike, "JOB-1042", { reason: "customer_changed_mind" });
    const read = await request(app).get(`/api/respond/${token}`);
    expect(read.status).toBe(410);
    expect(read.body).toMatchObject({ state: "cancelled", jobReference: "JOB-1042" });
  });

  test("AC8: a link Bob had already answered says cancelled too, not 'already answered'", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const { assignmentId } = await acceptJob1042(db, app);
    const token = await respondToken(db, assignmentId);
    await cancel(mike, "JOB-1042", { reason: "price" });
    const read = await request(app).get(`/api/respond/${token}`);
    expect(read.body).toMatchObject({ state: "cancelled" });
  });

  test("AC9: Earlier bookings lists Bob's booking as Cancelled; a take-off before it stays Taken off", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await request(app).post("/api/jobs/JOB-1042/take-off").set("Cookie", mike).send({});
    await request(app)
      .post("/api/jobs/JOB-1042/dispatch")
      .set("Cookie", mike)
      .send({ contractorCode: "CON-014", date: "2027-03-15", startMinutes: 420, holdMinutes: 60, emergency: false });
    await cancel(mike, "JOB-1042", { reason: "other", note: "Moved house" });
    const detail = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as {
      earlierBookings: { what: string }[];
      cancelled: { reasonLabel: string; note: string };
    };
    expect(detail.earlierBookings.map((entry) => entry.what).sort()).toEqual(["Cancelled", "Taken off"]);
    expect(detail.cancelled).toMatchObject({ reasonLabel: "Other", note: "Moved house" });
  });
});
