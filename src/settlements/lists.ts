// The settlement lists -- Feature 6003, settlement run.
//
// Ops: Settlements screen (Ready to pay / Awaiting approval / Not yet invoiced / Paid) and the
// payout CSV. Contractor: his Settlements page. All reads, all derived; 50 a page with a cursor.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { dayLabel, nextRunMonday, payDayAfter, payDayFor, periodLabel, ymdOf } from "./calendar.js";
import { amountOf, correctedSince, nextPayout, type NextPayout } from "./service.js";
import { todayIn } from "../time/index.js";

export const SETTLEMENTS_PAGE = 50;

export type OpsView = "ready" | "awaiting" | "upcoming" | "paid";
export const OPS_VIEWS: readonly OpsView[] = ["ready", "awaiting", "upcoming", "paid"];

/** "21/10/26" -- a table date, on the business clock. */
function shortDate(zone: string, moment: Date): string {
  const [year, month, day] = todayIn(zone, moment).split("-");
  return `${day ?? ""}/${month ?? ""}/${(year ?? "").slice(2)}`;
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

const rowInclude = {
  contractor: { select: { code: true, name: true, gstRegistered: true, payoutBsb: true, payoutAccountNo: true, payoutAccountName: true } },
  paidBy: { select: { name: true } },
  assignments: { select: { job: { select: { operatorNotes: true } } } },
} satisfies Prisma.ContractorSettlementInclude;

type Row = Prisma.ContractorSettlementGetPayload<{ include: typeof rowInclude }>;

export interface ContractorRef {
  code: string;
  name: string;
  firstName: string;
}

export interface OpsRow {
  reference: string;
  contractor: ContractorRef;
  period: string;
  jobs: number;
  amount: number;
  bsb: string | null;
  account: string | null;
  approvedLabel: string | null;
  madeLabel: string;
  paidLabel: string | null;
  paidBy: string | null;
  /** a job on the draft got a correction note after it was made */
  correctedSince: boolean;
  /** the contractor's GST registration is still not asked */
  gstNotRecorded: boolean;
}

export interface UpcomingRow {
  contractor: ContractorRef;
  jobs: number;
  adjustments: number;
  amount: number;
  invoicedOn: string;
  paidOn: string;
}

export interface OpsList {
  view: OpsView;
  facts: { readyCount: number; readyTotal: number; payDay: string };
  counts: Record<OpsView, number>;
  rows: OpsRow[];
  upcoming: UpcomingRow[];
  nextCursor: string | null;
}

function contractorRef(contractor: { code: string; name: string }): ContractorRef {
  return { code: contractor.code, name: contractor.name, firstName: firstNameOf(contractor.name) };
}

function rowOf(row: Row, zone: string, ratePercent: number): OpsRow {
  return {
    reference: row.reference,
    contractor: contractorRef(row.contractor),
    period: periodLabel(ymdOf(row.periodStart), ymdOf(row.periodEnd)),
    jobs: row.assignments.length,
    amount: amountOf(row, row.contractor.gstRegistered, ratePercent),
    bsb: row.contractor.payoutBsb,
    account: row.contractor.payoutAccountNo,
    approvedLabel: row.approvedAt === null ? null : shortDate(zone, row.approvedAt),
    madeLabel: shortDate(zone, row.createdAt),
    paidLabel: row.paidAt === null ? null : shortDate(zone, row.paidAt),
    paidBy: row.paidBy?.name ?? null,
    correctedSince: row.status === "draft" && correctedSince(row.createdAt, row.assignments.map((assignment) => assignment.job.operatorNotes)),
    gstNotRecorded: row.status === "draft" && row.contractor.gstRegistered === null,
  };
}

const UNSWEPT_VISITS: Prisma.AssignmentWhereInput = {
  settlementId: null,
  contractorPay: { not: null },
  OR: [{ status: "completed" }, { status: "cancelled", cancelledAt: { not: null } }],
};

async function upcomingRows(client: PrismaClient, now: Date): Promise<UpcomingRow[]> {
  const settings = await client.platformSettings.findFirstOrThrow();
  const contractors = await client.contractor.findMany({
    where: { OR: [{ assignments: { some: UNSWEPT_VISITS } }, { payAdjustments: { some: { settlementId: null } } }] },
    select: { id: true, code: true, name: true },
    orderBy: { name: "asc" },
  });
  const run = nextRunMonday(settings, now);
  const rows: UpcomingRow[] = [];
  for (const contractor of contractors) {
    const next: NextPayout = await nextPayout(client, contractor.id, now);
    rows.push({
      contractor: contractorRef(contractor),
      jobs: next.jobs,
      adjustments: next.adjustments,
      amount: next.amount,
      invoicedOn: dayLabel(run),
      paidOn: dayLabel(payDayAfter(settings, run)),
    });
  }
  return rows;
}

export async function listForOps(client: PrismaClient, view: OpsView, after: string | null, now: Date): Promise<OpsList> {
  const settings = await client.platformSettings.findFirstOrThrow();
  const rate = Number(settings.gstRatePercent);
  const zone = settings.timezone;

  const [approved, awaiting, paid, upcoming] = await Promise.all([
    client.contractorSettlement.findMany({ where: { status: "approved" }, include: rowInclude }),
    client.contractorSettlement.count({ where: { status: "draft" } }),
    client.contractorSettlement.count({ where: { status: "paid" } }),
    upcomingRows(client, now),
  ]);
  const facts = {
    readyCount: approved.length,
    readyTotal: approved.reduce((sum, row) => sum + amountOf(row, row.contractor.gstRegistered, rate), 0),
    payDay: dayLabel(payDayFor(settings, now)),
  };
  const counts: Record<OpsView, number> = { ready: approved.length, awaiting, upcoming: upcoming.length, paid };

  if (view === "upcoming") return { view, facts, counts, rows: [], upcoming, nextCursor: null };

  const page = {
    take: SETTLEMENTS_PAGE + 1,
    ...(after === null ? {} : { cursor: { id: after }, skip: 0 }),
  };
  const found =
    view === "ready"
      ? await client.contractorSettlement.findMany({ where: { status: "approved" }, include: rowInclude, orderBy: [{ approvedAt: "asc" }, { id: "asc" }], ...page })
      : view === "awaiting"
        ? await client.contractorSettlement.findMany({ where: { status: "draft" }, include: rowInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...page })
        : await client.contractorSettlement.findMany({ where: { status: "paid" }, include: rowInclude, orderBy: [{ paidAt: "desc" }, { id: "desc" }], ...page });
  const shown = found.slice(0, SETTLEMENTS_PAGE);
  return {
    view,
    facts,
    counts,
    rows: shown.map((row) => rowOf(row, zone, rate)),
    upcoming: [],
    nextCursor: found.length > SETTLEMENTS_PAGE ? (found[SETTLEMENTS_PAGE]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// The payout CSV
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One row per approved, unpaid invoice: Contractor, BSB, Account, Amount, CINV reference. */
export async function payoutCsv(client: PrismaClient, now: Date): Promise<{ fileName: string; content: string }> {
  const settings = await client.platformSettings.findFirstOrThrow();
  const rate = Number(settings.gstRatePercent);
  const approved = await client.contractorSettlement.findMany({
    where: { status: "approved" },
    include: rowInclude,
    orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
  });
  const lines = [["Contractor", "BSB", "Account", "Amount", "CINV reference"]];
  for (const row of approved) {
    lines.push([
      row.contractor.payoutAccountName ?? row.contractor.name,
      row.contractor.payoutBsb ?? "",
      row.contractor.payoutAccountNo ?? "",
      (amountOf(row, row.contractor.gstRegistered, rate) / 100).toFixed(2),
      row.reference,
    ]);
  }
  return {
    fileName: `payout-run-${todayIn(settings.timezone, now)}.csv`,
    content: `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`,
  };
}

// ---------------------------------------------------------------------------
// The contractor's own list
// ---------------------------------------------------------------------------

export interface ContractorCard {
  reference: string;
  status: "draft" | "approved" | "paid";
  /** "Awaiting your approval" | "Approved" | "Paid" */
  tag: string;
  period: string;
  amount: number;
  /** "To be paid on Wed 21 Oct" | "Paid on 21/10/26" */
  dateLine: string;
}

export interface ContractorList {
  nextPayout: NextPayout;
  settlements: ContractorCard[];
  nextCursor: string | null;
}

const TAGS = { draft: "Awaiting your approval", approved: "Approved", paid: "Paid" } as const;

export async function listForContractor(client: PrismaClient, contractorId: string, after: string | null, now: Date): Promise<ContractorList> {
  const settings = await client.platformSettings.findFirstOrThrow();
  const rate = Number(settings.gstRatePercent);
  const contractor = await client.contractor.findUniqueOrThrow({ where: { id: contractorId }, select: { gstRegistered: true } });
  // Awaiting approval comes first (on the first page only, so paging never repeats it); every other
  // invoice follows newest first.
  const awaiting =
    after === null
      ? await client.contractorSettlement.findMany({ where: { contractorId, status: "draft" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })
      : [];
  const found = await client.contractorSettlement.findMany({
    where: { contractorId, status: { in: ["approved", "paid"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SETTLEMENTS_PAGE + 1,
    ...(after === null ? {} : { cursor: { id: after }, skip: 0 }),
  });
  const payDay = dayLabel(payDayFor(settings, now));
  const settlements: ContractorCard[] = [...awaiting, ...found.slice(0, SETTLEMENTS_PAGE)].map((row) => {
    const status = row.status as "draft" | "approved" | "paid";
    return {
      reference: row.reference,
      status,
      tag: TAGS[status],
      period: periodLabel(ymdOf(row.periodStart), ymdOf(row.periodEnd)),
      amount: amountOf(row, contractor.gstRegistered, rate),
      dateLine: status === "paid" ? `Paid on ${row.paidAt === null ? "" : shortDate(settings.timezone, row.paidAt)}` : `To be paid on ${payDay}`,
    };
  });
  return {
    nextPayout: await nextPayout(client, contractorId, now),
    settlements,
    nextCursor: found.length > SETTLEMENTS_PAGE ? (found[SETTLEMENTS_PAGE]?.id ?? null) : null,
  };
}
