// The customer rating card's figures -- Feature 4010.
//
// Operations Admin Workflow / The job queue and the job page: who the customer is, worked out
// from her history every time the job page opens. Read-only; nothing is stored.
import type { PrismaClient } from "../db/client.js";
import { dueStateOf } from "../payments/receivables.js";
import { readNotes } from "./notes.js";

export type RatingLabel = "first_time" | "returning" | "regular" | "old";

export interface CustomerRating {
  label: RatingLabel;
  /** Completed jobs other than this one, in the 365 days before now. */
  jobsInLastYear: number;
  /** "2 Oct 2026" in the business clock; null when she has no earlier completed job. */
  lastJobLabel: string | null;
  /** "7 jobs in the last 12 months - last job 2 Oct 2026". */
  line: string;
  missedVisits: number;
  /** Of the missed visits, those with no call-out invoice. */
  waived: number;
  lateCancellations: number;
  disputes: number;
  overdueInvoices: number;
  /** Cents, GST-inclusive. */
  totalDue: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Voice and tone: a friendly date reads "9 Sep 2026", in the given zone (month names fixed, never the ICU's "Sept"). */
export function friendlyDate(zone: string, moment: Date): string {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: zone, day: "numeric", month: "numeric", year: "numeric" }).formatToParts(moment);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${String(Number(part("day")))} ${MONTHS[Number(part("month")) - 1] ?? ""} ${part("year")}`;
}

const YEAR_MS = 365 * 86_400_000;
export const REGULAR_FROM = 6;

/** The label alone: `completedAt` are the moments of her completed jobs, this one left out. */
export function labelOf(completedAt: Date[], now: Date): RatingLabel {
  if (completedAt.length === 0) return "first_time";
  const recent = completedAt.filter((at) => at.getTime() > now.getTime() - YEAR_MS).length;
  if (recent >= REGULAR_FROM) return "regular";
  return recent >= 1 ? "returning" : "old";
}

export function lineOf(label: RatingLabel, jobsInLastYear: number, lastJobLabel: string | null): string {
  if (label === "first_time" || lastJobLabel === null) return "No earlier jobs with us";
  if (label === "old") return `No jobs in the last 12 months - last job ${lastJobLabel}`;
  const jobs = `${String(jobsInLastYear)} job${jobsInLastYear === 1 ? "" : "s"}`;
  return `${jobs} in the last 12 months - last job ${lastJobLabel}`;
}

export async function customerRatingOf(
  client: PrismaClient,
  customerId: string,
  currentJobId: string,
  zone: string,
  now: Date = new Date(),
): Promise<CustomerRating> {
  // Her completed jobs but this one: a job's completion moment is its completed assignment's completedAt.
  const done = await client.assignment.findMany({
    where: { status: "completed", completedAt: { not: null }, job: { customerId, status: "completed", id: { not: currentJobId } } },
    select: { jobId: true, completedAt: true },
  });
  const latestByJob = new Map<string, Date>();
  for (const row of done) {
    if (row.completedAt === null) continue;
    const seen = latestByJob.get(row.jobId);
    if (seen === undefined || row.completedAt > seen) latestByJob.set(row.jobId, row.completedAt);
  }
  const moments = [...latestByJob.values()];
  const label = labelOf(moments, now);
  const jobsInLastYear = moments.filter((at) => at.getTime() > now.getTime() - YEAR_MS).length;
  const last = moments.reduce<Date | null>((best, at) => (best === null || at > best ? at : best), null);
  const lastJobLabel = last === null ? null : friendlyDate(zone, last);

  // The figures count every job of hers, this one included.
  const noShows = await client.job.findMany({
    where: { customerId, cancelReason: "customer_no_show" },
    select: { invoices: { select: { lines: { where: { kind: "callout" }, select: { id: true } } } } },
  });
  const waived = noShows.filter((job) => job.invoices.every((invoice) => invoice.lines.length === 0)).length;

  const lateCancellations = await client.job.count({
    where: {
      customerId,
      status: "cancelled",
      OR: [{ cancelReason: null }, { cancelReason: { not: "customer_no_show" } }],
      assignments: { some: { status: "cancelled", acceptedAt: { not: null } } },
    },
  });

  const noted = await client.job.findMany({ where: { customerId }, select: { operatorNotes: true } });
  const disputes = noted.filter((job) =>
    readNotes(job.operatorNotes).some((note) => note.type === "dispute" || note.type === "complaint"),
  ).length;

  const owed = await client.invoice.findMany({
    where: { customerId, status: "sent", isZeroDollar: false },
    select: { amount: true, dueAt: true },
  });
  const overdueInvoices = owed.filter((invoice) => dueStateOf(invoice.dueAt, zone, now).kind === "overdue").length;
  const totalDue = owed.reduce((sum, invoice) => sum + invoice.amount, 0);

  return {
    label,
    jobsInLastYear,
    lastJobLabel,
    line: lineOf(label, jobsInLastYear, lastJobLabel),
    missedVisits: noShows.length,
    waived,
    lateCancellations,
    disputes,
    overdueInvoices,
    totalDue,
  };
}
