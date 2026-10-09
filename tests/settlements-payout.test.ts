// Feature 6003 -- settlement run: the draft email, the payout run, Mark paid
//
// AC4   the draft email carries the CINV reference, the period, "approve it by [day before pay
//       day] to be paid on [pay day]" and the office phone - no amount, no job count - with one
//       button "Review and approve" opening /approve/<token>
// AC9   Ready to pay lists approved unpaid invoices only (drafts are under Awaiting), with the
//       count and total; the CSV has one row per invoice: Contractor, BSB, Account, Amount, CINV
// AC10  Mark paid sets paid, paidAt + paidByUserId, paymentReference = the CINV, moves it to Paid
//       and sends the "Payout sent" email (CINV, period, account ending, the business-day line,
//       the office phone - no amount, job count, bank reference or date - and "See the
//       breakdown"); a second Mark paid is refused
// AC12  the drill-down shows the invoice lines and working; Not yet invoiced lists each
//       contractor's unswept work with the Monday it will be invoiced and the pay day after
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { MONDAY_12_OCT, MONDAY_19_OCT, completedVisit, settlementApp, signIn } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { runWeekly } from "../src/settlements/sweep.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
let mike: string;
let bob: string;
const email = recordingAdapter("test-email-6003", "email");

beforeAll(() => {
  db = testClient();
  app = settlementApp(db);
  registerProvider(email);
});

afterEach(async () => {
  await resetReferenceSequences(db);
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
  bob = await signIn(app, "bob@idelta.com.au");
});

async function bobsWeek(): Promise<void> {
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-15", hours: 1.5 });
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-17", hours: 1 });
}

async function approveAll(): Promise<void> {
  const drafts = await db.contractorSettlement.findMany({ where: { status: "draft" }, include: { contractor: true } });
  for (const draft of drafts) {
    const registered = draft.contractor.gstRegistered === true;
    await db.contractorSettlement.update({
      where: { id: draft.id },
      data: { status: "approved", approvedAt: new Date(), contractorGstRegistered: registered },
    });
  }
}

async function officePhone(): Promise<string> {
  return (await db.platformSettings.findFirstOrThrow()).operatorPhone;
}

interface OpsList {
  view: string;
  facts: { readyCount: number; readyTotal: number; payDay: string };
  counts: { ready: number; awaiting: number; upcoming: number; paid: number };
  rows: {
    reference: string;
    contractor: { code: string; name: string; firstName: string };
    period: string;
    jobs: number;
    amount: number;
    bsb: string | null;
    account: string | null;
    paidBy: string | null;
    paidLabel: string | null;
  }[];
  upcoming: { contractor: { code: string }; jobs: number; adjustments: number; amount: number; invoicedOn: string; paidOn: string }[];
  nextCursor: string | null;
}

const list = async (view: string, cookie = mike, after?: string): Promise<request.Response> =>
  request(app).get(`/api/settlements?view=${view}${after === undefined ? "" : `&after=${after}`}`).set("Cookie", cookie);

describe("AC4 -- the draft email", () => {
  test("AC4: names the invoice, the period and the two dates and the office phone - no amount, no job count - with one Review and approve button", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    expect(await drainOnce(db)).toBe(1);

    const [sent] = email.sent;
    expect(sent?.to).toBe("bob@idelta.com.au");
    expect(sent?.message.subject).toBe("Your invoice CINV-518 is awaiting your approval");
    const text = sent?.message.text ?? "";
    expect(text).toContain("Hi Bob,");
    expect(text).toContain("Your invoice CINV-518 for 12 Oct - 18 Oct 2026 is ready.");
    expect(text).toContain("Please approve it by Tue 20 Oct to be paid on Wed 21 Oct.");
    expect(text).toContain(`ring the office on ${await officePhone()} before approving`);
    expect(text).not.toContain("$");
    expect(text).not.toMatch(/\b3 jobs?\b/);
    expect(text).toMatch(/Review and approve: https:\/\/idelta\.com\.au\/approve\/[\w-]+/);

    const html = sent?.message.html ?? "";
    expect(html).toContain(">Review and approve</a>");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/href="https:\/\/idelta\.com\.au\/approve\/[\w-]+"/);
  });

  test("AC4: the link in the email opens the invoice", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    await drainOnce(db);
    const token = /\/approve\/([\w-]+)/.exec(email.sent[0]?.message.text ?? "")?.[1] ?? "";
    const res = await request(app).get(`/api/approve/${token}`);
    expect(res.status).toBe(200);
    expect((res.body as { invoice: { reference: string } }).invoice.reference).toBe("CINV-518");
  });

  test("AC4: it is asked once per draft - the key is settlement_draft:settlement:<id>:email", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    const draft = await db.contractorSettlement.findFirstOrThrow();
    const row = await db.notification.findFirstOrThrow({ where: { type: "settlement_draft" } });
    expect(row).toMatchObject({
      idempotencyKey: `settlement_draft:settlement:${draft.id}:email`,
      recipientType: "contractor",
      relatedType: "settlement",
      relatedId: draft.id,
      category: "transactional",
    });
  });
});

describe("AC9 -- the payout run", () => {
  test("AC9: Ready to pay lists approved, unpaid invoices only, with the count and the total", async () => {
    await bobsWeek();
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-13", hours: 2 });
    await runWeekly(db, MONDAY_19_OCT);
    // Bob approves; Dave's stays a draft.
    await db.contractorSettlement.updateMany({
      where: { contractor: { code: "CON-014" } },
      data: { status: "approved", approvedAt: new Date(), contractorGstRegistered: true },
    });

    const ready = (await list("ready")).body as OpsList;
    expect(ready.facts.readyCount).toBe(1);
    expect(ready.facts.readyTotal).toBe(122_750);
    expect(ready.counts).toMatchObject({ ready: 1, awaiting: 1, paid: 0 });
    expect(ready.rows.map((row) => [row.reference, row.contractor.name, row.bsb, row.account, row.amount, row.jobs])).toEqual([
      ["CINV-518", "Bob Reilly", "066-000", "12345678", 122_750, 3],
    ]);

    const awaiting = (await list("awaiting")).body as OpsList;
    expect(awaiting.rows.map((row) => [row.reference, row.contractor.name, row.amount])).toEqual([["CINV-519", "Dave Hurst", 36_500]]);
  });

  test("AC9: Download CSV gives one row per invoice: Contractor, BSB, Account, Amount, CINV reference", async () => {
    await bobsWeek();
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-13", hours: 2 });
    await runWeekly(db, MONDAY_19_OCT);
    await approveAll();
    await completedVisit(db, { contractorCode: "CON-030", day: "2026-10-13", hours: 1 });
    await runWeekly(db, new Date("2026-10-25T22:30:00.000Z")); // Priya's draft stays out of the run

    const res = await request(app).get("/api/settlements/ready.csv").set("Cookie", mike);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="payout-run-\d{4}-\d{2}-\d{2}\.csv"$/);
    // The page reads the file name across origins, so the header is exposed to it.
    expect(res.headers["access-control-expose-headers"]).toBe("Content-Disposition");
    expect((res.text ?? "").split("\r\n")).toEqual([
      "Contractor,BSB,Account,Amount,CINV reference",
      "B Reilly,066-000,12345678,1227.50,CINV-518",
      "D Hurst,066-102,22110021,365.00,CINV-519",
      "",
    ]);
  });

  test("AC9: a paid invoice is no longer in the run or the CSV", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    await approveAll();
    await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike).expect(200);
    expect(((await list("ready")).body as OpsList).rows).toEqual([]);
    expect((await request(app).get("/api/settlements/ready.csv").set("Cookie", mike)).text).toBe("Contractor,BSB,Account,Amount,CINV reference\r\n");
  });

  test("the lists page 50 at a time with a cursor, newest paid first", async () => {
    const bobRow = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const mikeRow = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    await db.contractorSettlement.createMany({
      data: Array.from({ length: 51 }, (_, index) => ({
        reference: `CINV-9${String(index).padStart(2, "0")}`,
        contractorId: bobRow.id,
        periodStart: new Date("2026-01-05T00:00:00.000Z"),
        periodEnd: new Date("2026-01-11T00:00:00.000Z"),
        breakdownByTrade: [],
        materialsAmount: 0,
        totalAmount: 1000,
        status: "paid" as const,
        paidAt: new Date(Date.UTC(2026, 0, 14, 0, index)),
        paidByUserId: mikeRow.id,
      })),
    });
    const first = (await list("paid")).body as OpsList;
    expect(first.rows).toHaveLength(50);
    expect(first.counts.paid).toBe(51);
    expect(first.rows[0]?.reference).toBe("CINV-950");
    expect(first.nextCursor).not.toBeNull();
    const second = (await list("paid", mike, first.nextCursor ?? "")).body as OpsList;
    expect(second.rows.map((row) => row.reference)).toEqual(["CINV-900"]);
    expect(second.nextCursor).toBeNull();
  });

  test("the ops screen is for ops and owner: a contractor is refused, a visitor is told to log in", async () => {
    await request(app).get("/api/settlements").set("Cookie", bob).expect(403);
    await request(app).get("/api/settlements/ready.csv").set("Cookie", bob).expect(403);
    await request(app).get("/api/settlements").expect(401);
  });
});

describe("AC10 -- Mark paid", () => {
  async function approvedBob(): Promise<string> {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    await approveAll();
    return (await db.contractorSettlement.findFirstOrThrow()).id;
  }

  test("AC10: sets paid, the audit pair and the bank reference, and moves it to Paid", async () => {
    const id = await approvedBob();
    const res = await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reference: "CINV-518", status: "paid" });

    const settlement = await db.contractorSettlement.findUniqueOrThrow({ where: { id } });
    const mikeRow = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    expect(settlement).toMatchObject({ status: "paid", paidByUserId: mikeRow.id, paymentReference: "CINV-518" });
    expect(settlement.paidAt).not.toBeNull();

    const paid = (await list("paid")).body as OpsList;
    expect(paid.rows.map((row) => [row.reference, row.paidBy])).toEqual([["CINV-518", "Mike"]]);
    expect(paid.counts).toMatchObject({ ready: 0, paid: 1 });
  });

  test("AC10: Bob gets the Payout sent email - CINV and period, account ending, the business-day line, the office phone, See the breakdown", async () => {
    const id = await approvedBob();
    await drainOnce(db); // the draft email goes first
    email.reset();
    await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike).expect(200);
    expect(await drainOnce(db)).toBe(1);

    const [sent] = email.sent;
    expect(sent?.to).toBe("bob@idelta.com.au");
    expect(sent?.message.subject).toBe("You've been paid - CINV-518");
    const text = sent?.message.text ?? "";
    expect(text).toContain("We've paid your invoice CINV-518 (12 Oct - 18 Oct 2026) into your account ending 5678.");
    expect(text).toContain("It can take up to a business day to show.");
    expect(text).toContain(`ring the office on ${await officePhone()}`);
    expect(text).toContain("See the breakdown: https://idelta.com.au/contractor/payouts/CINV-518");
    // No amount, no job count, no date.
    expect(text).not.toContain("$");
    expect(text).not.toMatch(/\bjobs?\b/i);
    expect(text).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
    expect(sent?.message.html).toContain(">See the breakdown</a>");

    const row = await db.notification.findFirstOrThrow({ where: { type: "payout_sent" } });
    expect(row).toMatchObject({ idempotencyKey: `payout_sent:settlement:${id}:email`, recipientType: "contractor", relatedType: "settlement", relatedId: id });
  });

  test("AC10: a second Mark paid is refused - 409 'Already paid.' - and sends nothing more", async () => {
    await approvedBob();
    await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike).expect(200);
    const again = await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "Already paid." });
    expect(await db.notification.count({ where: { type: "payout_sent" } })).toBe(1);
  });

  test("AC10: only an approved invoice can be marked paid - a draft is refused, a replaced one says so", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    const draft = await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike);
    expect(draft.status).toBe(409);
    expect(draft.body).toEqual({ error: "Only an approved invoice can be marked paid." });
    await db.contractorSettlement.updateMany({ data: { status: "superseded", supersededAt: new Date() } });
    expect((await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike)).body).toEqual({ error: "This invoice was replaced." });
    await request(app).post("/api/settlements/CINV-404/mark-paid").set("Cookie", mike).expect(404);
  });

  test("AC10: a contractor cannot mark anything paid", async () => {
    await approvedBob();
    await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", bob).expect(403);
    expect((await db.contractorSettlement.findFirstOrThrow()).status).toBe("approved");
  });

  test("a contractor with no bank account is refused before anything is written", async () => {
    await approvedBob();
    await db.contractor.update({ where: { code: "CON-014" }, data: { payoutAccountNo: null } });
    const res = await request(app).post("/api/settlements/CINV-518/mark-paid").set("Cookie", mike);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe("Add Bob's bank details first.");
    expect((await db.contractorSettlement.findFirstOrThrow()).status).toBe("approved");
  });
});

describe("AC12 -- the drill-down and Not yet invoiced", () => {
  test("AC12: a Ready, Awaiting or Paid row opens to the same invoice lines and working", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    for (const status of ["draft", "approved", "paid"] as const) {
      if (status === "approved") await approveAll();
      if (status === "paid") await db.contractorSettlement.updateMany({ data: { status: "paid", paidAt: new Date() } });
      const res = await request(app).get("/api/settlements/CINV-518").set("Cookie", mike);
      expect(res.status).toBe(200);
      const body = res.body as {
        invoice: { heading: string; lines: { day: string; amount: number; weekend: boolean; working: { kind: string; extraHours?: number } }[]; total: number; weekendMultiplier: number };
        contractor: { name: string };
        amount: number;
      };
      expect(body.contractor.name).toBe("Bob Reilly");
      expect(body.invoice.heading).toBe(status === "draft" ? "Draft invoice" : "Tax Invoice");
      expect(body.invoice.lines.map((line) => [line.day, line.amount, line.weekend])).toEqual([
        ["Wed 14 Oct", 50_000, false],
        ["Thu 15 Oct", 27_500, false],
        ["Sat 17 Oct", 30_000, true],
      ]);
      expect(body.invoice.lines[0]?.working).toMatchObject({ kind: "visit", extraHours: 2 });
      expect(body.invoice.total).toBe(122_750);
      expect(body.amount).toBe(122_750);
    }
    await request(app).get("/api/settlements/CINV-404").set("Cookie", mike).expect(404);
    await request(app).get("/api/settlements/CINV-518").set("Cookie", bob).expect(403);
  });

  test("AC12: Not yet invoiced lists each contractor's unswept work with the Monday it will be invoiced and the pay day after", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-15", hours: 1 });
    const mikeRow = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
    await db.contractorPayAdjustment.create({ data: { contractorId: dave.id, amount: 2500, reason: "Parking", createdByUserId: mikeRow.id } });

    const res = (await list("upcoming")).body as OpsList;
    expect(res.counts.upcoming).toBe(2);
    expect(res.rows).toEqual([]);
    expect(res.upcoming.map((row) => [row.contractor.code, row.jobs, row.adjustments, row.amount])).toEqual([
      ["CON-014", 1, 0, 50_000 + 4500],
      ["CON-021", 1, 1, 21_000 + 2500],
    ]);
    for (const row of res.upcoming) {
      expect(row.invoicedOn).toMatch(/^Mon \d{1,2} [A-Z][a-z]{2}$/);
      expect(row.paidOn).toMatch(/^Wed \d{1,2} [A-Z][a-z]{2}$/);
    }
  });

  test("work already on an invoice is not in Not yet invoiced", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    expect(((await list("upcoming")).body as OpsList).upcoming).toEqual([]);
  });

  test("the first fact is the pay day, from the settings", async () => {
    const res = (await list("ready")).body as OpsList;
    expect(res.facts.payDay).toMatch(/^Wed \d{1,2} [A-Z][a-z]{2}$/);
    await db.platformSettings.updateMany({ data: { payoutDay: "fri" } });
    expect(((await list("ready")).body as OpsList).facts.payDay).toMatch(/^Fri /);
  });
});

describe("the run for an earlier week stays out of the payout until approved", () => {
  test("a draft from last week never appears in Ready to pay", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-07", hours: 1 });
    await runWeekly(db, MONDAY_12_OCT);
    expect(((await list("ready")).body as OpsList).rows).toEqual([]);
    expect(((await list("awaiting")).body as OpsList).rows).toHaveLength(1);
  });
});
