// The job page's Invoice card read -- Feature 6001, invoice at completion.
//
// Operations Admin Workflow / The job queue and the job page. Read from the
// invoice's FROZEN rows (lines, billed-to copy, GST stamp), never the live
// customer or the live GST switch. Money is whole cents, GST-inclusive.
import type { PrismaClient } from "../db/client.js";
import type { InvoiceStatus } from "../generated/prisma/enums.js";
import { formatLongDate } from "../agreements/pdf.js";
import type { BilledTo } from "./issue.js";
import { methodWords } from "../payments/messages.js";

export interface InvoiceLineView {
  kind: "labour" | "part" | "callout";
  description: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface InvoiceView {
  reference: string;
  status: InvoiceStatus;
  /** Sent, not zero-dollar, and Stripe has not answered yet. */
  waitingForPayLink: boolean;
  payLinkUrl: string | null;
  /** Resend invoice and Copy pay link are offered only when this is true. */
  canResend: boolean;
  /** Feature 6002: Check payment with Stripe is offered only when this is true (= canResend). */
  canCheckPayment: boolean;
  /** Feature 6002: "15 Oct 2026, card" once paid, from the succeeded Payment; null otherwise. */
  paidLabel: string | null;
  billedTo: { name: string; businessName: string | null; address: BilledTo["address"] | null };
  issuedLabel: string;
  dueLabel: string;
  lines: InvoiceLineView[];
  amount: number;
  gstApplied: boolean;
  gstAmount: number;
}

/** Sent, not zero-dollar, with its pay link: the only state Resend and the QR code work in. */
export function hasPayableLink(invoice: { status: InvoiceStatus; isZeroDollar: boolean; stripePaymentLinkUrl: string | null }): boolean {
  return invoice.status === "sent" && !invoice.isZeroDollar && invoice.stripePaymentLinkUrl !== null;
}

/** The job's invoice, or null until Complete has issued one. */
export async function invoiceViewOf(client: PrismaClient, jobId: string, zone: string): Promise<InvoiceView | null> {
  const invoice = await client.invoice.findFirst({
    where: { jobId },
    orderBy: { createdAt: "desc" },
    include: {
      lines: { orderBy: { id: "asc" } },
      payments: { where: { status: "succeeded" }, orderBy: { paidAt: "asc" }, take: 1 },
    },
  });
  if (invoice === null) return null;
  const billed = invoice.billedTo as unknown as BilledTo;
  const paidWith = invoice.payments[0];
  const paidAt = invoice.paidAt ?? paidWith?.paidAt ?? null;
  return {
    reference: invoice.reference,
    status: invoice.status,
    waitingForPayLink: invoice.status === "sent" && !invoice.isZeroDollar && invoice.stripePaymentLinkUrl === null,
    payLinkUrl: invoice.stripePaymentLinkUrl,
    canResend: hasPayableLink(invoice),
    canCheckPayment: hasPayableLink(invoice),
    paidLabel:
      invoice.status === "paid" && paidAt !== null
        ? `${formatLongDate(paidAt, zone)}, ${methodWords(paidWith?.method ?? null)}`
        : null,
    billedTo: { name: billed.name, businessName: billed.businessName ?? null, address: billed.address ?? null },
    issuedLabel: formatLongDate(invoice.sentAt ?? invoice.createdAt, zone),
    dueLabel: formatLongDate(invoice.dueAt, zone),
    lines: invoice.lines.map((line) => ({
      kind: line.kind,
      description: line.description,
      qty: Number(line.qty),
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    amount: invoice.amount,
    gstApplied: invoice.gstApplied,
    gstAmount: invoice.gstAmount ?? 0,
  };
}
