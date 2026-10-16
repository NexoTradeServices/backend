// Feature 6004 -- callbacks (Callbacks; Ops job actions)
//
// AC1  Mike raises a callback from a completed job: a linked new job, the words, the copied facts, nothing sent
// AC2  an empty description is refused and nothing is made
// AC3  a callback raised from a callback links to the root original
// AC4  refused 409 on a job that is not completed; a contractor gets 403
// AC5  the job read carries Callback on / Callbacks (oldest first) and the two flags
// AC5a the original, read-only, for the contractor attending the callback -- and only then
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { freshWorld, signIn } from "./helpers/ops-app.js";
import { acceptCallback, buildCallbackApp, completedOriginal, raise } from "./helpers/callbacks.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-6004-callbacks", "email");

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  app = buildCallbackApp(db);
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

const callback = (cookie: string, reference: string, body: Record<string, unknown>) =>
  request(app).post(`/api/jobs/${reference}/callback`).set("Cookie", cookie).send(body);


const detail = async (cookie: string, reference: string) =>
  (await request(app).get(`/api/jobs/${reference}`).set("Cookie", cookie)).body as {
    callbackOn: string | null;
    callbacks: string[];
    canRaiseCallback: boolean;
    canMarkNoShow: boolean;
  };

describe("AC1 -- raise a callback", () => {
  test("AC1: a new linked job with the copied facts, his words, status New, today, fresh rates, and nothing sent", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const original = await completedOriginal(db);
    await db.job.update({
      where: { id: original.jobId },
      data: { siteContact: { name: "Lena Park", phone: "0400 111 222" } },
    });
    // The trade's rate card moves after the first job: the callback starts from the live card (Tier 1 again).
    await db.serviceType.update({ where: { trade: "Plumbing" }, data: { customerCalloutRate: 27_000 } });
    const sent = email.sent.length;

    const res = await callback(mike, original.reference, { description: "  The tap drips again.  " });
    expect(res.status).toBe(201);
    const body = res.body as { jobReference: string; toast: string };
    expect(body.toast).toBe(`Raised callback ${body.jobReference}.`);

    const first = await db.job.findUniqueOrThrow({ where: { id: original.jobId } });
    const made = await db.job.findUniqueOrThrow({ where: { reference: body.jobReference } });
    expect(made.reference).not.toBe(original.reference);
    expect(made).toMatchObject({
      parentJobId: original.jobId,
      customerId: first.customerId,
      serviceTypeId: first.serviceTypeId,
      postcode: first.postcode,
      timezone: first.timezone,
      description: "The tap drips again.",
      source: "phone",
      status: "new",
      customerCalloutRate: 27_000,
      customerStandardRate: first.customerStandardRate,
    });
    expect(made.siteAddress).toEqual(first.siteAddress);
    expect(made.siteContact).toEqual({ name: "Lena Park", phone: "0400 111 222" });
    expect(made.serviceLocation).toEqual(first.serviceLocation);
    expect(made.preferredWindow).toBe(first.preferredWindow);
    expect(made.preferredDate.toISOString().slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await db.assignment.count({ where: { jobId: made.id } })).toBe(0);
    expect(await db.notification.count()).toBe(0);
    expect(email.sent).toHaveLength(sent);
  });
});

describe("AC2 -- the words are required", () => {
  test("AC2: empty or blank is refused with Required. and no job is made", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const original = await completedOriginal(db);
    const before = await db.job.count();
    for (const description of [undefined, "", "   "]) {
      const res = await callback(mike, original.reference, description === undefined ? {} : { description });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Required.", field: "description" });
    }
    expect(await db.job.count()).toBe(before);
  });
});

describe("AC3 -- always the root", () => {
  test("AC3: a callback raised from a completed callback links to the original, not the callback", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const original = await completedOriginal(db);
    const first = await raise(app, mike, original.reference);
    await db.job.update({ where: { reference: first }, data: { status: "completed" } });
    const second = await raise(app, mike, first, "Still drips.");
    const row = await db.job.findUniqueOrThrow({ where: { reference: second } });
    expect(row.parentJobId).toBe(original.jobId);
  });
});

describe("AC4 -- who and when", () => {
  test("AC4: a job that is not completed answers 409; a contractor gets 403", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = await signIn(app, "bob@idelta.com.au");
    const original = await completedOriginal(db);
    const open = await raise(app, mike, original.reference);
    const notCompleted = await callback(mike, open, { description: "x" });
    expect(notCompleted.status).toBe(409);
    expect(await db.job.count({ where: { parentJobId: original.jobId } })).toBe(1);
    const forbidden = await callback(bob, original.reference, { description: "x" });
    expect(forbidden.status).toBe(403);
    expect(await db.job.count({ where: { parentJobId: original.jobId } })).toBe(1);
  });
});

describe("AC5 -- the links on Mike's page", () => {
  test("AC5: Callback on on the callback, Callbacks oldest first on the original, and the two flags", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const original = await completedOriginal(db);
    const first = await raise(app, mike, original.reference, "One.");
    await db.job.update({ where: { reference: first }, data: { status: "completed" } });
    const second = await raise(app, mike, first, "Two.");

    const root = await detail(mike, original.reference);
    expect(root).toMatchObject({ callbackOn: null, callbacks: [first, second], canRaiseCallback: true, canMarkNoShow: false });
    const child = await detail(mike, first);
    expect(child).toMatchObject({ callbackOn: original.reference, callbacks: [], canRaiseCallback: true });
    const open = await detail(mike, second);
    expect(open).toMatchObject({ callbackOn: original.reference, canRaiseCallback: false, canMarkNoShow: false });
  });
});

describe("AC5a -- the original, read-only", () => {
  const original = (cookie: string, reference: string) =>
    request(app).get(`/api/contractor/jobs/${reference}/original`).set("Cookie", cookie);

  test("AC5a: Bob sees only problem, finished day, work summary and parts -- no prices, time, name or customer", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = await signIn(app, "bob@idelta.com.au");
    const first = await completedOriginal(db);
    const ref = await raise(app, mike, first.reference);
    await acceptCallback(db, ref);

    const res = await original(bob, ref);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reference: first.reference,
      description: "The mixer tap in the kitchen leaks.",
      finished: expect.stringMatching(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/) as string,
      workSummary: "Replaced the cartridge.\nTested for leaks.",
      parts: [{ name: "Caroma cartridge", description: "", qty: 1 }],
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Sarah|Bob|Dave|unitPrice|lineTotal|amount|timeEntries|billedHours/);
  });

  test("AC5a: the same works when Dave did the original", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = await signIn(app, "bob@idelta.com.au");
    const first = await completedOriginal(db, "CON-021");
    const ref = await raise(app, mike, first.reference);
    await db.job.update({ where: { reference: ref }, data: { serviceTypeId: (await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } })).id } });
    await acceptCallback(db, ref);
    const res = await original(bob, ref);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reference: first.reference });
    expect(JSON.stringify(res.body)).not.toContain("Dave");
  });

  test("AC5a: not found before he accepts, after he completes, after he is taken off, for a stranger, and on a normal job", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = await signIn(app, "bob@idelta.com.au");
    const dave = await signIn(app, "dave@idelta.com.au");
    const first = await completedOriginal(db);
    const ref = await raise(app, mike, first.reference);

    // Before he accepts: dispatched only.
    const job = await db.job.findUniqueOrThrow({ where: { reference: ref } });
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const waiting = await db.assignment.create({
      data: { jobId: job.id, contractorId: bobRow.id, specialtyId: bobRow.specialties[0]?.id ?? "", status: "assigned", proposedSlot: new Date("2026-10-07T00:00:00.000Z") },
    });
    expect((await original(bob, ref)).status).toBe(404);

    await db.assignment.update({ where: { id: waiting.id }, data: { status: "accepted" } });
    expect((await original(bob, ref)).status).toBe(200);
    expect((await original(dave, ref)).status).toBe(404);

    await db.assignment.update({ where: { id: waiting.id }, data: { status: "cancelled" } });
    expect((await original(bob, ref)).status).toBe(404);
    await db.assignment.update({ where: { id: waiting.id }, data: { status: "completed" } });
    expect((await original(bob, ref)).status).toBe(404);

    // A normal job has no original; an unknown reference is not found either.
    expect((await original(bob, first.reference)).status).toBe(404);
    expect((await original(bob, "JOB-9999")).status).toBe(404);
  });
});
