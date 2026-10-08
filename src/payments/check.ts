// Check payment with Stripe -- Feature 6002, Stripe payment and receivables.
//
// Payments (Stripe): the backup for a webhook that never arrived. Mike asks Stripe
// directly: the invoice's link's checkout sessions are listed, and one complete and
// paid goes through the ONE paid step (paid.ts) exactly as the webhook's would --
// receipt and notice once, however often either arrives.
import type { PrismaClient } from "../db/client.js";
import { paymentReader } from "../invoices/stripe.js";
import { FAKE_LINK_READER, isFakePayLink } from "../test-data/fake-stripe.js";
import { recordConfirmedPayment } from "./paid.js";

export type CheckOutcome = "paid" | "not_paid" | "unreachable";

export async function checkPaymentWithStripe(
  client: PrismaClient,
  invoice: { id: string; stripePaymentLinkId: string | null },
): Promise<CheckOutcome> {
  if (invoice.stripePaymentLinkId === null) return "not_paid";
  const reader = isFakePayLink(invoice.stripePaymentLinkId) ? FAKE_LINK_READER : paymentReader();
  if (reader === null) return "unreachable";

  let intents: { paymentIntentId: string; amount: number; method: string | null; chargedAt: Date | null; invoiceId: string | null }[];
  try {
    const ids = await reader.paidPaymentIntentsOfLink(invoice.stripePaymentLinkId);
    intents = await Promise.all(ids.map((id) => reader.readPaymentIntent(id)));
  } catch (error: unknown) {
    console.error("Check payment: Stripe did not answer", error);
    return "unreachable";
  }

  let paid = false;
  for (const intent of intents) {
    const outcome = await recordConfirmedPayment(client, {
      // The link is this invoice's, whatever the intent's metadata says.
      invoiceId: invoice.id,
      paymentIntentId: intent.paymentIntentId,
      amount: intent.amount,
      method: intent.method,
      paidAt: intent.chargedAt ?? new Date(),
    });
    if (outcome === "paid" || outcome === "already_recorded") paid = true;
  }
  return paid ? "paid" : "not_paid";
}
