// The contractor's invoice as people read it -- Feature 6003, settlement run.
//
// Contractor Settlement (the invoice lists every job, one line each); frontend-conventions,
// Organisms / Lists and tables ("GST added on top", the pay line). ONE view, shared by the
// approve page, the contractor's settlement page and the ops drill-down, so the three can
// never disagree. Money is whole cents; the screen formats it.
//
//   heading     "Tax Invoice" for a registered contractor, "Invoice" otherwise
//   pay lines   one per job: reference, day and date, trade, hours, amount; a weekend line
//               is flagged (the screen prints the code from the constant), each with its working
//   adjustments follow as their own lines, the reason as the description
//   Subtotal + GST   registered only; GST is added on top of labour + adjustments, never parts
//   materials   their own walled-off block, one line per part, by job
//   Total       the settlement total plus GST
import type { Prisma } from "../generated/prisma/client.js";
import { contractorMultiplierOf, labourTotal, WEEKEND_CONTRACTOR_MULTIPLIER } from "../invoices/arithmetic.js";
import { dayLabel, friendlyDate, periodLabel, ymdOf } from "./calendar.js";
import { todayIn } from "../time/index.js";

type Db = Prisma.TransactionClient;

export const settlementViewInclude = {
  contractor: { select: { id: true, code: true, name: true, businessName: true, abn: true, gstRegistered: true } },
  assignments: {
    include: {
      job: { select: { reference: true, timezone: true } },
      specialty: { select: { trade: true } },
      timeLogs: { select: { startedAt: true }, orderBy: { startedAt: "asc" } },
      parts: { orderBy: { id: "asc" } },
    },
  },
  payAdjustments: { include: { job: { select: { reference: true } } }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.ContractorSettlementInclude;

export type SettlementForView = Prisma.ContractorSettlementGetPayload<{ include: typeof settlementViewInclude }>;

export type PayLineWorking =
  | {
      kind: "visit";
      /** the call-out rate for the first hour, after the weekend multiplier */
      calloutRate: number;
      /** the hours after the first */
      extraHours: number;
      /** the standard rate per hour, after the multiplier */
      standardRate: number;
      /** extraHours x standardRate */
      extraTotal: number;
      multiplier: number;
    }
  | { kind: "no_show" };

export interface PayLine {
  jobReference: string;
  /** "Wed 14 Oct", in the job's zone */
  day: string;
  trade: string;
  /** billed hours; null for a no-show call-out */
  hours: number | null;
  /** time and a half: the screen prints the code and its legend */
  weekend: boolean;
  amount: number;
  working: PayLineWorking;
}

export interface AdjustmentLine {
  reason: string;
  amount: number;
  jobReference: string | null;
}

export interface MaterialsLine {
  jobReference: string;
  name: string;
  amount: number;
}

export interface InvoiceView {
  reference: string;
  status: "draft" | "approved" | "paid" | "superseded";
  heading: "Tax Invoice" | "Invoice";
  /** what the GST lines are based on: true = registered (GST on top) */
  gstRegistered: boolean;
  /** the contractor's registration is still empty -- Approve is refused */
  gstNotRecorded: boolean;
  from: { name: string; businessName: string | null; abn: string | null };
  to: { name: string; abn: string | null; address: string | null };
  period: { start: string; end: string; label: string };
  /** the approval date, or "Draft" */
  dateLabel: string;
  weekendMultiplier: number;
  lines: PayLine[];
  adjustments: AdjustmentLine[];
  /** labour + adjustments; shown only when gstRegistered */
  subtotal: number;
  /** null when not registered */
  gst: number | null;
  materials: MaterialsLine[];
  materialsTotal: number;
  total: number;
}

/** GST on top of pay for work, to the cent; null when the contractor is not registered. */
export function gstOnTop(payForWork: number, registered: boolean, ratePercent: number): number | null {
  return registered ? Math.round((payForWork * ratePercent) / 100) : null;
}

function addressLine(address: unknown): string | null {
  if (address === null || typeof address !== "object" || Array.isArray(address)) return null;
  const a = address as Record<string, unknown>;
  const text = (key: string): string => {
    const value = a[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const place = [text("suburb"), text("state"), text("postcode")].filter((part) => part !== "").join(" ");
  const line = [text("street"), place].filter((part) => part !== "").join(", ");
  return line === "" ? null : line;
}

/** The labour a settlement carries: the sum of its trades, the figure GST goes on top of with adjustments. */
export function labourOf(breakdownByTrade: unknown): number {
  if (!Array.isArray(breakdownByTrade)) return 0;
  return breakdownByTrade.reduce<number>((sum, entry) => {
    const amount = (entry as { amount?: unknown } | null)?.amount;
    return sum + (typeof amount === "number" ? amount : 0);
  }, 0);
}

function payLineOf(assignment: SettlementForView["assignments"][number]): { line: PayLine; visitStart: Date } {
  const zone = assignment.job.timezone;
  const worked = assignment.completedAt ?? assignment.cancelledAt ?? assignment.dispatchedAt;
  const earliest = assignment.timeLogs[0]?.startedAt ?? worked;
  const amount = assignment.contractorPay ?? 0;
  const base = {
    jobReference: assignment.job.reference,
    day: dayLabel(todayIn(zone, earliest)),
    trade: assignment.specialty.trade,
    amount,
  };
  const hours = assignment.billedHours === null ? null : Number(assignment.billedHours);
  const hasVisit =
    assignment.status === "completed" &&
    hours !== null &&
    assignment.contractorCalloutRate !== null &&
    assignment.contractorStandardRate !== null;
  if (!hasVisit) {
    // A no-show call-out: a cancelled assignment that still carries pay -- one flat amount.
    return { line: { ...base, hours: null, weekend: false, working: { kind: "no_show" } }, visitStart: earliest };
  }
  const multiplier = contractorMultiplierOf(zone, earliest);
  const labour = labourTotal(
    { calloutRate: assignment.contractorCalloutRate ?? 0, standardRate: assignment.contractorStandardRate ?? 0 },
    multiplier,
    hours,
  );
  return {
    line: {
      ...base,
      hours,
      weekend: multiplier === WEEKEND_CONTRACTOR_MULTIPLIER,
      working: {
        kind: "visit",
        calloutRate: labour.tier1Rate,
        extraHours: labour.extraHours,
        standardRate: labour.tier2Rate,
        extraTotal: labour.tier2Total,
        multiplier,
      },
    },
    visitStart: earliest,
  };
}

export async function loadSettlementForView(db: Db, where: Prisma.ContractorSettlementWhereUniqueInput): Promise<SettlementForView | null> {
  return db.contractorSettlement.findUnique({ where, include: settlementViewInclude });
}

export async function buildInvoiceView(db: Db, settlement: SettlementForView): Promise<InvoiceView> {
  const settings = await db.platformSettings.findFirstOrThrow();
  const zone = settings.timezone;

  const built = settlement.assignments.map(payLineOf).sort((a, b) => a.visitStart.getTime() - b.visitStart.getTime());
  const lines = built.map((entry) => entry.line);
  const adjustments: AdjustmentLine[] = settlement.payAdjustments.map((adjustment) => ({
    reason: adjustment.reason,
    amount: adjustment.amount,
    jobReference: adjustment.job?.reference ?? null,
  }));
  const materials: MaterialsLine[] = [...settlement.assignments]
    .sort((a, b) => (a.timeLogs[0]?.startedAt.getTime() ?? 0) - (b.timeLogs[0]?.startedAt.getTime() ?? 0))
    .flatMap((assignment) =>
      assignment.parts
        .filter((part) => part.suppliedBy === "contractor")
        .map((part) => ({ jobReference: assignment.job.reference, name: part.name, amount: part.lineTotal })),
    );

  // An approved or paid invoice reads the registration it was approved on; a draft reads it live.
  const frozen = settlement.status === "approved" || settlement.status === "paid";
  const registeredNow = frozen ? settlement.contractorGstRegistered === true : settlement.contractor.gstRegistered === true;
  const labour = lines.reduce((sum, line) => sum + line.amount, 0);
  const adjustmentsTotal = adjustments.reduce((sum, line) => sum + line.amount, 0);
  const subtotal = labour + adjustmentsTotal;
  const gst = frozen ? settlement.gstAmount : gstOnTop(subtotal, registeredNow, Number(settings.gstRatePercent));
  const materialsTotal = materials.reduce((sum, line) => sum + line.amount, 0);

  const start = ymdOf(settlement.periodStart);
  const end = ymdOf(settlement.periodEnd);
  return {
    reference: settlement.reference,
    status: settlement.status,
    heading: registeredNow ? "Tax Invoice" : "Invoice",
    gstRegistered: registeredNow,
    gstNotRecorded: !frozen && settlement.contractor.gstRegistered === null,
    from: { name: settlement.contractor.name, businessName: settlement.contractor.businessName, abn: settlement.contractor.abn },
    to: { name: settings.legalEntityName, abn: settings.businessAbn, address: addressLine(settings.businessAddress) },
    period: { start, end, label: periodLabel(start, end) },
    dateLabel: settlement.approvedAt === null ? "Draft" : friendlyDate(todayIn(zone, settlement.approvedAt)),
    weekendMultiplier: WEEKEND_CONTRACTOR_MULTIPLIER,
    lines,
    adjustments,
    subtotal,
    gst,
    materials,
    materialsTotal,
    total: subtotal + materialsTotal + (gst ?? 0),
  };
}
