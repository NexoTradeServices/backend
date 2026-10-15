// The Refunds list's read -- Feature 6006, refunds.
//
// Refunds. Every refund, newest first, 50 a page with page numbers (frontend-conventions,
// Molecules / Paging a list): the page asked for, the total, and "Showing 51 to 100 of 120"'s
// numbers. A page past the end answers the last page. Derived on the spot; nothing is stored.
import type { PrismaClient } from "../db/client.js";
import type { RefundStatus } from "../generated/prisma/enums.js";
import { formatDate } from "../time/index.js";

export const REFUNDS_PAGE = 50;

export interface RefundRow {
  reference: string;
  dateLabel: string;
  customerName: string;
  jobReference: string;
  invoiceReference: string;
  /** Cents. */
  amount: number;
  status: RefundStatus;
  madeBy: string;
}

export interface RefundsResult {
  rows: RefundRow[];
  total: number;
  page: number;
  pageCount: number;
  /** 1-based position of the first and last row shown; 0 and 0 when there are none. */
  from: number;
  to: number;
}

export async function listRefunds(client: PrismaClient, zone: string, requestedPage: number): Promise<RefundsResult> {
  const total = await client.refund.count();
  const pageCount = Math.max(1, Math.ceil(total / REFUNDS_PAGE));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const found = await client.refund.findMany({
    orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * REFUNDS_PAGE,
    take: REFUNDS_PAGE,
    include: {
      customer: { select: { name: true } },
      job: { select: { reference: true } },
      invoice: { select: { reference: true } },
      approvedBy: { select: { name: true } },
    },
  });
  const from = found.length === 0 ? 0 : (page - 1) * REFUNDS_PAGE + 1;
  return {
    rows: found.map((refund) => ({
      reference: refund.reference,
      dateLabel: formatDate(zone, refund.approvedAt),
      customerName: refund.customer.name,
      jobReference: refund.job.reference,
      invoiceReference: refund.invoice.reference,
      amount: refund.amount,
      status: refund.status,
      madeBy: refund.approvedBy.name,
    })),
    total,
    page,
    pageCount,
    from,
    to: found.length === 0 ? 0 : from + found.length - 1,
  };
}
