// The ONE paid step -- Feature 6002, Stripe payment and receivables.
//
// Payments (Stripe). However the platform learns of a confirmed payment -- Stripe's
// webhook, or Mike's Check payment with Stripe -- it lands here, and only here:
//
//   - the Payment is kept once per Stripe payment intent (unique), with how she paid;
//     a payment already kept as succeeded changes nothing more (no second receipt);
//   - an invoice still `sent` turns `paid`, and the reactions to Paid run: today the
//     customer's receipt and the office's payment notice;
//   - an invoice that is not `sent` (void) is left as it is, the money is still kept,
//     and the office is told: "Payment on a closed invoice".
//
// HOOKING ON. A later feature that reacts to Paid (the review request, Bob's
// awaiting-payment card) adds its reaction to PAID_REACTIONS below -- inside this
// one transaction -- and never writes a second copy of the step.
//
// One transaction, with the invoice row locked (FOR UPDATE), so the webhook and a
// Check payment arriving together are served one after the other.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { currentLabel } from "../test-data/label.js";
import { askClosedInvoiceNotice, askPaymentReceived, askPaymentReceipt } from "./messages.js";

type Tx = Prisma.TransactionClient;

/** A payment Stripe has confirmed. */
export interface ConfirmedPayment {
  invoiceId: string;
  paymentIntentId: string;
  /** Cents. */
  amount: number;
  /** Stripe's word: card, payto, ... */
  method: string | null;
  paidAt: Date;
}

export type PaidOutcome =
  /** The invoice turned paid now. */
  | "paid"
  /** This payment was already kept as succeeded: nothing happened. */
  | "already_recorded"
  /** The invoice is not open (void): the money is kept and the office told. */
  | "closed_invoice"
  /** No invoice has this id: nothing happened. */
  | "unknown_invoice";

/** What a reaction to Paid is handed, inside the step's transaction. */
export interface PaidContext {
  tx: Tx;
  invoiceId: string;
  paymentId: string;
}

/** Each reaction to an invoice turning Paid, run in order inside the paid step. Later features append. */
const PAID_REACTIONS: ((context: PaidContext) => Promise<void>)[] = [
  ({ tx, paymentId }) => askPaymentReceipt(tx, paymentId),
  ({ tx, paymentId }) => askPaymentReceived(tx, paymentId),
];

/** The paid step. Never throws for a repeat; throws only when the database does. */
export async function recordConfirmedPayment(client: PrismaClient, payment: ConfirmedPayment): Promise<PaidOutcome> {
  return client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Invoice" WHERE id = ${payment.invoiceId} FOR UPDATE`;
    if (locked.length === 0) return "unknown_invoice";
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: payment.invoiceId },
      select: { id: true, status: true, customerId: true, testData: true },
    });

    const existing = await tx.payment.findUnique({ where: { stripePaymentIntentId: payment.paymentIntentId } });
    if (existing?.status === "succeeded") return "already_recorded";

    const fields = {
      status: "succeeded" as const,
      amount: payment.amount,
      method: payment.method,
      paidAt: payment.paidAt,
    };
    // A payment on a labelled (test) invoice carries its label, also when Stripe's message
    // arrives outside any labelled request.
    const label = currentLabel() === null && invoice.testData !== null ? { testData: invoice.testData } : {};
    const kept =
      existing === null
        ? await tx.payment.create({
            data: { ...fields, ...label, invoiceId: invoice.id, customerId: invoice.customerId, stripePaymentIntentId: payment.paymentIntentId },
          })
        : await tx.payment.update({ where: { id: existing.id }, data: fields });

    if (invoice.status !== "sent") {
      await askClosedInvoiceNotice(tx, kept.id);
      return "closed_invoice";
    }

    await tx.invoice.update({ where: { id: invoice.id }, data: { status: "paid", paidAt: payment.paidAt } });
    for (const react of PAID_REACTIONS) {
      await react({ tx, invoiceId: invoice.id, paymentId: kept.id });
    }
    return "paid";
  });
}

/**
 * A later-settling payment that did not go through (PayTo declined). The invoice stays
 * `sent` with its link still offered; one failed Payment row is kept per payment intent;
 * nothing is sent. A payment already kept as succeeded is never turned failed.
 */
export async function recordFailedPayment(client: PrismaClient, payment: Omit<ConfirmedPayment, "paidAt">): Promise<void> {
  const invoice = await client.invoice.findUnique({ where: { id: payment.invoiceId }, select: { id: true, customerId: true, testData: true } });
  if (invoice === null) return;
  const existing = await client.payment.findUnique({ where: { stripePaymentIntentId: payment.paymentIntentId } });
  if (existing !== null) {
    if (existing.status !== "succeeded") {
      await client.payment.update({ where: { id: existing.id }, data: { status: "failed", method: payment.method } });
    }
    return;
  }
  const label = currentLabel() === null && invoice.testData !== null ? { testData: invoice.testData } : {};
  try {
    await client.payment.create({
      data: {
        ...label,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        stripePaymentIntentId: payment.paymentIntentId,
        amount: payment.amount,
        method: payment.method,
        status: "failed",
      },
    });
  } catch (error: unknown) {
    // The same event twice, at once: the other one kept the row.
    if ((error as { code?: unknown }).code !== "P2002") throw error;
  }
}
