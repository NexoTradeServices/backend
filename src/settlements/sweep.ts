// The sweep -- Feature 6003, settlement run.
//
// Contractor Settlement / Draft -> approve -> paid; Contractor pay calculation (Weekly pay).
//
//   sweepContractor  gathers one contractor's visits with money on them and pay adjustments up
//                    to a period's end into ONE draft invoice, superseding the draft he already
//                    had (its visits and adjustments are released and swept again, with the new
//                    work, into the fresh one). Used by the weekly run and by Rebuild.
//   runWeekly        what the Monday 6:00am run does, for every contractor that needs it. A
//                    second pass in the same week does nothing; a run missed while the platform
//                    was down happens on the next pass.
//
// The draft email is asked AFTER the transaction commits (messages.ts), so a rolled-back sweep
// sends nothing.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { burnBySettlement, CapabilityTokenType } from "../capability-tokens/index.js";
import { nextReference } from "../db/reference.js";
import { isProduction } from "../test-data/label.js";
import { addDays, cycleDays, periodFor, plainDate, workDayOf, ymdOf } from "./calendar.js";
import { gstOnTop } from "./invoice-view.js";
import { askDraftEmail } from "./messages.js";

type Db = Prisma.TransactionClient;

export interface SweepOptions {
  /** the last day the sweep covers, `YYYY-MM-DD` on the business clock */
  periodEnd: string;
  now: Date;
  /** who pressed Rebuild; absent for the weekly run */
  supersededByUserId?: string;
  /**
   * Test traffic only (the test-data hook): sweep nothing but work carrying this label, and leave
   * any draft that does not carry it alone -- so a browser test's run never touches a UAT
   * contractor's records, nor the owner's.
   */
  onlyLabel?: string;
}

export interface SweptDraft {
  id: string;
  reference: string;
  contractorId: string;
  testData: string | null;
  /** the draft this one replaced, when there was one */
  replacedId: string | null;
}

/** A visit with money on it: completed (work day = completedAt) or a no-show call-out (cancelledAt). */
const MONEY_VISIT: Prisma.AssignmentWhereInput = {
  contractorPay: { not: null },
  OR: [
    { status: "completed", completedAt: { not: null } },
    { status: "cancelled", cancelledAt: { not: null } },
  ],
};

const MONEY_VISIT_UNSWEPT: Prisma.AssignmentWhereInput = { AND: [MONEY_VISIT, { settlementId: null }] };

/** The one label shared by everything a draft is made from, so test traffic stays recognisable. */
function sharedLabel(labels: (string | null)[]): string | null {
  if (isProduction() || labels.length === 0) return null;
  const first = labels[0] ?? null;
  return first !== null && labels.every((label) => label === first) ? first : null;
}

export async function sweepContractor(tx: Db, contractorId: string, options: SweepOptions): Promise<SweptDraft | null> {
  // One sweep at a time per contractor: a Rebuild and the Monday run cannot both build his draft.
  await tx.$queryRaw`SELECT id FROM "Contractor" WHERE id = ${contractorId} FOR UPDATE`;
  const settings = await tx.platformSettings.findFirstOrThrow();
  const contractor = await tx.contractor.findUniqueOrThrow({ where: { id: contractorId }, select: { gstRegistered: true } });
  const old = await tx.contractorSettlement.findFirst({ where: { contractorId, status: "draft" } });
  // A draft that is not the labelled run's own is not its to replace -- and the one-draft rule leaves no room beside it.
  if (old !== null && options.onlyLabel !== undefined && old.testData !== options.onlyLabel) return null;
  const labelled: { testData?: string } = options.onlyLabel === undefined ? {} : { testData: options.onlyLabel };

  // What is free to sweep: nothing swept yet, plus the old draft's own members (released below).
  const free: Prisma.AssignmentWhereInput[] = old === null ? [{ settlementId: null }] : [{ settlementId: null }, { settlementId: old.id }];
  const candidates = await tx.assignment.findMany({
    where: { contractorId, ...labelled, AND: [MONEY_VISIT, { OR: free }] },
    include: { specialty: { select: { trade: true } } },
  });
  const visits = candidates.filter((assignment) => {
    const worked = assignment.status === "completed" ? assignment.completedAt : assignment.cancelledAt;
    return worked !== null && workDayOf(settings, worked) <= options.periodEnd;
  });
  const adjustments = await tx.contractorPayAdjustment.findMany({
    where: { contractorId, ...labelled, OR: old === null ? [{ settlementId: null }] : [{ settlementId: null }, { settlementId: old.id }] },
  });
  if (visits.length === 0 && adjustments.length === 0) return null;

  if (old !== null) {
    await tx.contractorSettlement.update({
      where: { id: old.id },
      data: { status: "superseded", supersededAt: options.now, supersededByUserId: options.supersededByUserId ?? null },
    });
    await tx.assignment.updateMany({ where: { settlementId: old.id }, data: { settlementId: null } });
    await tx.contractorPayAdjustment.updateMany({ where: { settlementId: old.id }, data: { settlementId: null } });
    // The old link is kept, spent, so the page can say it was replaced.
    await burnBySettlement(tx, old.id, [CapabilityTokenType.approve], options.now);
  }

  const byTrade = new Map<string, { count: number; amount: number }>();
  for (const visit of visits) {
    const entry = byTrade.get(visit.specialty.trade) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += visit.contractorPay ?? 0;
    byTrade.set(visit.specialty.trade, entry);
  }
  const breakdownByTrade = [...byTrade.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trade, entry]) => ({ trade, count: entry.count, amount: entry.amount }));
  const labour = breakdownByTrade.reduce((sum, entry) => sum + entry.amount, 0);
  const adjustmentsAmount = adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0);
  const materialsAmount = visits.reduce((sum, visit) => sum + (visit.materialsReimbursement ?? 0), 0);

  const defaultStart = addDays(options.periodEnd, -(cycleDays(settings) - 1));
  const oldStart = old === null ? null : ymdOf(old.periodStart);
  const periodStart = oldStart !== null && oldStart < defaultStart ? oldStart : defaultStart;
  const label = sharedLabel([...visits.map((visit) => visit.testData), ...adjustments.map((adjustment) => adjustment.testData)]);

  const created = await tx.contractorSettlement.create({
    data: {
      reference: await nextReference("CINV", tx),
      contractorId,
      periodStart: plainDate(periodStart),
      periodEnd: plainDate(options.periodEnd),
      breakdownByTrade,
      adjustmentsAmount,
      materialsAmount,
      totalAmount: labour + adjustmentsAmount + materialsAmount,
      gstAmount: gstOnTop(labour + adjustmentsAmount, contractor.gstRegistered === true, Number(settings.gstRatePercent)),
      status: "draft",
      ...(label === null ? {} : { testData: label }),
    },
    select: { id: true, reference: true, contractorId: true, testData: true },
  });
  await tx.assignment.updateMany({ where: { id: { in: visits.map((visit) => visit.id) } }, data: { settlementId: created.id } });
  await tx.contractorPayAdjustment.updateMany({ where: { id: { in: adjustments.map((adjustment) => adjustment.id) } }, data: { settlementId: created.id } });
  return { ...created, replacedId: old?.id ?? null };
}

export interface WeeklyRunResult {
  periodEnd: string;
  /** the drafts this pass made, one per contractor */
  made: { reference: string; contractorId: string; replacedId: string | null }[];
}

/**
 * The Monday run. For the period due at `now`, every contractor with something to sweep -- or an
 * older draft to replace -- and no draft, approved or paid settlement already ending on that
 * period's end gets ONE fresh draft and an email. A second pass in the same week finds those
 * settlements and does nothing.
 */
export async function runWeekly(
  client: PrismaClient,
  now: Date = new Date(),
  options: { onlyLabel?: string } = {},
): Promise<WeeklyRunResult> {
  const settings = await client.platformSettings.findFirstOrThrow();
  const period = periodFor(settings, now);
  const periodEnd = plainDate(period.periodEnd);
  const labelled: { testData?: string } = options.onlyLabel === undefined ? {} : { testData: options.onlyLabel };

  const [withVisits, withAdjustments, withOlderDrafts] = await Promise.all([
    client.assignment.findMany({ where: { ...labelled, ...MONEY_VISIT_UNSWEPT }, select: { contractorId: true }, distinct: ["contractorId"] }),
    client.contractorPayAdjustment.findMany({ where: { ...labelled, settlementId: null }, select: { contractorId: true }, distinct: ["contractorId"] }),
    client.contractorSettlement.findMany({ where: { ...labelled, status: "draft", periodEnd: { lt: periodEnd } }, select: { contractorId: true } }),
  ]);
  const contractorIds = new Set([...withVisits, ...withAdjustments, ...withOlderDrafts].map((row) => row.contractorId));

  const made: WeeklyRunResult["made"] = [];
  for (const contractorId of contractorIds) {
    const draft = await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Contractor" WHERE id = ${contractorId} FOR UPDATE`;
      const already = await tx.contractorSettlement.findFirst({
        where: { contractorId, ...labelled, periodEnd, status: { in: ["draft", "approved", "paid"] } },
        select: { id: true },
      });
      if (already !== null) return null;
      return sweepContractor(tx, contractorId, { periodEnd: period.periodEnd, now, ...(options.onlyLabel === undefined ? {} : { onlyLabel: options.onlyLabel }) });
    });
    if (draft === null) continue;
    made.push({ reference: draft.reference, contractorId, replacedId: draft.replacedId });
    try {
      await askDraftEmail(client, draft, now);
    } catch (error: unknown) {
      console.error(`settlements: draft ${draft.reference} was made but its email could not be asked`, error);
    }
  }
  return { periodEnd: period.periodEnd, made };
}
