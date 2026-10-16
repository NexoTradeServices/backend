// The refund service -- Feature 6006, refunds.
//
// Refunds. ONE function makes a refund, `makeRefund`, and 6007 (Correct and reissue)
// calls the same one for its paid branch:
//
//   - what is left = succeeded payments on the invoice minus its refunds that are not
//     failed. Nothing left, an amount not above 0, more than is left, or a blank
//     reason -> refused, and Stripe is never asked;
//   - the payment with the most left on it takes the refund; more than that one payment
//     can give -> refused, naming the most it can (a two-payment invoice is refunded as
//     two refunds);
//   - Stripe is asked FIRST. A no, or no answer, saves nothing and uses no CN number;
//   - on Stripe's yes, in one transaction: the Refund row with its new CN reference and
//     the approver pair, the payment turned `refunded` when it has been given back in
//     full, and the Refund issued email asked for.
//
// The invoice row is locked (FOR UPDATE) for the whole call, so two refunds made at the
// same moment are served one after the other and can never give back more than was paid.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../db/client.js";
import { nextReference } from "../db/reference.js";
import type { Prisma } from "../generated/prisma/client.js";
import { currentLabel } from "../test-data/label.js";
import { FAKE_REFUND_PROVIDER, isFakePaymentIntent } from "../test-data/fake-stripe.js";
import { billedToOf } from "../invoices/issue.js";
import { RefundRefusedError, refundProvider, type RefundProvider } from "../invoices/stripe.js";
import { askRefundIssued } from "./messages.js";
import { dollars } from "./money.js";

export const REFUND_REASON_MAX = 500;

export const REFUND_AMOUNT_ERROR = "Enter an amount more than $0.";
export const REFUND_REASON_ERROR = "Give a reason for the refund.";

export type RefundOutcome =
  | { ok: true; refundId: string; reference: string; status: "pending" | "succeeded" }
  | {
      ok: false;
      /** Which field or kind of refusal; `stripe` means Stripe said no (or was not reached). */
      kind: "amount" | "reason" | "too_much" | "nothing_left" | "one_payment" | "stripe" | "not_set_up" | "not_found";
      message: string;
      /** Cents: what is left, or the most one payment can take, when that is the point. */
      left?: number;
    };

/** The reason, trimmed, or the field error. */
export function parseRefundReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason === "" || reason.length > REFUND_REASON_MAX) return { ok: false, error: REFUND_REASON_ERROR };
  return { ok: true, reason };
}

/** Per payment: what it took, what has been given back (every refund that is not failed). */
export interface PaymentLeft {
  paymentId: string;
  paymentIntentId: string;
  amount: number;
  refunded: number;
  left: number;
}

type Reader = Pick<Prisma.TransactionClient, "payment">;

/** The succeeded payments of an invoice with what is left on each; most left first. */
export async function leftByPayment(db: Reader, invoiceId: string): Promise<PaymentLeft[]> {
  const payments = await db.payment.findMany({
    where: { invoiceId, status: { in: ["succeeded", "refunded"] } },
    include: { refunds: { where: { status: { not: "failed" } }, select: { amount: true } } },
    orderBy: [{ paidAt: "asc" }, { id: "asc" }],
  });
  return payments
    .map((payment) => {
      const refunded = payment.refunds.reduce((sum, refund) => sum + refund.amount, 0);
      return {
        paymentId: payment.id,
        paymentIntentId: payment.stripePaymentIntentId,
        amount: payment.amount,
        refunded,
        left: Math.max(0, payment.amount - refunded),
      };
    })
    .sort((a, b) => b.left - a.left);
}

/** Cents of money received and not yet given back, over every payment of the invoice. */
export function totalLeft(payments: PaymentLeft[]): number {
  return payments.reduce((sum, payment) => sum + payment.left, 0);
}

function providerFor(paymentIntentId: string): RefundProvider | null {
  return isFakePaymentIntent(paymentIntentId) ? FAKE_REFUND_PROVIDER : refundProvider();
}

export async function makeRefund(
  client: PrismaClient,
  input: { invoiceId: string; amount: number; reason: string; byUserId: string; now?: Date },
): Promise<RefundOutcome> {
  const now = input.now ?? new Date();
  const reason = parseRefundReason(input.reason);
  if (!reason.ok) return { ok: false, kind: "reason", message: reason.error };
  if (!Number.isInteger(input.amount) || input.amount <= 0) return { ok: false, kind: "amount", message: REFUND_AMOUNT_ERROR };

  return client.$transaction(
    async (tx): Promise<RefundOutcome> => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Invoice" WHERE id = ${input.invoiceId} FOR UPDATE`;
      if (locked.length === 0) return { ok: false, kind: "not_found", message: "not found" };
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: input.invoiceId },
        select: { id: true, customerId: true, jobId: true, testData: true, customer: true },
      });

      const payments = await leftByPayment(tx, invoice.id);
      const left = totalLeft(payments);
      if (left <= 0) return { ok: false, kind: "nothing_left", message: "There is nothing left to refund on this invoice.", left: 0 };
      if (input.amount > left) {
        return { ok: false, kind: "too_much", message: `That is more than is left to refund (${dollars(left)}).`, left };
      }
      const payment = payments[0];
      if (payment === undefined || input.amount > payment.left) {
        const most = payment?.left ?? 0;
        return {
          ok: false,
          kind: "one_payment",
          message: `One payment can give back at most ${dollars(most)}. Refund that, then refund the rest.`,
          left: most,
        };
      }

      const provider = providerFor(payment.paymentIntentId);
      if (provider === null) {
        return { ok: false, kind: "not_set_up", message: "Stripe is not set up on this server - nothing was changed." };
      }
      const refundKey = `refund-${invoice.id}-${randomUUID()}`;
      let stripeRefund;
      try {
        stripeRefund = await provider.createRefund({
          paymentIntentId: payment.paymentIntentId,
          amount: input.amount,
          idempotencyKey: refundKey,
          invoiceId: invoice.id,
        });
      } catch (error: unknown) {
        const why = error instanceof RefundRefusedError ? error.reason : "Stripe could not be reached";
        return { ok: false, kind: "stripe", message: `Stripe did not make the refund: ${why}. Nothing was changed.` };
      }

      // A refund on a labelled (test) invoice carries its label, also outside any labelled request.
      const label = currentLabel() === null && invoice.testData !== null ? { testData: invoice.testData } : {};
      const reference = await nextReference("CN", tx);
      const refund = await tx.refund.create({
        data: {
          ...label,
          reference,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          jobId: invoice.jobId,
          paymentId: payment.paymentId,
          amount: input.amount,
          reason: reason.reason,
          approvedByUserId: input.byUserId,
          approvedAt: now,
          // The customer's details as they are NOW, frozen on the receipt (Feature 6015).
          billedTo: billedToOf(invoice.customer) as unknown as Prisma.InputJsonObject,
          stripeRefundId: stripeRefund.id,
          status: stripeRefund.status,
        },
      });
      if (input.amount >= payment.left) {
        // Given back in full: this payment, with everything refunded before, is all returned.
        await tx.payment.update({ where: { id: payment.paymentId }, data: { status: "refunded" } });
      }
      await askRefundIssued(tx, refund.id);
      return { ok: true, refundId: refund.id, reference, status: stripeRefund.status };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
