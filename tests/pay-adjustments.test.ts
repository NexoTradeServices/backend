// Feature 6007 -- pay adjustments (AC10) and the Not yet invoiced tab (AC11)
//
// AC10 Mike adds a pay adjustment (Bob, $75.00, "Missing hour on JOB-1042", job JOB-1042): with no
//      draft it waits for the run; with Bob's unapproved draft the draft rebuilds with the line and is
//      resent; with Bob's week approved it waits for next week; the dialog's muted line says which before
//      Mike presses Add. Amount must be above 0, reason required, an unknown job refused.
// AC11 the Not yet invoiced tab shows Work, Adjustments and Payout per contractor; "Job corrected since" is gone
//
// No test reaches Mailjet.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { correctApp, sarahsJob, settle, signIn } from "./helpers/correct.js";
import { MONDAY_19_OCT, completedVisit } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { drainOnce } from "../src/notifications/index.js";
import { runWithLabel } from "../src/test-data/label.js";
import { addPayAdjustment, landingOf } from "../src/settlements/adjustments.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { runWeekly } from "../src/settlements/sweep.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
let mike: string;
let bobId: string;
const email = recordingAdapter("test-email-6007a", "email");

beforeAll(() => {
  db = testClient();
  app = correctApp(db);
  registerProvider(email);
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
  mike = await signIn(app, "mike@idelta.com.au");
  bobId = (await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } })).id;
});

afterEach(async () => {
  await resetReferenceSequences(db);
});

function add(body: object, cookie = mike): request.Test {
  return request(app).post("/api/settlements/adjustments").set("Cookie", cookie).send(body);
}

function landing(contractorId = bobId): request.Test {
  return request(app).get(`/api/settlements/adjustments/landing?contractorId=${contractorId}`).set("Cookie", mike);
}

const GOOD = () => ({ contractorId: bobId, amount: 7500, reason: "Missing hour on JOB-1042", job: "JOB-1042" });

describe("AC10 -- adding a pay adjustment", () => {
  test("AC10: with no draft it is saved against the job, by Mike, and waits for the run", async () => {
    const res = await add(GOOD());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ contractorFirstName: "Bob", landing: "next_run" });
    const row = await db.contractorPayAdjustment.findFirstOrThrow({ include: { job: true } });
    expect(row).toMatchObject({ amount: 7500, kind: "adjustment", reason: "Missing hour on JOB-1042", settlementId: null, contractorId: bobId });
    expect(row.job?.reference).toBe("JOB-1042");
    expect(row.createdByUserId).toBe((await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } })).id);

    // The Monday run sweeps it, as its own line.
    await runWeekly(db, MONDAY_19_OCT);
    const draft = await db.contractorSettlement.findFirstOrThrow();
    expect(draft.adjustmentsAmount).toBe(7500);
    expect((await db.contractorPayAdjustment.findFirstOrThrow()).settlementId).toBe(draft.id);
  });

  test("AC10: the job is optional, and its reference may be typed in lower case", async () => {
    await add({ contractorId: bobId, amount: 2000, reason: "Parking" }).expect(201);
    await add({ contractorId: bobId, amount: 2000, reason: "Parking again", job: " job-1042 " }).expect(201);
    const rows = await db.contractorPayAdjustment.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.jobId !== null)).toEqual([false, true]);
  });

  test("AC10: with Bob's unapproved draft the draft rebuilds with the line and is resent", async () => {
    await sarahsJob(db);
    const draft = await settle(db, "draft");
    expect(await db.notification.count({ where: { type: "settlement_draft" } })).toBe(1);

    const res = await add(GOOD());
    expect(res.status).toBe(201);
    expect((res.body as { landing: string }).landing).toBe("draft");
    expect((await db.contractorSettlement.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("superseded");
    const fresh = await db.contractorSettlement.findFirstOrThrow({ where: { status: "draft" } });
    expect(fresh).toMatchObject({ adjustmentsAmount: 7500, totalAmount: 80_000 + 7500 });
    expect(await db.notification.count({ where: { type: "settlement_draft", relatedId: fresh.id } })).toBe(1);
    await drainOnce(db);
    expect(email.sent.filter((m) => m.to === "bob@idelta.com.au")).toHaveLength(2);
  });

  test("AC10: with Bob's week approved it waits for next week - the approved invoice is never touched", async () => {
    await sarahsJob(db);
    const approved = await settle(db, "approved");
    const before = await db.contractorSettlement.findUniqueOrThrow({ where: { id: approved.id } });
    const res = await add(GOOD());
    expect((res.body as { landing: string }).landing).toBe("approved");
    const after = await db.contractorSettlement.findUniqueOrThrow({ where: { id: approved.id } });
    expect(after).toEqual(before);
    expect(await db.contractorSettlement.count()).toBe(1);
    expect((await db.contractorPayAdjustment.findFirstOrThrow()).settlementId).toBeNull();
  });

  test("AC10: the dialog's muted line says which, before Mike presses Add", async () => {
    expect((await landing()).body).toEqual({ landing: "next_run", sentence: "Goes on Bob's next payout - invoiced Mon 19 Oct." });
    await sarahsJob(db);
    await settle(db, "draft");
    const draft = (await landing()).body as { landing: string; sentence: string };
    expect(draft.landing).toBe("draft");
    expect(draft.sentence).toMatch(/^Goes on Bob's draft for \w{3} \d{1,2} \w{3} - their draft is resent to approve\.$/);
    await db.contractorSettlement.updateMany({ data: { status: "approved", approvedAt: MONDAY_19_OCT, contractorGstRegistered: true } });
    expect((await landing()).body).toEqual({ landing: "approved", sentence: "Bob has approved this week - it goes on next week's draft." });
  });
});

describe("AC10 -- a browser test's request never meets a draft that is not its own", () => {
  test("with the e2e label, an unlabelled draft of Bob's is neither reported nor rebuilt - the line waits for the run", async () => {
    await sarahsJob(db);
    const draft = await settle(db, "draft");
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const landed = await runWithLabel("e2e", async () => (await landingOf(db, bobId, new Date())).landing);
    expect(landed).toBe("next_run");
    const result = await runWithLabel("e2e", () => addPayAdjustment(db, GOOD(), mikeUser.id, new Date()));
    expect(result).toMatchObject({ ok: true, landing: "next_run", draft: null });
    expect((await db.contractorSettlement.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("draft");
    expect(await db.contractorSettlement.count()).toBe(1);
    expect((await db.contractorPayAdjustment.findFirstOrThrow()).testData).toBe("e2e");
  });
});

describe("AC10 -- the refusals", () => {
  test.each([
    [{ amount: 0 }, "Enter an amount more than $0.", "amount"],
    [{ amount: -500 }, "Enter an amount more than $0.", "amount"],
    [{ amount: 12.5 }, "Enter an amount more than $0.", "amount"],
    [{ amount: "75" }, "Enter an amount more than $0.", "amount"],
    [{ reason: "   " }, "Required.", "reason"],
    [{ job: "JOB-9999" }, "No job with that number.", "job"],
    [{ contractorId: "nobody" }, "Pick a contractor.", "contractor"],
    [{ contractorId: "" }, "Required.", "contractor"],
  ])("AC10: %j is refused with its message and nothing is saved", async (change, error, field) => {
    const res = await add({ ...GOOD(), ...change });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error, field });
    expect(await db.contractorPayAdjustment.count()).toBe(0);
  });

  test("AC10: only ops reach it - Bob and a signed-out visitor do not", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await add(GOOD(), bob).expect(403);
    await request(app).post("/api/settlements/adjustments").send(GOOD()).expect(401);
    await request(app).get(`/api/settlements/adjustments/landing?contractorId=${bobId}`).set("Cookie", bob).expect(403);
    expect(await db.contractorPayAdjustment.count()).toBe(0);
  });

  test("AC10: the landing line for an unknown contractor is not found", async () => {
    await landing("nobody").expect(404);
  });
});

describe("AC11 -- Not yet invoiced: Work, Adjustments and Payout", () => {
  interface Upcoming {
    contractor: { code: string; firstName: string };
    jobs: number;
    work: number;
    adjustments: number;
    payout: number;
  }

  test("AC11: each contractor's Work, net Adjustments (a waiting deduction shows negative) and Payout", async () => {
    const bobsJob = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-15", hours: 1 });
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
    await db.contractorPayAdjustment.create({ data: { contractorId: dave.id, amount: 2500, reason: "Parking", createdByUserId: mikeUser.id } });
    await db.contractorPayAdjustment.create({
      data: { contractorId: bobId, amount: -10_000, kind: "correction", reason: "Logged 5h, worked 2h.", jobId: bobsJob.jobId, createdByUserId: mikeUser.id },
    });

    const res = await request(app).get("/api/settlements?view=upcoming").set("Cookie", mike).expect(200);
    const rows = (res.body as { upcoming: Upcoming[] }).upcoming;
    expect(rows.map((row) => [row.contractor.code, row.jobs, row.work, row.adjustments, row.payout])).toEqual([
      ["CON-014", 1, 50_000, -10_000, 50_000 - 10_000 + 4500],
      ["CON-021", 1, 21_000, 2500, 21_000 + 2500],
    ]);
  });

  test("AC11: the Awaiting list no longer carries a 'corrected since' flag at all", async () => {
    await sarahsJob(db);
    await settle(db, "draft");
    const res = await request(app).get("/api/settlements?view=awaiting").set("Cookie", mike).expect(200);
    const row = (res.body as { rows: Record<string, unknown>[] }).rows[0];
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("correctedSince");
    expect(row).toHaveProperty("gstNotRecorded");
    const detail = await request(app).get(`/api/settlements/${String(row?.["reference"])}`).set("Cookie", mike).expect(200);
    expect(detail.body).not.toHaveProperty("correctedSince");
  });
});

describe("the database keeps the amount rule by kind", () => {
  async function insert(kind: "adjustment" | "correction", amount: number): Promise<unknown> {
    const mikeUser = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    return db.contractorPayAdjustment.create({ data: { contractorId: bobId, amount, kind, reason: "x", createdByUserId: mikeUser.id } });
  }

  test("an adjustment is above zero; a correction is plus or minus, never zero", async () => {
    await expect(insert("adjustment", 0)).rejects.toThrow();
    await expect(insert("adjustment", -100)).rejects.toThrow();
    await expect(insert("correction", 0)).rejects.toThrow();
    await expect(insert("correction", -100)).resolves.toBeDefined();
    await expect(insert("correction", 100)).resolves.toBeDefined();
    await expect(insert("adjustment", 100)).resolves.toBeDefined();
  });

  test("an invoice may name the invoice it replaces, and a correction the row it continues", async () => {
    const job = await sarahsJob(db);
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE (table_name = 'Invoice' AND column_name = 'replacesInvoiceId')
          OR (table_name = 'ContractorPayAdjustment' AND column_name IN ('kind', 'carriedFromId'))`;
    expect(columns.map((row) => row.column_name).sort()).toEqual(["carriedFromId", "kind", "replacesInvoiceId"]);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: job.invoiceId } })).replacesInvoiceId).toBeNull();
  });
});
