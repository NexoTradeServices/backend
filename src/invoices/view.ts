// The job page's Invoice card read -- Feature 6001, invoice at completion.
//
// Operations Admin Workflow / The job queue and the job page. Read from the
// invoice's FROZEN rows (lines, billed-to copy, GST stamp), never the live
// customer or the live GST switch. Money is whole cents, GST-inclusive.
import type { PrismaClient } from "../db/client.js";
import type { InvoiceStatus } from "../generated/prisma/enums.js";
import { formatDate, formatShortDateTime } from "../time/index.js";
import type { BilledTo } from "./issue.js";
import { methodWords } from "../payments/messages.js";
import { leftByPayment, totalLeft } from "../refunds/service.js";
import type { RefundStatus } from "../generated/prisma/enums.js";

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
  /** Feature 6008: Void invoice is offered only when this is true (sent and not zero-dollar, with or without a pay link). */
  canVoid: boolean;
  /** Feature 6008: who voided it, when and why; null unless void. */
  voided: { byName: string; atLabel: string; reason: string } | null;
  /** Feature 6002: "15 Oct 2026, card" once paid, from the succeeded Payment; null otherwise. */
  paidLabel: string | null;
  /** Feature 6006: Refund is offered only when this is true (money received and not all given back). */
  canRefund: boolean;
  /** Feature 6006: cents received and not yet refunded; 0 when nothing is left. */
  refundableLeft: number;
  /** Feature 6006: every refund on the invoice, oldest first. */
  refunds: { reference: string; dateLabel: string; amount: number; status: RefundStatus }[];
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
      voidedBy: { select: { name: true } },
      refunds: { orderBy: [{ approvedAt: "asc" }, { id: "asc" }] },
    },
  });
  if (invoice === null) return null;
  const refundableLeft = totalLeft(await leftByPayment(client, invoice.id));
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
    canVoid: invoice.status === "sent" && !invoice.isZeroDollar,
    voided:
      invoice.status === "void"
        ? {
            byName: invoice.voidedBy?.name ?? "Unknown",
            atLabel: invoice.voidedAt === null ? "" : formatShortDateTime(zone, invoice.voidedAt),
            reason: invoice.voidReason ?? "",
          }
        : null,
    paidLabel:
      invoice.status === "paid" && paidAt !== null
        ? `${formatDate(zone, paidAt)}, ${methodWords(paidWith?.method ?? null)}`
        : null,
    canRefund: refundableLeft > 0,
    refundableLeft,
    refunds: invoice.refunds.map((refund) => ({
      reference: refund.reference,
      dateLabel: formatDate(zone, refund.approvedAt),
      amount: refund.amount,
      status: refund.status,
    })),
    billedTo: { name: billed.name, businessName: billed.businessName ?? null, address: billed.address ?? null },
    issuedLabel: formatDate(zone, invoice.sentAt ?? invoice.createdAt),
    dueLabel: formatDate(zone, invoice.dueAt),
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
