// Feature 6003 -- settlement run: the contractor's own Settlements
//
// AC11  Bob's Settlements shows his next payout ("You'll be paid $X for N jobs on [pay day]"),
//       counting unswept visits and unswept pay adjustments, and his invoices - never a
//       superseded one - with their tags; opening one shows the invoice with each job's working;
//       Bob cannot open Dave's invoice; the ops-only routes are closed to him
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { MONDAY_12_OCT, MONDAY_19_OCT, completedVisit, settlementApp, signIn } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { runWeekly } from "../src/settlements/sweep.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
let bob: string;
let dave: string;
let mike: string;

beforeAll(() => {
  db = testClient();
  app = settlementApp(db);
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  bob = await signIn(app, "bob@idelta.com.au");
  dave = await signIn(app, "dave@idelta.com.au");
  mike = await signIn(app, "mike@idelta.com.au");
});

interface Mine {
  nextPayout: { amount: number; jobs: number; adjustments: number; plusGst: boolean; payDay: string; invoicedOn: string };
  settlements: { reference: string; status: string; tag: string; period: string; amount: number; dateLine: string }[];
  nextCursor: string | null;
}

const mine = async (cookie: string): Promise<Mine> => (await request(app).get("/api/contractor/settlements").set("Cookie", cookie).expect(200)).body as Mine;

describe("AC11 -- Bob's Settlements", () => {
  test("AC11: next payout counts unswept visits, parts and unswept pay adjustments, 'plus GST' for a registered contractor", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-15", hours: 1.5 });
    const mikeRow = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.contractorPayAdjustment.create({ data: { contractorId: bobRow.id, amount: 2500, reason: "Parking", createdByUserId: mikeRow.id } });

    const res = await mine(bob);
    expect(res.nextPayout).toMatchObject({ amount: 50_000 + 27_500 + 4500 + 2500, jobs: 2, adjustments: 1, plusGst: true });
    expect(res.nextPayout.payDay).toMatch(/^Wed \d{1,2} [A-Z][a-z]{2}$/);
    expect(res.settlements).toEqual([]);
    // Dave has nothing waiting, and is not registered.
    expect((await mine(dave)).nextPayout).toMatchObject({ amount: 0, jobs: 0, plusGst: false });
  });

  test("AC11: his invoices are newest first with their tags and dates - and never a superseded one", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-07", hours: 1 });
    await runWeekly(db, MONDAY_12_OCT);
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3 });
    await runWeekly(db, MONDAY_19_OCT); // supersedes CINV-518, makes CINV-519

    const res = await mine(bob);
    expect(res.settlements.map((row) => [row.reference, row.status, row.tag, row.period])).toEqual([
      ["CINV-519", "draft", "Awaiting your approval", "5 Oct - 18 Oct 2026"],
    ]);
    expect(res.settlements[0]?.amount).toBe(Math.round((20_000 + 50_000) * 1.1));
    expect(res.settlements[0]?.dateLine).toMatch(/^To be paid on Wed \d{1,2} [A-Z][a-z]{2}$/);

    await db.contractorSettlement.updateMany({ where: { status: "draft" }, data: { status: "approved", approvedAt: new Date(), contractorGstRegistered: true, gstAmount: 7000 } });
    expect((await mine(bob)).settlements[0]).toMatchObject({ tag: "Approved", amount: 77_000 });
    await db.contractorSettlement.updateMany({ where: { status: "approved" }, data: { status: "paid", paidAt: new Date("2026-10-21T03:00:00.000Z") } });
    expect((await mine(bob)).settlements[0]).toMatchObject({ tag: "Paid", dateLine: "Paid on 21/10/26" });
  });

  test("AC11: opening one of his invoices shows it with each job's working", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-17", hours: 1 });
    await runWeekly(db, MONDAY_19_OCT);
    const res = await request(app).get("/api/contractor/settlements/CINV-518").set("Cookie", bob);
    expect(res.status).toBe(200);
    const body = res.body as {
      invoice: { heading: string; lines: { jobReference: string; weekend: boolean; working: { kind: string; calloutRate?: number; extraHours?: number; standardRate?: number; multiplier?: number } }[]; total: number };
    };
    expect(body.invoice.heading).toBe("Tax Invoice");
    expect(body.invoice.lines[0]?.working).toEqual({ kind: "visit", calloutRate: 20_000, extraHours: 2, standardRate: 15_000, extraTotal: 30_000, multiplier: 1 });
    expect(body.invoice.lines[1]).toMatchObject({ weekend: true, working: { calloutRate: 30_000, multiplier: 1.5 } });
    expect(body.invoice.total).toBe(Math.round((50_000 + 30_000) * 1.1) + 4500);
  });

  test("AC11: Bob cannot open Dave's invoice - it reads as not found, and so does a replaced one", async () => {
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-13", hours: 2 });
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1 });
    await runWeekly(db, MONDAY_19_OCT);
    const daves = (await db.contractorSettlement.findFirstOrThrow({ where: { contractor: { code: "CON-021" } } })).reference;
    const bobs = (await db.contractorSettlement.findFirstOrThrow({ where: { contractor: { code: "CON-014" } } })).reference;
    await request(app).get(`/api/contractor/settlements/${daves}`).set("Cookie", bob).expect(404);
    await request(app).get(`/api/contractor/settlements/${daves}`).set("Cookie", dave).expect(200);
    await request(app).get(`/api/contractor/settlements/${bobs}`).set("Cookie", bob).expect(200);
    await db.contractorSettlement.updateMany({ where: { reference: bobs }, data: { status: "superseded", supersededAt: new Date() } });
    await request(app).get(`/api/contractor/settlements/${bobs}`).set("Cookie", bob).expect(404);
    await request(app).get("/api/contractor/settlements/CINV-404").set("Cookie", bob).expect(404);
  });

  test("AC11: the contractor routes are closed to ops and to visitors; the ops-only routes are closed to Bob", async () => {
    await request(app).get("/api/contractor/settlements").set("Cookie", mike).expect(403);
    await request(app).get("/api/contractor/settlements").expect(401);
    await request(app).get("/api/settlements").set("Cookie", bob).expect(403);
    await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", bob).expect(403);
  });
});
