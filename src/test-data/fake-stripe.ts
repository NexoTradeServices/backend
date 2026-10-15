// The browser tests' pretend Stripe -- Feature 6001 (pay link), Feature 6002 (Check payment).
//
// A pay link made by the test-only route (routes.ts) is not Stripe's: its id starts
// `plink_test_`. Asking Stripe about it would fail (CI has no key; dev's sandbox does
// not know it), so outside production such a link is answered here -- no checkout
// session has paid it. In production the prefix means nothing and Stripe is asked.
import { RefundRefusedError, type PaymentReader, type RefundProvider } from "../invoices/stripe.js";
import { isProduction } from "./label.js";

export const FAKE_PAY_LINK_PREFIX = "plink_test_";

export function isFakePayLink(paymentLinkId: string | null): boolean {
  return !isProduction() && paymentLinkId !== null && paymentLinkId.startsWith(FAKE_PAY_LINK_PREFIX);
}

/** Nobody has paid a pretend link at Stripe. */
export const FAKE_LINK_READER: PaymentReader = {
  readPaymentIntent: (id) => Promise.reject(new Error(`pretend pay link: no payment intent ${id}`)),
  paidPaymentIntentsOfLink: () => Promise.resolve([]),
};

// ---------------------------------------------------------------------------
// Feature 6006 -- the pretend refund. A payment made by the test-only paid hook
// has the intent id `pi_test_<invoice reference>`; asking Stripe to refund it would
// fail, so outside production such an intent is answered here. An intent whose id
// carries `_refuse` is refused, so a browser test can see Stripe's "no".
// ---------------------------------------------------------------------------

export const FAKE_PAYMENT_INTENT_PREFIX = "pi_test_";

export function isFakePaymentIntent(paymentIntentId: string | null): boolean {
  return !isProduction() && paymentIntentId !== null && paymentIntentId.startsWith(FAKE_PAYMENT_INTENT_PREFIX);
}

let fakeRefunds = 0;

export const FAKE_REFUND_PROVIDER: RefundProvider = {
  createRefund(request) {
    if (request.paymentIntentId.includes("_refuse")) {
      return Promise.reject(new RefundRefusedError("The card was closed and the refund was declined"));
    }
    fakeRefunds += 1;
    return Promise.resolve({ id: `re_test_${request.idempotencyKey}_${String(fakeRefunds)}`, status: "succeeded" as const });
  },
};
