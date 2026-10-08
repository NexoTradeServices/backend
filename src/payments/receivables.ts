// The Receivables page's read -- Feature 6002, Stripe payment and receivables.
//
// Invoicing / Invoice lifecycle - due, overdue, reminders. Every invoice still owed
// (sent, not zero-dollar), most overdue first, then by due date -- which is simply
// the earliest due date first -- 50 at a time behind a cursor. Overdue is DERIVED
// from dueAt against the business clock (PlatformSettings.timezone), never stored.
// A paid or void invoice is not owed, so it leaves the list by itself.
import type { PrismaClient } from "../db/client.js";
import { formatLongDate } from "../agreements/pdf.js";
import { todayIn } from "../time/index.js";
import type { BilledTo } from "../invoices/issue.js";

export const RECEIVABLES_PAGE = 50;

export interface DueState {
  kind: "overdue" | "today" | "later";
  /** "3 days overdue", "Due today", "Due in 4 days". */
  label: string;
}

export interface ReceivableRow {
  invoiceReference: string;
  jobReference: string;
  billedTo: { name: string; businessName: string | null };
  phone: string | null;
  /** Cents, GST-inclusive. */
  amount: number;
  dueLabel: string;
  due: DueState;
  waitingForPayLink: boolean;
}

export interface ReceivablesResult {
  count: number;
  /** Cents. */
  total: number;
  rows: ReceivableRow[];
  /** Pass back as ?after= for the next 50; null when there are no more. */
  nextCursor: string | null;
}

/** Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** Where an invoice due at `dueAt` stands today, on `zone`'s calendar. */
export function dueStateOf(dueAt: Date, zone: string, now: Date = new Date()): DueState {
  const days = daysBetween(todayIn(zone, now), todayIn(zone, dueAt));
  if (days === 0) return { kind: "today", label: "Due today" };
  if (days < 0) return { kind: "overdue", label: `${plural(-days, "day")} overdue` };
  return { kind: "later", label: `Due in ${plural(days, "day")}` };
}

interface Cursor {
  dueAt: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** A cursor this read made, or null for anything else (a stale or hand-typed one starts from the top). */
export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.dueAt !== "string" || typeof parsed.id !== "string" || Number.isNaN(Date.parse(parsed.dueAt))) return null;
    return { dueAt: parsed.dueAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function listReceivables(
  client: PrismaClient,
  zone: string,
  options: { after?: Cursor | null; limit?: number; now?: Date } = {},
): Promise<ReceivablesResult> {
  const owed = { status: "sent" as const, isZeroDollar: false };
  const limit = options.limit ?? RECEIVABLES_PAGE;
  const after = options.after ?? null;
  const afterDue = after === null ? null : new Date(after.dueAt);
  const [summary, invoices] = await Promise.all([
    client.invoice.aggregate({ where: owed, _count: { _all: true }, _sum: { amount: true } }),
    client.invoice.findMany({
      where: {
        ...owed,
        ...(after === null || afterDue === null
          ? {}
          : { OR: [{ dueAt: { gt: afterDue } }, { dueAt: afterDue, id: { gt: after.id } }] }),
      },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      include: { job: { select: { reference: true } }, customer: { select: { phone: true } } },
    }),
  ]);
  const page = invoices.slice(0, limit);
  const last = page[page.length - 1];
  const now = options.now ?? new Date();
  return {
    count: summary._count._all,
    total: summary._sum.amount ?? 0,
    rows: page.map((invoice) => {
      const billed = invoice.billedTo as unknown as BilledTo;
      return {
        invoiceReference: invoice.reference,
        jobReference: invoice.job.reference,
        billedTo: { name: billed.name, businessName: billed.businessName ?? null },
        phone: invoice.customer.phone,
        amount: invoice.amount,
        dueLabel: formatLongDate(invoice.dueAt, zone),
        due: dueStateOf(invoice.dueAt, zone, now),
        waitingForPayLink: invoice.stripePaymentLinkUrl === null,
      };
    }),
    nextCursor: invoices.length > limit && last !== undefined ? encodeCursor({ dueAt: last.dueAt.toISOString(), id: last.id }) : null,
  };
}
