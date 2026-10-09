// The settlement lifecycle -- Feature 6003, settlement run.
//
// Contractor Settlement / Draft -> approve -> paid:
//   inspectApprove / approveByToken   the contractor's one tap, on a capability link (no login)
//   markPaid                          Mike pays by hand, then marks it: the money-out audit pair
//   rebuild                           Mike replaces an unapproved draft after correcting a job
//   correctedSince                    the flag beside a draft whose job was corrected after it
//   nextPayout                        what is still waiting to be invoiced, and when it is paid
//
// Each write is ONE transaction that locks the row it changes, so a double tap is the same tap.
// Messages are asked by the caller AFTER commit.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { burnBySettlement, CapabilityTokenType, consumeCapabilityToken, findCapabilityToken } from "../capability-tokens/index.js";
import { readNotes } from "../jobs/notes.js";
import { dayLabel, friendlyDate, nextRunMonday, payDayAfter, payDayFor, ymdOf } from "./calendar.js";
import { buildInvoiceView, gstOnTop, labourOf, loadSettlementForView, type InvoiceView } from "./invoice-view.js";
import { sweepContractor } from "./sweep.js";
import { todayIn } from "../time/index.js";

type Db = Prisma.TransactionClient;

export interface Refused {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

function refuse(status: number, error: string, extra: Record<string, unknown> = {}): Refused {
  return { ok: false, status, body: { error, ...extra } };
}

async function lockSettlement(tx: Db, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ContractorSettlement" WHERE id = ${id} FOR UPDATE`;
}

async function officePhoneOf(db: Db): Promise<string> {
  const settings = await db.platformSettings.findFirst({ select: { operatorPhone: true } });
  return settings?.operatorPhone ?? "";
}

/** The amount a settlement pays: its total plus GST (a draft reads the contractor's registration as it is now). */
export function amountOf(
  settlement: { status: string; totalAmount: number; gstAmount: number | null; breakdownByTrade: unknown; adjustmentsAmount: number },
  contractorRegistered: boolean | null,
  ratePercent: number,
): number {
  if (settlement.status === "approved" || settlement.status === "paid") return settlement.totalAmount + (settlement.gstAmount ?? 0);
  const gst = gstOnTop(labourOf(settlement.breakdownByTrade) + settlement.adjustmentsAmount, contractorRegistered === true, ratePercent);
  return settlement.totalAmount + (gst ?? 0);
}

// ---------------------------------------------------------------------------
// The approve link
// ---------------------------------------------------------------------------

export type ApproveDead =
  | { state: "replaced"; officePhone: string }
  | { state: "approved"; reference: string; approvedLabel: string; payDay: string; paid: boolean; officePhone: string }
  | { state: "unknown"; officePhone: string };

export interface ApproveOpen {
  state: "open";
  firstName: string;
  /** "Wed 21 Oct" */
  payDay: string;
  officePhone: string;
  invoice: InvoiceView;
}

export function statusOfApproveDead(dead: ApproveDead): number {
  return dead.state === "unknown" ? 404 : 410;
}

type Inspected = { kind: "open"; settlementId: string } | { kind: "dead"; dead: ApproveDead };

async function inspectToken(db: Db, rawToken: string, now: Date): Promise<Inspected> {
  const officePhone = await officePhoneOf(db);
  const unknown: Inspected = { kind: "dead", dead: { state: "unknown", officePhone } };
  const token = await findCapabilityToken(db, rawToken);
  if (token === null || token.type !== CapabilityTokenType.approve || token.settlementId === null) return unknown;
  const settlement = await db.contractorSettlement.findUnique({ where: { id: token.settlementId } });
  if (settlement === null) return unknown;

  if (settlement.status === "superseded") return { kind: "dead", dead: { state: "replaced", officePhone } };
  if (settlement.status === "approved" || settlement.status === "paid") {
    const settings = await db.platformSettings.findFirstOrThrow();
    return {
      kind: "dead",
      dead: {
        state: "approved",
        reference: settlement.reference,
        approvedLabel: friendlyDate(todayIn(settings.timezone, settlement.approvedAt ?? now)),
        payDay: dayLabel(payDayFor(settings, now)),
        paid: settlement.status === "paid",
        officePhone,
      },
    };
  }
  // A draft whose link has been used up or has run out no longer works.
  if (token.usedAt !== null || token.expiresAt.getTime() <= now.getTime()) return unknown;
  return { kind: "open", settlementId: settlement.id };
}

export async function readApprove(client: PrismaClient, rawToken: string, now: Date): Promise<ApproveOpen | ApproveDead> {
  const inspected = await inspectToken(client, rawToken, now);
  if (inspected.kind === "dead") return inspected.dead;
  const settlement = await loadSettlementForView(client, { id: inspected.settlementId });
  if (settlement === null) return { state: "unknown", officePhone: await officePhoneOf(client) };
  const settings = await client.platformSettings.findFirstOrThrow();
  return {
    state: "open",
    firstName: settlement.contractor.name.split(" ")[0] ?? settlement.contractor.name,
    payDay: dayLabel(payDayFor(settings, now)),
    officePhone: settings.operatorPhone,
    invoice: await buildInvoiceView(client, settlement),
  };
}

export type ApproveResult =
  | { ok: true; reference: string; payDay: string }
  | Refused;

/**
 * The contractor's tap. The draft becomes approved and frozen: the registration he is on is
 * snapshotted, GST is worked out from that snapshot, and the link is spent. Refused while his GST
 * registration is still not asked -- the office records it, then the same link works.
 */
export async function approveByToken(client: PrismaClient, rawToken: string, now: Date): Promise<ApproveResult> {
  return client.$transaction(async (tx): Promise<ApproveResult> => {
    const first = await inspectToken(tx, rawToken, now);
    if (first.kind === "dead") return { ok: false, status: statusOfApproveDead(first.dead), body: { ...first.dead } };
    await lockSettlement(tx, first.settlementId);
    // Re-read under the lock: a double tap, or a Rebuild a moment ago, is answered by the dead state.
    const inspected = await inspectToken(tx, rawToken, now);
    if (inspected.kind === "dead") return { ok: false, status: statusOfApproveDead(inspected.dead), body: { ...inspected.dead } };

    const settlement = await tx.contractorSettlement.findUniqueOrThrow({
      where: { id: inspected.settlementId },
      include: { contractor: { select: { gstRegistered: true } } },
    });
    const settings = await tx.platformSettings.findFirstOrThrow();
    const registered = settlement.contractor.gstRegistered;
    if (registered === null) {
      return refuse(409, "gst_not_recorded", { state: "gst_not_recorded", officePhone: settings.operatorPhone });
    }
    const gstAmount = gstOnTop(labourOf(settlement.breakdownByTrade) + settlement.adjustmentsAmount, registered, Number(settings.gstRatePercent));
    await tx.contractorSettlement.update({
      where: { id: settlement.id },
      data: { status: "approved", approvedAt: now, contractorGstRegistered: registered, gstAmount },
    });
    await consumeCapabilityToken(tx, rawToken, CapabilityTokenType.approve);
    await burnBySettlement(tx, settlement.id, [CapabilityTokenType.approve], now);
    return { ok: true, reference: settlement.reference, payDay: dayLabel(payDayFor(settings, now)) };
  });
}

// ---------------------------------------------------------------------------
// Ops: mark paid, rebuild
// ---------------------------------------------------------------------------

export type MarkPaidResult = { ok: true; id: string; reference: string } | Refused;

export async function markPaid(client: PrismaClient, reference: string, userId: string, now: Date): Promise<MarkPaidResult> {
  return client.$transaction(async (tx): Promise<MarkPaidResult> => {
    const found = await tx.contractorSettlement.findUnique({ where: { reference }, select: { id: true } });
    if (found === null) return refuse(404, "not found");
    await lockSettlement(tx, found.id);
    const settlement = await tx.contractorSettlement.findUniqueOrThrow({
      where: { id: found.id },
      include: { contractor: { select: { name: true, payoutAccountNo: true } } },
    });
    if (settlement.status === "paid") return refuse(409, "Already paid.");
    if (settlement.status === "superseded") return refuse(409, "This invoice was replaced.");
    if (settlement.status !== "approved") return refuse(409, "Only an approved invoice can be marked paid.");
    if (settlement.contractor.payoutAccountNo === null || settlement.contractor.payoutAccountNo.trim() === "") {
      return refuse(409, `Add ${settlement.contractor.name.split(" ")[0] ?? settlement.contractor.name}'s bank details first.`);
    }
    // The bank reference is the CINV number: nothing to type twice.
    await tx.contractorSettlement.update({
      where: { id: settlement.id },
      data: { status: "paid", paidAt: now, paidByUserId: userId, paymentReference: settlement.reference },
    });
    return { ok: true, id: settlement.id, reference: settlement.reference };
  });
}

export type RebuildResult = { ok: true; draft: { id: string; reference: string; testData: string | null } } | Refused;

export async function rebuild(client: PrismaClient, reference: string, userId: string, now: Date): Promise<RebuildResult> {
  return client.$transaction(async (tx): Promise<RebuildResult> => {
    const found = await tx.contractorSettlement.findUnique({ where: { reference }, select: { id: true, contractorId: true } });
    if (found === null) return refuse(404, "not found");
    // The contractor first (sweepContractor takes the same lock), then the status under it.
    await tx.$queryRaw`SELECT id FROM "Contractor" WHERE id = ${found.contractorId} FOR UPDATE`;
    const settlement = await tx.contractorSettlement.findUniqueOrThrow({ where: { id: found.id } });
    if (settlement.status !== "draft") return refuse(409, "Only a draft can be rebuilt.");
    const swept = await sweepContractor(tx, settlement.contractorId, {
      periodEnd: ymdOf(settlement.periodEnd),
      now,
      supersededByUserId: userId,
    });
    if (swept === null) return refuse(409, "There is nothing left to rebuild it from.");
    return { ok: true, draft: { id: swept.id, reference: swept.reference, testData: swept.testData } };
  });
}

/** True when a job on the draft got a `correction` note after the draft was made. Derived, no field. */
export function correctedSince(draftCreatedAt: Date, jobNotes: readonly unknown[]): boolean {
  return jobNotes.some((notes) =>
    readNotes(notes).some((note) => note.type === "correction" && new Date(note.at).getTime() > draftCreatedAt.getTime()),
  );
}

// ---------------------------------------------------------------------------
// Next payout
// ---------------------------------------------------------------------------

export interface NextPayout {
  /** labour + adjustments + parts, GST excluded; 0 when nothing waits */
  amount: number;
  /** visits with money on them, not yet on an invoice */
  jobs: number;
  /** pay adjustments not yet on an invoice */
  adjustments: number;
  /** the contractor is registered, so GST is added on top */
  plusGst: boolean;
  /** "Wed 21 Oct" -- the first pay day after the next Monday run */
  payDay: string;
  /** the next Monday run, "Mon 19 Oct" */
  invoicedOn: string;
}

export async function nextPayout(db: Db, contractorId: string, now: Date): Promise<NextPayout> {
  const settings = await db.platformSettings.findFirstOrThrow();
  const contractor = await db.contractor.findUniqueOrThrow({ where: { id: contractorId }, select: { gstRegistered: true } });
  const visits = await db.assignment.findMany({
    where: {
      contractorId,
      settlementId: null,
      contractorPay: { not: null },
      OR: [{ status: "completed" }, { status: "cancelled", cancelledAt: { not: null } }],
    },
    select: { contractorPay: true, materialsReimbursement: true },
  });
  const adjustments = await db.contractorPayAdjustment.findMany({ where: { contractorId, settlementId: null }, select: { amount: true } });
  const run = nextRunMonday(settings, now);
  return {
    amount:
      visits.reduce((sum, visit) => sum + (visit.contractorPay ?? 0) + (visit.materialsReimbursement ?? 0), 0) +
      adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0),
    jobs: visits.length,
    adjustments: adjustments.length,
    plusGst: contractor.gstRegistered === true,
    payDay: dayLabel(payDayAfter(settings, run)),
    invoicedOn: dayLabel(run),
  };
}
