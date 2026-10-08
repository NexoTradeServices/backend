// The Stripe webhook -- Feature 6002, Stripe payment and receivables.
//
// Payments (Stripe): ONE door for every kind of Stripe message, at
// POST /webhooks/stripe. Mounted with a RAW body parser BEFORE the app's global
// express.json() (index.ts): Stripe signs the exact bytes it sent, and a parsed and
// re-serialised body no longer matches. Refunds (6006) join this same door.
//
//   - the signature is checked with STRIPE_WEBHOOK_SECRET; no secret or a bad
//     signature -> 400 and nothing changes;
//   - checkout.session.completed, paid, and checkout.session.async_payment_succeeded
//     -> the payment intent is read back -> the paid step (paid.ts);
//   - checkout.session.completed, unpaid (a later-settling method such as PayTo) ->
//     nothing yet: the money is not confirmed;
//   - checkout.session.async_payment_failed -> one failed Payment row, nothing sent;
//   - any other event type -> 200, ignored;
//   - a payment intent naming no invoice we hold -> 200, logged, nothing changes.
//
// Stripe repeats anything that is not a 2xx, so an event that is not ours is
// answered 200; a database failure is answered 500 so Stripe tries again.
import express, { type Request, type Response, type Router } from "express";
import Stripe from "stripe";
import { getPrisma, type PrismaClient } from "../db/client.js";
import { paymentReader, webhookSecret } from "../invoices/stripe.js";
import { recordConfirmedPayment, recordFailedPayment } from "./paid.js";

interface SessionLike {
  id: string;
  payment_status?: string;
  payment_intent?: string | { id: string } | null;
}

function intentIdOf(session: SessionLike): string | null {
  const value = session.payment_intent;
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.id;
}

type Handled = "paid" | "failed" | "ignored";

/** What one verified event means. Exported for the tests. */
export async function handleStripeEvent(client: PrismaClient, event: { type: string; created: number; data: { object: unknown } }): Promise<Handled> {
  const confirms =
    event.type === "checkout.session.async_payment_succeeded" ||
    (event.type === "checkout.session.completed" && (event.data.object as SessionLike).payment_status === "paid");
  const fails = event.type === "checkout.session.async_payment_failed";
  if (!confirms && !fails) return "ignored";

  const session = event.data.object as SessionLike;
  const intentId = intentIdOf(session);
  if (intentId === null) {
    console.warn(`stripe webhook: ${event.type} for session ${session.id} names no payment intent -- ignored`);
    return "ignored";
  }
  const reader = paymentReader();
  if (reader === null) {
    throw new Error("STRIPE_SECRET_KEY is not set -- the payment intent cannot be read back");
  }
  const intent = await reader.readPaymentIntent(intentId);
  if (intent.invoiceId === null) {
    console.warn(`stripe webhook: payment intent ${intentId} names no invoice -- ignored`);
    return "ignored";
  }

  if (fails) {
    await recordFailedPayment(client, { invoiceId: intent.invoiceId, paymentIntentId: intentId, amount: intent.amount, method: intent.method });
    return "failed";
  }
  const outcome = await recordConfirmedPayment(client, {
    invoiceId: intent.invoiceId,
    paymentIntentId: intentId,
    amount: intent.amount,
    method: intent.method,
    // When Stripe confirmed it: the event's own moment (a PayTo debit settles well after its charge began).
    paidAt: new Date(event.created * 1000),
  });
  if (outcome === "unknown_invoice") {
    console.warn(`stripe webhook: payment intent ${intentId} names invoice ${intent.invoiceId}, which we do not hold -- ignored`);
    return "ignored";
  }
  return "paid";
}

/** POST /webhooks/stripe, mounted by the API before its global JSON parser. */
export function stripeWebhook(client: PrismaClient = getPrisma()): Router {
  const router = express.Router();
  router.post("/", express.raw({ type: "*/*", limit: "1mb" }), (req: Request, res: Response) => {
    const secret = webhookSecret();
    const signature = req.headers["stripe-signature"];
    const body: unknown = req.body;
    if (secret === null || typeof signature !== "string" || !Buffer.isBuffer(body)) {
      res.status(400).json({ error: "not signed" });
      return;
    }
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(body, signature, secret);
    } catch {
      res.status(400).json({ error: "bad signature" });
      return;
    }
    handleStripeEvent(client, event)
      .then((handled) => res.json({ received: true, handled }))
      .catch((error: unknown) => {
        console.error(`stripe webhook ${event.type} failed -- Stripe will try again`, error);
        res.status(500).json({ error: "internal error" });
      });
  });
  return router;
}
