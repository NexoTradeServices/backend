// Feature 6003 -- settlement run: the period and the sweep
//
// AC2  the Monday 6:00am run sweeps each contractor's visits with money on them (completed by
//      completedAt, no-show call-outs by cancelledAt) up to the Sunday just ended, plus unswept
//      pay adjustments, into ONE draft; nothing -> no draft, no email; a second pass changes
//      nothing; a run missed while down happens on the next pass
// AC3  Bob (GST registered): Wed $500 + $45 part, Thu $275, Sat $300 at T1.5 -> a Tax Invoice with
//      Subtotal $1,075, GST $107.50, materials $45, Total $1,227.50; Dave (not registered) gets a
//      plain Invoice with no Subtotal or GST
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { MONDAY_12_OCT, MONDAY_19_OCT, completedVisit, noShowCallout } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { buildInvoiceView, loadSettlementForView } from "../src/settlements/invoice-view.js";
import { runWeekly } from "../src/settlements/sweep.js";
import { nextPayout } from "../src/settlements/service.js";
import { dayLabel, nextRunMonday, payDayAfter, payDayFor, periodFor, periodLabel } from "../src/settlements/calendar.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

beforeAll(() => {
  db = testClient();
});

afterEach(async () => {
  await resetReferenceSequences(db);
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
});

const WEEKLY = { timezone: "Australia/Perth", payoutCycle: "weekly", payoutDay: "wed" } as const;
const FORTNIGHTLY = { ...WEEKLY, payoutCycle: "fortnightly" } as const;

/** Bob's week of Sarah's jobs: Wed 14 Oct 3.0h with a $45 part, Thu 15 Oct 1.5h, Sat 17 Oct 1.0h. */
async function bobsWeek(): Promise<void> {
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-15", hours: 1.5 });
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-17", hours: 1 });
}

async function settlementsOf(code: string) {
  return db.contractorSettlement.findMany({ where: { contractor: { code } }, orderBy: { createdAt: "asc" } });
}

describe("AC2 -- the period, on the business clock", () => {
  test("the run due at 6:30am Monday 19 Oct covers Mon 12 to Sun 18 Oct", () => {
    expect(periodFor(WEEKLY, MONDAY_19_OCT)).toEqual({ runMonday: "2026-10-19", periodStart: "2026-10-12", periodEnd: "2026-10-18" });
  });

  test("at 5:59am Monday the run has not happened yet: the period is still the week before", () => {
    const before = new Date("2026-10-18T21:59:00.000Z"); // 5:59am Perth
    expect(periodFor(WEEKLY, before)).toEqual({ runMonday: "2026-10-12", periodStart: "2026-10-05", periodEnd: "2026-10-11" });
  });

  test("on a Friday the target is the Sunday five days back", () => {
    const friday = new Date("2026-10-09T04:00:00.000Z");
    expect(periodFor(WEEKLY, friday).periodEnd).toBe("2026-10-04");
  });

  test("fortnightly counts every second Monday from Mon 5 Jan 2026, the period two weeks long", () => {
    // 12 Oct is 40 weeks on from the anchor: a run Monday. 19 Oct is not.
    expect(periodFor(FORTNIGHTLY, MONDAY_19_OCT)).toEqual({ runMonday: "2026-10-12", periodStart: "2026-09-28", periodEnd: "2026-10-11" });
    const nextRun = new Date("2026-10-25T22:30:00.000Z"); // 6:30am Mon 26 Oct
    expect(periodFor(FORTNIGHTLY, nextRun)).toEqual({ runMonday: "2026-10-26", periodStart: "2026-10-12", periodEnd: "2026-10-25" });
  });

  test("pay day: the next one, today counting; work not yet swept is paid the first pay day after the next run", () => {
    expect(dayLabel(payDayFor(WEEKLY, new Date("2026-10-15T04:00:00.000Z")))).toBe("Wed 21 Oct");
    expect(dayLabel(payDayFor(WEEKLY, new Date("2026-10-21T04:00:00.000Z")))).toBe("Wed 21 Oct");
    const thursday = new Date("2026-10-15T04:00:00.000Z");
    expect(dayLabel(nextRunMonday(WEEKLY, thursday))).toBe("Mon 19 Oct");
    expect(dayLabel(payDayAfter(WEEKLY, nextRunMonday(WEEKLY, thursday)))).toBe("Wed 21 Oct");
  });

  test("a period reads '12 Oct - 18 Oct 2026', both years when it crosses New Year", () => {
    expect(periodLabel("2026-10-12", "2026-10-18")).toBe("12 Oct - 18 Oct 2026");
    expect(periodLabel("2026-12-28", "2027-01-03")).toBe("28 Dec 2026 - 3 Jan 2027");
  });
});

describe("AC2/AC3 -- the Monday sweep", () => {
  test("AC3: Bob's week becomes ONE Tax Invoice: Subtotal $1,075, GST $107.50, materials $45, Total $1,227.50", async () => {
    await bobsWeek();
    const result = await runWeekly(db, MONDAY_19_OCT);
    expect(result.made).toHaveLength(1);

    const [settlement] = await settlementsOf("CON-014");
    expect(settlement).toMatchObject({
      reference: "CINV-518",
      status: "draft",
      materialsAmount: 4500,
      adjustmentsAmount: 0,
      totalAmount: 112_000,
      gstAmount: 10_750,
    });
    expect(settlement?.periodStart.toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(settlement?.periodEnd.toISOString().slice(0, 10)).toBe("2026-10-18");
    expect(settlement?.breakdownByTrade).toEqual([{ trade: "Plumbing", count: 3, amount: 107_500 }]);

    const members = await db.assignment.findMany({ where: { settlementId: settlement?.id } });
    expect(members).toHaveLength(3);

    const view = await buildInvoiceView(db, (await loadSettlementForView(db, { id: settlement?.id ?? "" }))!);
    expect(view.heading).toBe("Draft invoice");
    expect(view.subtotal).toBe(107_500);
    expect(view.gst).toBe(10_750);
    expect(view.materialsTotal).toBe(4500);
    expect(view.total).toBe(122_750);
    expect(view.dateLabel).toBe("Draft");
  });

  test("AC3/AC5: one pay line per job with the day and date, the weekend line flagged T1.5, each with its working", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    const [settlement] = await settlementsOf("CON-014");
    const view = await buildInvoiceView(db, (await loadSettlementForView(db, { id: settlement?.id ?? "" }))!);

    expect(view.lines.map((line) => [line.day, line.hours, line.amount, line.weekend])).toEqual([
      ["Wed 14 Oct", 3, 50_000, false],
      ["Thu 15 Oct", 1.5, 27_500, false],
      ["Sat 17 Oct", 1, 30_000, true],
    ]);
    expect(view.lines[0]?.working).toEqual({ kind: "visit", calloutRate: 20_000, extraHours: 2, standardRate: 15_000, extraTotal: 30_000, multiplier: 1 });
    expect(view.lines[2]?.working).toMatchObject({ kind: "visit", calloutRate: 30_000, extraHours: 0, multiplier: 1.5 });
    expect(view.materials).toEqual([{ jobReference: view.lines[0]?.jobReference, name: "Caroma cartridge", amount: 4500 }]);
    expect(view.weekendMultiplier).toBe(1.5);
  });

  test("AC3: Dave, not registered, gets a plain Invoice with no Subtotal or GST - and a breakdown per trade", async () => {
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-13", hours: 2, trade: "Electrical" });
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-14", hours: 1, trade: "Air conditioning" });
    await runWeekly(db, MONDAY_19_OCT);

    const [settlement] = await settlementsOf("CON-021");
    expect(settlement?.gstAmount).toBeNull();
    expect(settlement?.breakdownByTrade).toEqual([
      { trade: "Air conditioning", count: 1, amount: 21_500 },
      { trade: "Electrical", count: 1, amount: 21_000 + 15_500 },
    ]);
    const view = await buildInvoiceView(db, (await loadSettlementForView(db, { id: settlement?.id ?? "" }))!);
    expect(view.heading).toBe("Draft invoice");
    expect(view.gstRegistered).toBe(false);
    expect(view.gst).toBeNull();
    expect(view.total).toBe(58_000);
  });

  test("AC2: a contractor with nothing to sweep gets no draft and no email", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    expect(await settlementsOf("CON-021")).toHaveLength(0);
    expect(await settlementsOf("CON-030")).toHaveLength(0);
    const asked = await db.notification.findMany({ where: { type: "settlement_draft" } });
    expect(asked).toHaveLength(1);
  });

  test("AC2: only work up to the Sunday just ended - a visit completed on the Monday is left alone", async () => {
    // Sunday 18 Oct 11:30pm Perth is still the week; Monday 19 Oct 12:10am Perth is the next.
    // (A Sunday visit is a weekend one: $300 for the hour at time and a half.)
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-18", hours: 1, completedAt: new Date("2026-10-18T15:30:00.000Z") });
    const later = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-19", hours: 1, completedAt: new Date("2026-10-18T16:10:00.000Z") });
    await runWeekly(db, MONDAY_19_OCT);

    const [settlement] = await settlementsOf("CON-014");
    expect(settlement?.breakdownByTrade).toEqual([{ trade: "Plumbing", count: 1, amount: 30_000 }]);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: later.assignmentId } })).settlementId).toBeNull();
  });

  test("AC2: a no-show call-out (cancelled, with pay) is swept on the day it was cancelled; a cancelled visit without pay is not", async () => {
    const noShow = await noShowCallout(db, { contractorCode: "CON-014", cancelledAt: new Date("2026-10-14T02:00:00.000Z") });
    const unpaid = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-13", hours: 1 });
    await db.assignment.update({ where: { id: unpaid.assignmentId }, data: { status: "cancelled", cancelledAt: new Date("2026-10-13T02:00:00.000Z"), contractorPay: null, completedAt: null } });
    await runWeekly(db, MONDAY_19_OCT);

    const [settlement] = await settlementsOf("CON-014");
    expect(settlement?.totalAmount).toBe(15_000);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: noShow.assignmentId } })).settlementId).toBe(settlement?.id);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: unpaid.assignmentId } })).settlementId).toBeNull();
    const view = await buildInvoiceView(db, (await loadSettlementForView(db, { id: settlement?.id ?? "" }))!);
    expect(view.lines[0]?.working).toEqual({ kind: "no_show" });
  });

  test("AC2: unswept pay adjustments ride on the draft as their own lines - pay for work, GST on top, never materials", async () => {
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const visit = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
    await db.contractorPayAdjustment.create({
      data: { contractorId: bob.id, amount: 15_000, reason: "Missing hour on the job, corrected after approval", jobId: visit.jobId, createdByUserId: mike.id },
    });
    await runWeekly(db, MONDAY_19_OCT);

    const [settlement] = await settlementsOf("CON-014");
    expect(settlement).toMatchObject({ adjustmentsAmount: 15_000, materialsAmount: 4500, totalAmount: 50_000 + 15_000 + 4500, gstAmount: 6500 });
    const view = await buildInvoiceView(db, (await loadSettlementForView(db, { id: settlement?.id ?? "" }))!);
    expect(view.adjustments).toEqual([{ reason: "Missing hour on the job, corrected after approval", amount: 15_000, jobReference: visit.jobReference }]);
    expect(view.subtotal).toBe(65_000);
    expect(view.gst).toBe(6500);
    expect(view.total).toBe(65_000 + 6500 + 4500);
    expect((await db.contractorPayAdjustment.findFirstOrThrow()).settlementId).toBe(settlement?.id);
  });

  test("AC2: adjustments with no visit to carry them still make a draft", async () => {
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
    await db.contractorPayAdjustment.create({ data: { contractorId: dave.id, amount: 5000, reason: "Goodwill", createdByUserId: mike.id } });
    await runWeekly(db, MONDAY_19_OCT);
    const [settlement] = await settlementsOf("CON-021");
    expect(settlement).toMatchObject({ totalAmount: 5000, adjustmentsAmount: 5000, breakdownByTrade: [] });
  });

  test("AC2: running it again the same week changes nothing - no second draft, no second email", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    const again = await runWeekly(db, new Date(MONDAY_19_OCT.getTime() + 2 * 60 * 60_000));
    expect(again.made).toEqual([]);
    expect(await settlementsOf("CON-014")).toHaveLength(1);
    expect(await db.notification.count({ where: { type: "settlement_draft" } })).toBe(1);
  });

  test("AC2: a second pass after the draft is approved, or paid, still does nothing", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    await db.contractorSettlement.updateMany({ data: { status: "approved", approvedAt: MONDAY_19_OCT, contractorGstRegistered: true } });
    expect((await runWeekly(db, MONDAY_19_OCT)).made).toEqual([]);
    await db.contractorSettlement.updateMany({ data: { status: "paid" } });
    expect((await runWeekly(db, MONDAY_19_OCT)).made).toEqual([]);
    expect(await settlementsOf("CON-014")).toHaveLength(1);
  });

  test("AC2: a run missed while the platform was down happens on the next pass, once", async () => {
    await bobsWeek();
    // Nobody ran it on Monday; the platform comes back on Wednesday afternoon.
    const wednesday = new Date("2026-10-21T06:00:00.000Z");
    const result = await runWeekly(db, wednesday);
    expect(result.periodEnd).toBe("2026-10-18");
    expect(result.made).toHaveLength(1);
    expect((await runWeekly(db, wednesday)).made).toEqual([]);
  });

  test("AC2: before 6:00am Monday the week has not ended for the run - nothing is swept early", async () => {
    await bobsWeek();
    const early = new Date("2026-10-18T21:59:00.000Z"); // 5:59am Mon 19 Oct, Perth
    const result = await runWeekly(db, early);
    expect(result.periodEnd).toBe("2026-10-11");
    expect(result.made).toEqual([]);
  });

  test("the database holds at most one draft per contractor", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    const draft = await db.contractorSettlement.findFirstOrThrow();
    await expect(
      db.contractorSettlement.create({
        data: { reference: "CINV-999", contractorId: draft.contractorId, periodStart: draft.periodStart, periodEnd: draft.periodEnd, breakdownByTrade: [], materialsAmount: 0, totalAmount: 0, status: "draft" },
      }),
    ).rejects.toThrow();
  });

  test("a pay adjustment of zero or less is refused by the database", async () => {
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await expect(db.contractorPayAdjustment.create({ data: { contractorId: bob.id, amount: 0, reason: "None", createdByUserId: mike.id } })).rejects.toThrow();
    await expect(db.contractorPayAdjustment.create({ data: { contractorId: bob.id, amount: -100, reason: "Back", createdByUserId: mike.id } })).rejects.toThrow();
  });

  test("a draft is labelled like the work it is made from, so test traffic stays recognisable", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1, testData: "e2e" });
    await runWeekly(db, MONDAY_19_OCT);
    const [settlement] = await settlementsOf("CON-014");
    expect(settlement?.testData).toBe("e2e");
    expect((await db.notification.findFirstOrThrow({ where: { type: "settlement_draft" } })).testData).toBe("e2e");
  });
});

describe("AC11 -- the next payout", () => {
  test("counts unswept visits and unswept pay adjustments, plus parts, GST left off and flagged for a registered contractor", async () => {
    const thursday = new Date("2026-10-15T04:00:00.000Z");
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-15", hours: 1.5 });
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.contractorPayAdjustment.create({ data: { contractorId: bob.id, amount: 2500, reason: "Parking", createdByUserId: mike.id } });

    const next = await nextPayout(db, bob.id, thursday);
    expect(next).toEqual({
      amount: 50_000 + 27_500 + 4500 + 2500,
      jobs: 2,
      adjustments: 1,
      plusGst: true,
      payDay: "Wed 21 Oct",
      invoicedOn: "Mon 19 Oct",
      period: "12 Oct - 18 Oct 2026",
      // The invoice total: pay for work $800 + GST $80 on top, plus the $45 part (never under GST) plus nothing else.
      total: 80_000 + 8000 + 4500,
    });

    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
    expect(await nextPayout(db, dave.id, thursday)).toMatchObject({ amount: 0, jobs: 0, adjustments: 0, plusGst: false });
  });

  test("work on an earlier invoice does not count again", async () => {
    await bobsWeek();
    await runWeekly(db, MONDAY_19_OCT);
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    expect(await nextPayout(db, bob.id, MONDAY_19_OCT)).toMatchObject({ amount: 0, jobs: 0 });
  });
});

describe("the earlier week", () => {
  test("the run for 5-11 Oct sweeps only that week's work", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-07", hours: 1 });
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1 });
    const result = await runWeekly(db, MONDAY_12_OCT);
    expect(result.periodEnd).toBe("2026-10-11");
    const [settlement] = await settlementsOf("CON-014");
    expect(settlement?.breakdownByTrade).toEqual([{ trade: "Plumbing", count: 1, amount: 20_000 }]);
  });
});
