// The job queue list -- Feature 4001, ops job queue and job detail.
//
// Operations Admin Workflow / The job queue and the job page. Open work
// only by default; a status chip narrows it; search spans every status and
// ignores the chip (plan decision 4); the order is plan decision 5; 50 rows
// a batch (decision 13, List pagination).
//
// Open work is small by nature (one operator's live jobs), so an open or
// searched list is read whole, ordered here and sliced; the Closed chip
// grows forever, so it is ordered and paged in the database.
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { JobStatus } from "../generated/prisma/enums.js";
import { formatDateLabel, formatDateTimeLabel, formatLabelled, formatPlainDate } from "../time/index.js";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  WINDOW_LABELS,
  contractorView,
  jobInclude,
  sortSlot,
  suburbOf,
  waitingFor,
  type ContractorView,
  type JobWithRelations,
} from "./shared.js";

export type StatusFilter = "open" | "new" | "assigned" | "scheduled" | "in_progress" | "on_hold" | "closed";
const STATUS_FILTERS: readonly StatusFilter[] = ["open", "new", "assigned", "scheduled", "in_progress", "on_hold", "closed"];

export const PAGE_SIZE = 50;
// The poll re-reads everything already loaded in one request (the
// frontend asks for its own row count), so the cap is generous.
const MAX_LIMIT = 1000;
const MAX_QUERY_LENGTH = 100;

export interface QueueQuery {
  status: StatusFilter;
  q: string;
  offset: number;
  limit: number;
}

type ParseResult = { ok: true; data: QueueQuery } | { ok: false; error: string };

function wholeNumber(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return Number(value);
}

export function parseQueueQuery(query: Record<string, unknown>): ParseResult {
  const status = query["status"] ?? "open";
  if (typeof status !== "string" || !STATUS_FILTERS.includes(status as StatusFilter)) {
    return { ok: false, error: `status must be one of ${STATUS_FILTERS.join(", ")}` };
  }
  const rawQ = query["q"] ?? "";
  if (typeof rawQ !== "string") return { ok: false, error: "q must be a string" };
  const q = rawQ.trim();
  if (q.length > MAX_QUERY_LENGTH) return { ok: false, error: "q is too long" };
  const offset = wholeNumber(query["offset"], 0);
  if (offset === null) return { ok: false, error: "offset must be a whole number" };
  const limit = wholeNumber(query["limit"], PAGE_SIZE);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be a whole number from 1 to ${String(MAX_LIMIT)}` };
  }
  return { ok: true, data: { status: status as StatusFilter, q, offset, limit } };
}

export interface QueueCounts {
  open: number;
  new: number;
  assigned: number;
  scheduled: number;
  in_progress: number;
  on_hold: number;
  closed: number;
}

export interface QueueRow {
  reference: string;
  status: JobStatus;
  source: "web" | "phone";
  customerName: string;
  customerCode: string;
  trade: string;
  suburb: string;
  postcode: string;
  wantedDate: string;
  windowLabel: string;
  receivedLabel: string;
  /** New jobs only: how long it has waited (AC9). */
  waiting: string | null;
  /** A new job with no site address yet -- the confirming call is still owed (AC9). */
  noSiteAddress: boolean;
  /** Closed jobs only: when it finished or was cancelled. */
  closedLabel: string | null;
  contractor: ContractorView | null;
}

export interface QueueResult {
  rows: QueueRow[];
  total: number;
  hasMore: boolean;
  counts: QueueCounts;
  /** "10:42am AWST" -- the business clock, since the list spans jobs (plan decision 12). */
  updatedLabel: string;
}

const RANK: Record<JobStatus, number> = {
  new: 0,
  assigned: 1,
  scheduled: 2,
  in_progress: 3,
  on_hold: 4,
  completed: 5,
  cancelled: 5,
};

/** Plan decision 5, and closed jobs (search results) after the open ones, most recently changed first. */
function compareQueue(a: JobWithRelations, b: JobWithRelations): number {
  const byRank = RANK[a.status] - RANK[b.status];
  if (byRank !== 0) return byRank;
  if (a.status === "new") return a.createdAt.getTime() - b.createdAt.getTime();
  if (RANK[a.status] === RANK.completed) return b.updatedAt.getTime() - a.updatedAt.getTime();
  const aSlot = sortSlot(a);
  const bSlot = sortSlot(b);
  if (aSlot && bSlot && aSlot.getTime() !== bSlot.getTime()) return aSlot.getTime() - bSlot.getTime();
  if (aSlot && !bSlot) return -1;
  if (!aSlot && bSlot) return 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

function closedLabelOf(job: JobWithRelations): string | null {
  if (job.status === "completed") {
    const completedAt = job.assignments[0]?.completedAt ?? job.updatedAt;
    return `Completed ${formatDateLabel(job.timezone, completedAt)}`;
  }
  if (job.status === "cancelled") {
    return `Cancelled ${formatDateLabel(job.timezone, job.cancelledAt ?? job.updatedAt)}`;
  }
  return null;
}

export function toQueueRow(job: JobWithRelations, now: Date): QueueRow {
  return {
    reference: job.reference,
    status: job.status,
    source: job.source,
    customerName: job.customer.name,
    customerCode: job.customer.code,
    trade: job.serviceType.trade,
    suburb: suburbOf(job.serviceLocation),
    postcode: job.postcode,
    wantedDate: formatPlainDate(job.preferredDate),
    windowLabel: WINDOW_LABELS[job.preferredWindow],
    receivedLabel: formatDateTimeLabel(job.timezone, job.createdAt, now),
    waiting: job.status === "new" ? waitingFor(job.createdAt, now) : null,
    noSiteAddress: job.status === "new" && job.siteAddress === null,
    closedLabel: closedLabelOf(job),
    contractor: contractorView(job, now),
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Plan decision 4: case-insensitive "contains" on the job reference, the
 * customer code and the customer name; a query that reads as a phone number
 * (digits, spaces, brackets, + and -) is also compared digits-only against
 * the customer's phone, so "0400 001 052" and "0400001052" match alike.
 */
async function searchJobIds(client: PrismaClient, q: string): Promise<string[]> {
  const like = `%${escapeLike(q)}%`;
  const digits = q.replace(/\D/g, "");
  const phoneClause =
    /^[\d\s()+-]+$/.test(q) && digits !== ""
      ? Prisma.sql`OR regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}`
      : Prisma.empty;
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT j.id FROM "Job" j
      JOIN "Customer" c ON c.id = j."customerId"
     WHERE j.reference ILIKE ${like}
        OR c.code ILIKE ${like}
        OR c.name ILIKE ${like}
        ${phoneClause}
  `;
  return rows.map((row) => row.id);
}

async function countByChip(client: PrismaClient): Promise<QueueCounts> {
  const grouped = await client.job.groupBy({ by: ["status"], _count: { _all: true } });
  const countOf = (status: JobStatus): number => grouped.find((g) => g.status === status)?._count._all ?? 0;
  return {
    open: OPEN_STATUSES.reduce((sum, status) => sum + countOf(status), 0),
    new: countOf("new"),
    assigned: countOf("assigned"),
    scheduled: countOf("scheduled"),
    in_progress: countOf("in_progress"),
    on_hold: countOf("on_hold"),
    closed: CLOSED_STATUSES.reduce((sum, status) => sum + countOf(status), 0),
  };
}

function whereForChip(status: StatusFilter): Prisma.JobWhereInput {
  if (status === "open") return { status: { in: [...OPEN_STATUSES] } };
  if (status === "closed") return { status: { in: [...CLOSED_STATUSES] } };
  return { status };
}

export async function listQueue(
  client: PrismaClient,
  query: QueueQuery,
  businessZone: string,
  now: Date = new Date(),
): Promise<QueueResult> {
  const counts = await countByChip(client);
  let page: JobWithRelations[];
  let total: number;

  if (query.q === "" && query.status === "closed") {
    const where = whereForChip("closed");
    total = await client.job.count({ where });
    page = await client.job.findMany({
      where,
      include: jobInclude,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      skip: query.offset,
      take: query.limit,
    });
  } else {
    const where: Prisma.JobWhereInput =
      query.q !== "" ? { id: { in: await searchJobIds(client, query.q) } } : whereForChip(query.status);
    const all = await client.job.findMany({ where, include: jobInclude });
    all.sort(compareQueue);
    total = all.length;
    page = all.slice(query.offset, query.offset + query.limit);
  }

  return {
    rows: page.map((job) => toQueueRow(job, now)),
    total,
    hasMore: query.offset + page.length < total,
    counts,
    updatedLabel: formatLabelled(businessZone, now),
  };
}
