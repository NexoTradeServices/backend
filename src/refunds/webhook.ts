// Stripe's news about refunds -- Feature 6006, refunds.
//
// Payments (Stripe) / Refunds. Joins the ONE webhook door (payments/webhook.ts), after the
// signature has been checked. `refund.created` and `refund.updated`:
//
//   - a refund we hold: its status follows Stripe's. `succeeded` changes only the status.
//     `failed` (or `canceled`) sets it failed, asks the office's Refund failed notice (once, keyed
//     on the refund), and turns a `refunded` payment back to `succeeded` -- the amount is back in
//     what is left. A failed refund never changes again, so Stripe repeating itself changes nothing;
//   - a refund we do NOT hold, on a payment we do: if its metadata carries the key the refund
//     service sets, it is the platform's own refund and its row is not saved yet -- the answer is a
//     500, Stripe tries again and finds the row (our own refunds are never reported as dashboard
//     ones). Without the key it was made in the Stripe dashboard: nothing is booked, and Refund made
//     in Stripe goes to the office once per Stripe refund id;
//   - a refund on a payment we do not hold: nothing, logged.
import type { PrismaClient } from "../db/client.js";
import { REFUND_KEY_METADATA } from "../invoices/stripe.js";
import { askRefundFailed, askRefundMadeInStripe } from "./messages.js";

interface RefundLike {
  id: string;
  amount?: number;
  status?: string | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}

export type RefundHandled = "followed" | "reported" | "ignored";

export function isRefundEvent(type: string): boolean {
  return type === "refund.created" || type === "refund.updated";
}

function intentIdOf(refund: RefundLike): string | null {
  const value = refund.payment_intent;
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.id;
}

/** Stripe's refund status as ours: null while it is still on its way (nothing to follow). */
function followedStatus(status: string | null | undefined): "succeeded" | "failed" | null {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "canceled") return "failed";
  return null;
}

export async function handleRefundEvent(client: PrismaClient, event: { type: string; data: { object: unknown } }): Promise<RefundHandled> {
  const refund = event.data.object as RefundLike;
  const held = await client.refund.findFirst({ where: { stripeRefundId: refund.id }, select: { id: true, status: true, paymentId: true } });

  if (held !== null) {
    const next = followedStatus(refund.status);
    if (next === null || held.status === next || held.status === "failed") return "ignored";
    await client.$transaction(async (tx) => {
      const changed = await tx.refund.updateMany({
        where: { id: held.id, status: { notIn: ["failed", next] } },
        data: { status: next },
      });
      if (changed.count === 0 || next !== "failed") return;
      if (held.paymentId !== null) {
        await tx.payment.updateMany({ where: { id: held.paymentId, status: "refunded" }, data: { status: "succeeded" } });
      }
      await askRefundFailed(tx, held.id);
    });
    return "followed";
  }

  const intentId = intentIdOf(refund);
  const payment = intentId === null ? null : await client.payment.findUnique({ where: { stripePaymentIntentId: intentId }, select: { id: true } });
  if (payment === null) {
    console.warn(`stripe webhook: refund ${refund.id} is on a payment we do not hold -- ignored`);
    return "ignored";
  }
  const ownKey = refund.metadata?.[REFUND_KEY_METADATA];
  if (typeof ownKey === "string" && ownKey !== "") {
    throw new Error(`refund ${refund.id} is the platform's own and is not saved yet -- Stripe will try again`);
  }
  if (followedStatus(refund.status) === "failed") return "ignored";
  // Once per Stripe refund id: asked before, nothing more (a duplicate key inside a transaction
  // would abort it, so the guard is a read first).
  const asked = await client.notification.findUnique({
    where: { idempotencyKey: `refund_made_in_stripe:payment:${refund.id}:email` },
    select: { id: true },
  });
  if (asked !== null) return "ignored";
  await client.$transaction(async (tx) => {
    await askRefundMadeInStripe(tx, { paymentId: payment.id, stripeRefundId: refund.id, amount: refund.amount ?? 0 });
  });
  return "reported";
}
