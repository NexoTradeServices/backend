// The browser tests' pretend Stripe -- Feature 6001 (pay link), Feature 6002 (Check payment).
//
// A pay link made by the test-only route (routes.ts) is not Stripe's: its id starts
// `plink_test_`. Asking Stripe about it would fail (CI has no key; dev's sandbox does
// not know it), so outside production such a link is answered here -- no checkout
// session has paid it. In production the prefix means nothing and Stripe is asked.
import type { PaymentReader } from "../invoices/stripe.js";
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
